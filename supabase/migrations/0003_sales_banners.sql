-- Migration 0003: sales_banners table — admin-editable rolling marquee banner
-- with active toggle + date-window scheduling. Only ONE row ever active at a time.

CREATE TABLE IF NOT EXISTS public.sales_banners (
  id BIGSERIAL PRIMARY KEY,
  message TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  start_at TIMESTAMPTZ,
  end_at   TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce that at most 1 row can be is_active=TRUE at any time (same pattern as weekly_limits).
CREATE UNIQUE INDEX IF NOT EXISTS sales_banners_one_active
  ON public.sales_banners ((is_active IS TRUE))
  WHERE is_active IS TRUE;

-- Default seed banner matching the original storefront hardcoded text,
-- with no time window (start_at/end_at NULL = always show when active).
INSERT INTO public.sales_banners (id, message, is_active, start_at, end_at)
VALUES (
  1,
  '🎉 OPENING SALE: 10% OFF all brownies! 🎉  Use code BAKEDBYGAINS10 when you order — mention it in notes or on WhatsApp to redeem. Limited time only!     ',
  TRUE,
  NULL,
  NULL
)
ON CONFLICT (id) DO UPDATE SET
  message   = EXCLUDED.message,
  is_active = EXCLUDED.is_active,
  start_at  = EXCLUDED.start_at,
  end_at    = EXCLUDED.end_at,
  updated_at = NOW();

-- Reset sequence so the next manual INSERT (if admin ever adds row 2+) picks id=2+.
SELECT setval(pg_get_serial_sequence('public.sales_banners','id'), GREATEST(1, (SELECT MAX(id) FROM public.sales_banners)));

-- RLS: anon role can SELECT the active banner row only.
ALTER TABLE public.sales_banners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sales_banners_anon_select ON public.sales_banners;
CREATE POLICY sales_banners_anon_select ON public.sales_banners
  FOR SELECT
  USING (is_active IS TRUE);

-- Note: admin writes go through service role (bypasses RLS) from /admin-backend.
