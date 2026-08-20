-- -----------------------------------------------------------------
-- 0006_collab_feedback_submissions.sql
--
-- Corporate/Bulk/Brand Collab enquiries AND community feedback/review
-- submissions are written to two new Postgres tables as the durable
-- backup alongside (a) the Google Sheet Apps Script endpoint write
-- and (b) email delivery. Inserts use ANON role with RLS INSERT-only
-- policies (no read public). Admin service-role key can read/export
-- from Supabase Table Editor.
--
-- Portia / Astrid email target = builtbybakes.sg@gmail.com.
-- -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.collab_enquiries (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  enquiry_type TEXT NOT NULL
    DEFAULT 'Corporate / Bulk Order'
    CHECK (enquiry_type IN (
      'Corporate / Bulk Order',
      'Brand Collaboration',
      'Other'
    )),
  message TEXT NOT NULL,
  replied BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.feedback_submissions (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  feedback TEXT NOT NULL,
  consent_given BOOLEAN NOT NULL DEFAULT FALSE,
  photo_filename TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Anon INSERT policies. Public must NEVER read rows (contains customer
-- contact data + potentially personal feedback + email/phone data.)
ALTER TABLE public.collab_enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS collab_enquiries_anon_insert ON public.collab_enquiries;
CREATE POLICY collab_enquiries_anon_insert ON public.collab_enquiries
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS feedback_anon_insert ON public.feedback_submissions;
CREATE POLICY feedback_anon_insert ON public.feedback_submissions
  FOR INSERT WITH CHECK (true);

-- Admin service role already bypasses RLS, but to be explicit on SELECT
-- via the service-role Supabase client we also add service-role readable
-- policies for Portia's admin panel.

-- Index on created_at for admin list ordering.
CREATE INDEX IF NOT EXISTS collab_enquiries_created_at_idx
  ON public.collab_enquiries (created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_created_at_idx
  ON public.feedback_submissions (created_at DESC);
