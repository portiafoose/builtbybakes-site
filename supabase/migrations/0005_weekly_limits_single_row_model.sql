-- -----------------------------------------------------------------
-- 0005_weekly_limits_single_row_model.sql
--
-- Per Portia: weekly_limits no longer needs week_label / is_active /
-- created_at / updated_at as user-visible concepts. We want a simple
-- two-column model: {max_brownies, sold_brownies} stored in a SINGLE
-- canonical row (id = 1 always). max_brownies persists week-over-week
-- unchanged until Portia edits it. sold_brownies increments on each
-- order via increment_weekly_sold(), and Portia resets it to 0 every
-- Thursday for the next Friday drop.
-- -----------------------------------------------------------------

-- Step 1. The partial unique index `weekly_limits_one_active` was the
-- root cause of admin edits failing: if the row had is_active=FALSE
-- for any reason, admin .eq('is_active', true) returned 0 rows and
-- the edit card never rendered. We now use a fixed single-row model
-- so the index is dead weight.
DROP INDEX IF EXISTS public.weekly_limits_one_active;

-- Step 2. Ensure a canonical id=1 row ALWAYS exists. If the table
-- already has a row with id!=1 we keep its values and also write an
-- id=1 row with the same max/sold so admin never sees "no row".
INSERT INTO public.weekly_limits (id, week_label, max_brownies, sold_brownies, is_active, created_at, updated_at)
SELECT
  1,
  COALESCE((SELECT week_label FROM public.weekly_limits ORDER BY id ASC LIMIT 1), 'Default'),
  COALESCE((SELECT max_brownies FROM public.weekly_limits ORDER BY id ASC LIMIT 1), 100),
  COALESCE((SELECT sold_brownies FROM public.weekly_limits ORDER BY id ASC LIMIT 1), 0),
  TRUE,
  NOW(),
  NOW()
ON CONFLICT (id) DO NOTHING;

-- Step 3. Rewrite increment_weekly_sold() to target the FIRST row by
-- id ASC (always id=1 after the upsert above), ignoring is_active.
-- This guarantees orders still enforce capacity even if some legacy
-- row has is_active=FALSE from earlier bugs.
CREATE OR REPLACE FUNCTION public.increment_weekly_sold(p_add INT)
RETURNS TABLE (new_sold INT, max_cap INT, ok BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_new INT;
BEGIN
  SELECT * INTO r
  FROM public.weekly_limits
  ORDER BY id ASC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    -- No row at all (shouldn't happen after upsert step 2, fail-safe).
    INSERT INTO public.weekly_limits (id, week_label, max_brownies, sold_brownies, is_active)
    VALUES (1, 'Default', GREATEST(p_add, 100), 0, TRUE);
    RETURN QUERY SELECT 0, GREATEST(p_add, 100), FALSE;
    RETURN;
  END IF;

  v_new := r.sold_brownies + p_add;
  IF v_new > r.max_brownies THEN
    -- Over cap; do not update, return ok=false so frontend shows error.
    RETURN QUERY SELECT r.sold_brownies, r.max_brownies, FALSE;
    RETURN;
  END IF;

  UPDATE public.weekly_limits
  SET sold_brownies = v_new,
      updated_at    = NOW()
  WHERE id = r.id;

  RETURN QUERY SELECT v_new, r.max_brownies, TRUE;
END;
$$;

-- Step 4. Drop unused / legacy RLS policy names (keep anon SELECT any
-- row — capacity number is public display info anyway, same as banner
-- text.)
DROP POLICY IF EXISTS weekly_limits_anon_select ON public.weekly_limits;
CREATE POLICY weekly_limits_anon_select ON public.weekly_limits
  FOR SELECT USING (true);
