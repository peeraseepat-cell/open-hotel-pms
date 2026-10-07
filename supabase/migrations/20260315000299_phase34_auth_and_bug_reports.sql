-- Phase 34: Auth permissions + Bug Reports

-- 1) Add allowed_pages to profiles table
--    '*' = access all pages (admin default)
--    Array of route prefixes e.g. ARRAY['/pms/board','/pms/arrivals']
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS allowed_pages text[] DEFAULT ARRAY['*']::text[];

-- Default existing admin/supervisor rows to '*' (already the column default, but explicit)
UPDATE public.profiles
SET allowed_pages = ARRAY['*']::text[]
WHERE allowed_pages IS NULL
   OR allowed_pages = '{}';

-- 2) Bug Reports table
CREATE TABLE IF NOT EXISTS public.bug_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reported_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reporter_email  text,
  page_url        text NOT NULL,
  description     text NOT NULL,
  screenshot_url  text,
  browser_info    jsonb,
  status          text NOT NULL DEFAULT 'open',
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bug_reports ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'bug_reports' AND policyname = 'service role full access'
  ) THEN
    CREATE POLICY "service role full access" ON public.bug_reports FOR ALL USING (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON public.bug_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bug_reports_reporter ON public.bug_reports (reported_by);
