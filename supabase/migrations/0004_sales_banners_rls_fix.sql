-- Migration 0004: fix sales_banners RLS so anon can read the SINGLE existing row
-- regardless of is_active flag. This lets the storefront distinguish between
-- (a) "admin explicitly set is_active=FALSE" → don't show, don't fallback, and
-- (b) transient SQL/network error → fall back to hardcoded default banner.
--
-- Banner message content is PUBLIC (it's literally displayed on the homepage
-- when active) so there is no secrecy concern with anon reading it even while
-- deactivated during drafting.

DROP POLICY IF EXISTS sales_banners_anon_select ON public.sales_banners;

CREATE POLICY sales_banners_anon_select ON public.sales_banners
  FOR SELECT
  USING (TRUE);
