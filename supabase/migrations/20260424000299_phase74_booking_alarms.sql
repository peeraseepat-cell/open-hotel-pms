-- Phase 74 — Booking Alarms (custom per-booking alarm definitions)
-- File 2/6. Immutable alarm definitions; snooze/clear lives in alert_daily_state.

-- 1) Enum -------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.booking_alarm_status AS ENUM (
    'active',
    'completed',
    'deleted',
    'auto_cancelled_due_in'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2) Table ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.booking_alarms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id  uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  alarm_date      date NOT NULL,
  note            text NOT NULL CHECK (length(trim(note)) >= 5),
  status          public.booking_alarm_status NOT NULL DEFAULT 'active',

  created_at      timestamptz NOT NULL DEFAULT timezone('utc', now()),
  created_by      uuid REFERENCES public.profiles(user_id),

  completed_at    timestamptz,
  completed_by    uuid REFERENCES public.profiles(user_id),
  completion_note text,

  deleted_at      timestamptz,
  deleted_by      uuid REFERENCES public.profiles(user_id)
);

-- 3) Indexes ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_booking_alarms_res
  ON public.booking_alarms (reservation_id);

CREATE INDEX IF NOT EXISTS idx_booking_alarms_date
  ON public.booking_alarms (alarm_date)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_booking_alarms_status
  ON public.booking_alarms (status);

-- 4) Validation: alarm_date must precede reservation check_in_date ---------
-- Applied on INSERT + UPDATE of alarm_date. We fetch check_in_date from
-- reservations and compare; if alarm_date >= check_in_date, reject.

CREATE OR REPLACE FUNCTION public.tg_booking_alarms_validate_date()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_checkin_date date;
BEGIN
  SELECT checkin_date INTO v_checkin_date
  FROM public.reservations
  WHERE id = NEW.reservation_id;

  IF v_checkin_date IS NULL THEN
    RAISE EXCEPTION 'reservation % not found or has no checkin_date', NEW.reservation_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.alarm_date >= v_checkin_date THEN
    RAISE EXCEPTION 'alarm_date (%) must be before reservation checkin_date (%)', NEW.alarm_date, v_checkin_date
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS booking_alarms_validate_date ON public.booking_alarms;
CREATE TRIGGER booking_alarms_validate_date
  BEFORE INSERT OR UPDATE OF alarm_date, reservation_id
  ON public.booking_alarms
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_booking_alarms_validate_date();

-- 5) Lifecycle consistency (best-effort; admin corrections may bypass) -----
ALTER TABLE public.booking_alarms
  DROP CONSTRAINT IF EXISTS booking_alarms_lifecycle_consistency;

ALTER TABLE public.booking_alarms
  ADD CONSTRAINT booking_alarms_lifecycle_consistency CHECK (
    (status = 'completed' AND completed_at IS NOT NULL AND length(trim(coalesce(completion_note, ''))) > 0)
    OR
    (status = 'deleted' AND deleted_at IS NOT NULL)
    OR
    (status IN ('active', 'auto_cancelled_due_in'))
  );

-- 6) RLS --------------------------------------------------------------------
ALTER TABLE public.booking_alarms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "booking_alarms_read_authenticated" ON public.booking_alarms;
CREATE POLICY "booking_alarms_read_authenticated"
  ON public.booking_alarms FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "booking_alarms_write_authenticated" ON public.booking_alarms;
CREATE POLICY "booking_alarms_write_authenticated"
  ON public.booking_alarms FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
