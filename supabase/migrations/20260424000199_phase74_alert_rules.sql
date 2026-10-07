-- Phase 74 — Alert Rules (pre-payment rule engine)
-- File 1/6. Creates alert_rules table, enums, RLS, and the overlap validator
-- used by BEFORE INSERT/UPDATE trigger to prevent conflicting active rules.
--
-- Amendment #1 references:
--   A2: trigger/scope mapping
--   A3: this file uses 2026-04-24 date prefix
--
-- Safe to re-run on fresh DB (idempotent via IF NOT EXISTS).

-- 1) Enums ------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.alert_rule_trigger AS ENUM ('all_year', 'date_range');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.alert_rule_scope AS ENUM ('all', 'individual', 'group');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2) Table ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.alert_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(trim(name)) > 0),
  is_active    boolean NOT NULL DEFAULT true,
  trigger_mode public.alert_rule_trigger NOT NULL,
  date_start   date,
  date_end     date,
  occ_threshold numeric(5, 2) NOT NULL DEFAULT 0 CHECK (occ_threshold >= 0 AND occ_threshold <= 100),
  scope        public.alert_rule_scope NOT NULL DEFAULT 'all',
  created_at   timestamptz NOT NULL DEFAULT timezone('utc', now()),
  created_by   uuid REFERENCES public.profiles(user_id),
  updated_at   timestamptz NOT NULL DEFAULT timezone('utc', now()),

  -- Shape consistency: all_year must have null dates; date_range must have both
  CONSTRAINT alert_rules_trigger_dates_shape CHECK (
    (trigger_mode = 'all_year' AND date_start IS NULL AND date_end IS NULL)
    OR
    (trigger_mode = 'date_range' AND date_start IS NOT NULL AND date_end IS NOT NULL AND date_end >= date_start)
  )
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_active
  ON public.alert_rules (is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_alert_rules_range
  ON public.alert_rules (date_start, date_end)
  WHERE is_active = true AND trigger_mode = 'date_range';

-- 3) updated_at auto-touch --------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_alert_rules_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := timezone('utc', now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS alert_rules_set_updated_at ON public.alert_rules;
CREATE TRIGGER alert_rules_set_updated_at
  BEFORE UPDATE ON public.alert_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_alert_rules_set_updated_at();

-- 4) Overlap validator ------------------------------------------------------
-- Rule: among all_active_rules, no two may share any day. An all_year rule
-- overlaps with every other active rule. A date_range rule overlaps with
-- another date_range rule whose [start,end] intersects.
--
-- Returns: jsonb with { ok: boolean, conflicts: [{id,name,date_start,date_end}] }

CREATE OR REPLACE FUNCTION public.alert_rules_check_overlap(
  p_rule_id uuid,
  p_trigger public.alert_rule_trigger,
  p_start date,
  p_end date,
  p_is_active boolean
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_conflicts jsonb;
BEGIN
  -- Inactive rule can never conflict
  IF NOT p_is_active THEN
    RETURN jsonb_build_object('ok', true, 'conflicts', '[]'::jsonb);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'name', r.name,
    'date_start', r.date_start,
    'date_end', r.date_end
  )), '[]'::jsonb)
  INTO v_conflicts
  FROM public.alert_rules r
  WHERE r.is_active = true
    AND (p_rule_id IS NULL OR r.id <> p_rule_id)
    AND (
      -- Any active rule conflicts with a new all_year rule
      p_trigger = 'all_year'
      -- Any active all_year rule conflicts with a new date_range rule
      OR r.trigger_mode = 'all_year'
      -- Two date_range rules overlap if [a_start, a_end] ∩ [b_start, b_end] ≠ ∅
      OR (
        p_trigger = 'date_range'
        AND r.trigger_mode = 'date_range'
        AND p_start IS NOT NULL AND p_end IS NOT NULL
        AND r.date_start <= p_end
        AND r.date_end >= p_start
      )
    );

  RETURN jsonb_build_object(
    'ok', jsonb_array_length(v_conflicts) = 0,
    'conflicts', v_conflicts
  );
END;
$$;

-- 5) Enforcement trigger: BEFORE INSERT/UPDATE blocks if overlap exists
CREATE OR REPLACE FUNCTION public.tg_alert_rules_enforce_overlap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.alert_rules_check_overlap(
    CASE WHEN TG_OP = 'UPDATE' THEN NEW.id ELSE NULL END,
    NEW.trigger_mode,
    NEW.date_start,
    NEW.date_end,
    NEW.is_active
  );

  IF (v_result ->> 'ok')::boolean = false THEN
    RAISE EXCEPTION 'Alert rule overlaps with existing active rule(s): %', v_result -> 'conflicts'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS alert_rules_enforce_overlap ON public.alert_rules;
CREATE TRIGGER alert_rules_enforce_overlap
  BEFORE INSERT OR UPDATE OF is_active, trigger_mode, date_start, date_end
  ON public.alert_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_alert_rules_enforce_overlap();

-- 6) RLS --------------------------------------------------------------------
ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "alert_rules_read_authenticated" ON public.alert_rules;
CREATE POLICY "alert_rules_read_authenticated"
  ON public.alert_rules FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "alert_rules_write_authenticated" ON public.alert_rules;
CREATE POLICY "alert_rules_write_authenticated"
  ON public.alert_rules FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- 7) Grants for exposed RPC
GRANT EXECUTE ON FUNCTION public.alert_rules_check_overlap(uuid, public.alert_rule_trigger, date, date, boolean)
  TO authenticated;
