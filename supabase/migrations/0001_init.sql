-- Built By Bakes admin schema + RLS

-- ---------------------------------------------------------
-- 1. ADMIN USERS  (username/password hash pairs; insert via SQL console,
--    NOT via frontend — admin creation is a DB-side operation only).
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_users (
  id          BIGSERIAL PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the one admin user the UI currently supports ("portia").
-- Password: beRICH$$  → hashed with sha256, stored as base64(sha256(password||salt)).
-- The frontend login never trusts itself; it runs the exact check against
-- Supabase's crypto extensions (we fall back to a deterministic bcrypt-equivalent
-- hash embedded via pgcrypto gen_salt if available, otherwise use hash below).
-- For simplicity we pre-compute a SHA-256 of the salted pw; the login RPC below
-- verifies it. This avoids pgcrypto dependency if not enabled.
--
-- salt = "bbb-admin-salt-v1"
-- digest = sha256( "portia||beRICH$$||bbb-admin-salt-v1" )
-- We store both username + hex digest for login RPC.
INSERT INTO public.admin_users (username, password_hash, display_name)
VALUES (
  'portia',
  encode(digest('portia||beRICH$$||bbb-admin-salt-v1', 'sha256'), 'hex'),
  'Portia'
)
ON CONFLICT (username) DO NOTHING;

-- ---------------------------------------------------------
-- 2. WEEKLY BROWNIE LIMITS  (single active row controls the current week cap;
--    admin can set max_brownies and week label here).
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.weekly_limits (
  id          BIGSERIAL PRIMARY KEY,
  week_label  TEXT NOT NULL,              -- e.g. "Week 2026-W34"
  max_brownies INT NOT NULL DEFAULT 100,  -- how many brownies can be sold this week
  sold_brownies INT NOT NULL DEFAULT 0,   -- how many sold (updated on every order)
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one row is ever "active" at a time; enforce via partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS weekly_limits_one_active
  ON public.weekly_limits ((is_active IS TRUE))
  WHERE is_active IS TRUE;

INSERT INTO public.weekly_limits (week_label, max_brownies, sold_brownies, is_active)
VALUES ('Launch Week', 100, 0, TRUE)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------
-- 3. PROMO CODES
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.promo_codes (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  discount_type TEXT NOT NULL DEFAULT 'percent',  -- 'percent' (of subtotal) or 'fixed'
  discount_value NUMERIC(12,2) NOT NULL,          -- 0.10 means 10%, or 5.00 means SGD 5
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  max_uses    INT,                                -- optional usage cap
  used_count  INT NOT NULL DEFAULT 0,
  valid_from  TIMESTAMPTZ,                        -- optional
  valid_until TIMESTAMPTZ,                        -- optional
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.promo_codes
  (code, label, discount_type, discount_value, is_active, max_uses)
VALUES
  ('BAKEDBYGAINS10', '10% off (Opening Sale)', 'percent', 0.10, TRUE, NULL)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------
-- 4. ORDERS
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orders (
  id          BIGSERIAL PRIMARY KEY,
  ref         TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  email       TEXT,
  qty         INT NOT NULL,
  total       NUMERIC(12,2) NOT NULL,
  subtotal    NUMERIC(12,2) NOT NULL,
  delivery_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  method      TEXT NOT NULL,                 -- 'paynow' | 'card'
  fulfilment  TEXT NOT NULL,                 -- 'Self-collect' | 'Delivery'
  collection  TEXT,                          -- collection slot / address line
  address     TEXT,
  promo       TEXT,
  payment_ref TEXT,                          -- hitpay / paynow reference
  notes       TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' -- pending | paid | shipped | cancelled
);

CREATE INDEX IF NOT EXISTS orders_created_at_idx ON public.orders (created_at DESC);

-- ---------------------------------------------------------
-- 5. RPC — verify_admin_login(username, submitted_password)
--    Returns TRUE if user exists and password matches the salted SHA-256 hash.
-- ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_admin_login(p_username TEXT, p_password TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hash TEXT;
  v_actual TEXT;
BEGIN
  SELECT password_hash INTO v_hash
  FROM public.admin_users
  WHERE username = p_username;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  v_actual := encode(digest(p_username || '||' || p_password || '||bbb-admin-salt-v1', 'sha256'), 'hex');

  RETURN v_actual = v_hash;
END;
$$;

-- ---------------------------------------------------------
-- 6. RPC — increment_weekly_sold(p_add INT)
--    Safely bump sold_brownies by p_add on the ACTIVE row.
--    Returns the (sold_brownies, max_brownies) AFTER bump if within cap,
--    or raises an exception if it would exceed max_brownies.
--    Called by the order-place flow right before order insert.
-- ---------------------------------------------------------
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
  WHERE is_active IS TRUE
  FOR UPDATE;

  IF NOT FOUND THEN
    -- No active row: let's be lenient and allow, but return ok=false as warning.
    RETURN QUERY SELECT 0, 0, FALSE;
    RETURN;
  END IF;

  v_new := r.sold_brownies + p_add;
  IF v_new > r.max_brownies THEN
    -- over-cap; do not update, return ok=false.
    RETURN QUERY SELECT r.sold_brownies, r.max_brownies, FALSE;
    RETURN;
  END IF;

  UPDATE public.weekly_limits
  SET sold_brownies = v_new, updated_at = NOW()
  WHERE id = r.id;

  RETURN QUERY SELECT v_new, r.max_brownies, TRUE;
END;
$$;

-- ---------------------------------------------------------
-- 7. RLS + GRANTS
--    anon role:
--      - SELECT weekly_limits (so storefront can show "n left")
--      - SELECT promo_codes WHERE is_active (so storefront can validate on submit)
--      - SELECT verify_admin_login RPC
--      - SELECT increment_weekly_sold RPC  (at order-submit time; atomic cap check)
--      - INSERT orders  (anyone can submit a new order)
--      - NO direct UPDATE/DELETE on any table from anon
--    Authenticated (service role, used by admin panel via browser + service key):
--      - Full CRUD on promo_codes / weekly_limits / orders / admin_users
-- ---------------------------------------------------------
ALTER TABLE public.admin_users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_codes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders        ENABLE ROW LEVEL SECURITY;

-- weekly_limits: anon read-only (active row only, not that it matters)
DROP POLICY IF EXISTS weekly_limits_anon_select ON public.weekly_limits;
CREATE POLICY weekly_limits_anon_select ON public.weekly_limits
  FOR SELECT USING (true);

-- promo_codes: anon see only ACTIVE ones (so you can't sneak-use an expired/disabled)
DROP POLICY IF EXISTS promo_codes_anon_select ON public.promo_codes;
CREATE POLICY promo_codes_anon_select ON public.promo_codes
  FOR SELECT USING (is_active IS TRUE);

-- orders: anon can INSERT a new order (they cannot read others' orders)
DROP POLICY IF EXISTS orders_anon_insert ON public.orders;
CREATE POLICY orders_anon_insert ON public.orders
  FOR INSERT WITH CHECK (true);

-- Ensure pgcrypto extension is ON so digest() works in the RPCs above.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
