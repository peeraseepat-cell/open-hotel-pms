-- Phase 74 — Alert Job Log
-- File 4/6. Records every Finish Alarm Job execution; one row per business
-- date. Audit trail JSONB captures per-action history for the day.

CREATE TABLE IF NOT EXISTS public.alert_job_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_date          date NOT NULL UNIQUE,
  total_alerts      integer NOT NULL DEFAULT 0,
  cleared_count     integer NOT NULL DEFAULT 0,
  snoozed_count     integer NOT NULL DEFAULT 0,

  finished_at       timestamptz NOT NULL DEFAULT timezone('utc', now()),
  finished_by       uuid REFERENCES public.profiles(user_id),

  telegram_sent_at  timestamptz,
  telegram_message  text,
  telegram_error    text,

  audit_trail       jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_alert_job_log_date
  ON public.alert_job_log (job_date DESC);

-- RLS
ALTER TABLE public.alert_job_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "alert_job_log_read_authenticated" ON public.alert_job_log;
CREATE POLICY "alert_job_log_read_authenticated"
  ON public.alert_job_log FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "alert_job_log_write_authenticated" ON public.alert_job_log;
CREATE POLICY "alert_job_log_write_authenticated"
  ON public.alert_job_log FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
