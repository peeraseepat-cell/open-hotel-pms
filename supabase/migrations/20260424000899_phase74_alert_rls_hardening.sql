-- Phase 74 follow-up: tighten direct browser writes for Alerts/Alarms tables.
--
-- Server API routes use the service-role Supabase client and still bypass RLS.
-- Authenticated browser clients may read these operational tables, but direct
-- writes must go through the Phase 74 API/RPC layer so role checks, audit fields,
-- and notification semantics cannot be bypassed.

-- alert_rules ---------------------------------------------------------------
ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "alert_rules_write_authenticated" ON public.alert_rules;
DROP POLICY IF EXISTS "alert_rules_read_authenticated" ON public.alert_rules;

CREATE POLICY "alert_rules_read_authenticated"
  ON public.alert_rules
  FOR SELECT
  TO authenticated
  USING (true);

-- booking_alarms ------------------------------------------------------------
ALTER TABLE public.booking_alarms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "booking_alarms_write_authenticated" ON public.booking_alarms;
DROP POLICY IF EXISTS "booking_alarms_read_authenticated" ON public.booking_alarms;

CREATE POLICY "booking_alarms_read_authenticated"
  ON public.booking_alarms
  FOR SELECT
  TO authenticated
  USING (true);

-- alert_daily_state ---------------------------------------------------------
ALTER TABLE public.alert_daily_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "alert_daily_state_write_authenticated" ON public.alert_daily_state;
DROP POLICY IF EXISTS "alert_daily_state_read_authenticated" ON public.alert_daily_state;

CREATE POLICY "alert_daily_state_read_authenticated"
  ON public.alert_daily_state
  FOR SELECT
  TO authenticated
  USING (true);

-- alert_job_log -------------------------------------------------------------
ALTER TABLE public.alert_job_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "alert_job_log_write_authenticated" ON public.alert_job_log;
DROP POLICY IF EXISTS "alert_job_log_read_authenticated" ON public.alert_job_log;

CREATE POLICY "alert_job_log_read_authenticated"
  ON public.alert_job_log
  FOR SELECT
  TO authenticated
  USING (true);
