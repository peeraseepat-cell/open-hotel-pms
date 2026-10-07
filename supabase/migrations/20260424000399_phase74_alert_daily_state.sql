-- Phase 74 — Alert Daily State + reservations.is_thai_manual
-- File 3/6. Per-day alert instances (snooze/clear state) + Thai manual flag.
--
-- Amendment #1 A4: adds reservations.is_thai_manual (default false)
-- Amendment #1 A2: Thai detection priority chain — is_thai_manual is first.

-- 1) Enum -------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.alert_type AS ENUM ('prepayment', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.alert_status AS ENUM (
    'pending',
    'snoozed',
    'cleared_auto',
    'cleared_manual',
    'cleared_admin_override',
    'auto_cancelled_due_in'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2) reservations.is_thai_manual -------------------------------------------
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS is_thai_manual boolean NOT NULL DEFAULT false;

-- 3) alert_daily_state table -----------------------------------------------
-- One row per (alert_date, reservation_id, alert_type, source_id)
-- source_id references either alert_rules.id (for prepayment) or
-- booking_alarms.id (for custom). Not FK-enforced so orphans from rule
-- inactivation don't cascade-destroy history.

CREATE TABLE IF NOT EXISTS public.alert_daily_state (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_date     date NOT NULL,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  alert_type     public.alert_type NOT NULL,
  source_id      uuid NOT NULL,
  status         public.alert_status NOT NULL DEFAULT 'pending',

  snoozed_from   date,
  snooze_note    text,

  cleared_at     timestamptz,
  cleared_by     uuid REFERENCES public.profiles(user_id),
  clear_note     text,

  created_at     timestamptz NOT NULL DEFAULT timezone('utc', now()),

  CONSTRAINT alert_daily_state_uniq_instance UNIQUE (alert_date, reservation_id, alert_type, source_id)
);

-- 4) Indexes ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_alert_daily_state_date
  ON public.alert_daily_state (alert_date);

CREATE INDEX IF NOT EXISTS idx_alert_daily_state_res
  ON public.alert_daily_state (reservation_id);

CREATE INDEX IF NOT EXISTS idx_alert_daily_state_status
  ON public.alert_daily_state (alert_date, status)
  WHERE status IN ('pending', 'snoozed');

CREATE INDEX IF NOT EXISTS idx_alert_daily_state_type
  ON public.alert_daily_state (alert_date, alert_type);

-- 5) Admin force-clear marker on reservations ------------------------------
-- Per Amendment §2.4 / H-rule: once admin force-clears prepayment alert for
-- a booking, no regen. We persist this as a column so future materialize
-- calls can skip the reservation.

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS prepayment_admin_cleared_at timestamptz;

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS prepayment_admin_cleared_by uuid REFERENCES public.profiles(user_id);

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS prepayment_admin_cleared_note text;

-- 6) RLS --------------------------------------------------------------------
ALTER TABLE public.alert_daily_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "alert_daily_state_read_authenticated" ON public.alert_daily_state;
CREATE POLICY "alert_daily_state_read_authenticated"
  ON public.alert_daily_state FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "alert_daily_state_write_authenticated" ON public.alert_daily_state;
CREATE POLICY "alert_daily_state_write_authenticated"
  ON public.alert_daily_state FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
