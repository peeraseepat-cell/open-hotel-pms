-- Phase 74 — Alert RPC Bundle
-- File 6/6. Eligibility helpers + materialize + auto-clear + finish-job +
-- night audit integration + admin force-clear.
--
-- All RPCs accept business_date explicitly (never CURRENT_DATE) per
-- Amendment #1 A2. Table names: folio_payments (not booking_payments),
-- checkin_date (not check_in_date).

-- ============================================================================
-- 1) Helpers
-- ============================================================================

-- 1a) fn_alert_get_business_date — read hotel_settings singleton
CREATE OR REPLACE FUNCTION public.fn_alert_get_business_date()
RETURNS date
LANGUAGE sql
STABLE
AS $$
  SELECT business_date FROM public.hotel_settings WHERE id = 1
$$;

-- 1b) fn_alert_is_thai_customer — priority chain per Amendment #1 A2
CREATE OR REPLACE FUNCTION public.fn_alert_is_thai_customer(p_reservation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_res record;
  v_gp record;
BEGIN
  SELECT id, guest_profile_id, guest_name, is_thai_manual
    INTO v_res
  FROM public.reservations
  WHERE id = p_reservation_id;

  IF NOT FOUND THEN RETURN false; END IF;

  -- (1) manual override
  IF coalesce(v_res.is_thai_manual, false) THEN RETURN true; END IF;

  IF v_res.guest_profile_id IS NOT NULL THEN
    SELECT nationality_code, nationality, first_name, last_name
      INTO v_gp
    FROM public.guest_profiles
    WHERE id = v_res.guest_profile_id;

    -- (2) nationality_code = TH
    IF v_gp.nationality_code = 'TH' THEN RETURN true; END IF;

    -- (3) nationality free-text
    IF v_gp.nationality IS NOT NULL
       AND lower(trim(v_gp.nationality)) IN ('thai', 'ไทย') THEN
      RETURN true;
    END IF;

    -- (4) name regex (Thai Unicode)
    IF coalesce(v_gp.first_name, '') ~ '[\u0E00-\u0E7F]'
       OR coalesce(v_gp.last_name, '') ~ '[\u0E00-\u0E7F]' THEN
      RETURN true;
    END IF;
  END IF;

  RETURN false;
END;
$$;

-- 1c) fn_alert_reservation_payment_sum — canonical total_paid source
-- Only tx_type='payment', excludes is_record_only. Per Amendment #1 A2.
CREATE OR REPLACE FUNCTION public.fn_alert_reservation_payment_sum(p_reservation_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(sum(amount), 0)
  FROM public.folio_payments
  WHERE reservation_id = p_reservation_id
    AND tx_type = 'payment'
    AND coalesce(is_record_only, false) = false
$$;

-- 1d) fn_alert_occ_for_date — occupancy percentage for a stay date
-- Uses active reservation_nights vs hotel_settings.sellable_rooms.
CREATE OR REPLACE FUNCTION public.fn_alert_occ_for_date(p_date date)
RETURNS numeric
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_sellable int;
  v_occupied int;
BEGIN
  SELECT sellable_rooms INTO v_sellable FROM public.hotel_settings WHERE id = 1;
  IF coalesce(v_sellable, 0) <= 0 THEN RETURN 0; END IF;

  SELECT count(*) INTO v_occupied
  FROM public.reservation_nights rn
  WHERE rn.stay_date = p_date
    AND rn.cancelled_at IS NULL;

  RETURN round((v_occupied::numeric / v_sellable::numeric) * 100, 2);
END;
$$;

-- ============================================================================
-- 2) alert_materialize_daily — idempotent writer of daily state rows
-- ============================================================================
-- For p_date, creates pending alert_daily_state rows for:
--   - Each active alert_rule × eligible Thai reservation with total_paid=0
--   - Each active booking_alarm with alarm_date = p_date
-- ON CONFLICT DO NOTHING (safe to re-run).
-- Skips reservations with prepayment_admin_cleared_at IS NOT NULL.

CREATE OR REPLACE FUNCTION public.alert_materialize_daily(p_date date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_lead_days int;
  v_inserted int := 0;
  v_rule record;
  v_res record;
  v_occ numeric;
BEGIN
  SELECT (value_json)::text::int INTO v_lead_days
  FROM public.app_settings WHERE key = 'alert.prepayment_lead_days';
  v_lead_days := coalesce(v_lead_days, 7);

  -- --- Pre-payment alerts ---
  FOR v_rule IN
    SELECT id, trigger_mode, date_start, date_end, occ_threshold, scope
    FROM public.alert_rules
    WHERE is_active = true
  LOOP
    FOR v_res IN
      SELECT r.id, r.checkin_date, r.booking_group_id
      FROM public.reservations r
      WHERE r.status = 'active'
        AND r.checkin_date > p_date
        AND r.checkin_date <= p_date + v_lead_days
        AND r.prepayment_admin_cleared_at IS NULL
        AND (
          v_rule.trigger_mode = 'all_year'
          OR (v_rule.trigger_mode = 'date_range' AND r.checkin_date >= v_rule.date_start AND r.checkin_date <= v_rule.date_end)
        )
        AND (
          v_rule.scope = 'all'
          OR (v_rule.scope = 'individual' AND r.booking_group_id IS NULL)
          OR (v_rule.scope = 'group' AND r.booking_group_id IS NOT NULL)
        )
    LOOP
      -- Thai?
      IF NOT public.fn_alert_is_thai_customer(v_res.id) THEN CONTINUE; END IF;

      -- total_paid = 0?
      IF public.fn_alert_reservation_payment_sum(v_res.id) > 0 THEN CONTINUE; END IF;

      -- OCC threshold (evaluated on checkin_date per Amendment #1 business rule)
      IF coalesce(v_rule.occ_threshold, 0) > 0 THEN
        v_occ := public.fn_alert_occ_for_date(v_res.checkin_date);
        IF v_occ < v_rule.occ_threshold THEN CONTINUE; END IF;
      END IF;

      INSERT INTO public.alert_daily_state
        (alert_date, reservation_id, alert_type, source_id, status)
      VALUES
        (p_date, v_res.id, 'prepayment', v_rule.id, 'pending')
      ON CONFLICT (alert_date, reservation_id, alert_type, source_id) DO NOTHING;

      IF FOUND THEN v_inserted := v_inserted + 1; END IF;
    END LOOP;
  END LOOP;

  -- --- Custom alarms ---
  -- Per Amendment §2.5: alarm on check_in_date → auto_cancelled_due_in; else pending
  FOR v_res IN
    SELECT a.id AS alarm_id, a.reservation_id, r.checkin_date
    FROM public.booking_alarms a
    JOIN public.reservations r ON r.id = a.reservation_id
    WHERE a.alarm_date = p_date
      AND a.status = 'active'
      AND r.status = 'active'
  LOOP
    INSERT INTO public.alert_daily_state
      (alert_date, reservation_id, alert_type, source_id, status)
    VALUES (
      p_date,
      v_res.reservation_id,
      'custom',
      v_res.alarm_id,
      CASE WHEN v_res.checkin_date = p_date THEN 'auto_cancelled_due_in'::public.alert_status
           ELSE 'pending'::public.alert_status END
    )
    ON CONFLICT (alert_date, reservation_id, alert_type, source_id) DO NOTHING;

    IF FOUND THEN v_inserted := v_inserted + 1; END IF;
  END LOOP;

  RETURN v_inserted;
END;
$$;

-- ============================================================================
-- 3) alert_project_daily_counts — read-only projection for /api/alerts/range
-- ============================================================================
-- Returns projected counts without writing rows. Picker uses this for days
-- the user hasn't clicked into yet.

CREATE OR REPLACE FUNCTION public.alert_project_daily_counts(p_date date)
RETURNS TABLE (alert_type text, pending_count int)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_lead_days int;
  v_prepay int := 0;
  v_custom int := 0;
  v_rule record;
  v_res record;
  v_occ numeric;
BEGIN
  SELECT (value_json)::text::int INTO v_lead_days
  FROM public.app_settings WHERE key = 'alert.prepayment_lead_days';
  v_lead_days := coalesce(v_lead_days, 7);

  -- Pre-payment count
  FOR v_rule IN
    SELECT id, trigger_mode, date_start, date_end, occ_threshold, scope
    FROM public.alert_rules
    WHERE is_active = true
  LOOP
    FOR v_res IN
      SELECT r.id, r.checkin_date, r.booking_group_id
      FROM public.reservations r
      WHERE r.status = 'active'
        AND r.checkin_date > p_date
        AND r.checkin_date <= p_date + v_lead_days
        AND r.prepayment_admin_cleared_at IS NULL
        AND (
          v_rule.trigger_mode = 'all_year'
          OR (v_rule.trigger_mode = 'date_range' AND r.checkin_date >= v_rule.date_start AND r.checkin_date <= v_rule.date_end)
        )
        AND (
          v_rule.scope = 'all'
          OR (v_rule.scope = 'individual' AND r.booking_group_id IS NULL)
          OR (v_rule.scope = 'group' AND r.booking_group_id IS NOT NULL)
        )
    LOOP
      IF NOT public.fn_alert_is_thai_customer(v_res.id) THEN CONTINUE; END IF;
      IF public.fn_alert_reservation_payment_sum(v_res.id) > 0 THEN CONTINUE; END IF;
      IF coalesce(v_rule.occ_threshold, 0) > 0 THEN
        v_occ := public.fn_alert_occ_for_date(v_res.checkin_date);
        IF v_occ < v_rule.occ_threshold THEN CONTINUE; END IF;
      END IF;
      v_prepay := v_prepay + 1;
    END LOOP;
  END LOOP;

  -- Custom count (exclude due-in-day because those auto-cancel)
  SELECT count(*) INTO v_custom
  FROM public.booking_alarms a
  JOIN public.reservations r ON r.id = a.reservation_id
  WHERE a.alarm_date = p_date
    AND a.status = 'active'
    AND r.status = 'active'
    AND r.checkin_date <> p_date;

  RETURN QUERY VALUES ('prepayment', v_prepay), ('custom', v_custom);
END;
$$;

-- ============================================================================
-- 4) alert_auto_clear_by_payment — hook called from payment POST route
-- ============================================================================
CREATE OR REPLACE FUNCTION public.alert_auto_clear_by_payment(p_booking_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_business_date date;
  v_updated int;
BEGIN
  v_business_date := public.fn_alert_get_business_date();

  UPDATE public.alert_daily_state
     SET status = 'cleared_auto',
         cleared_at = timezone('utc', now()),
         clear_note = 'Auto-cleared: payment received'
   WHERE reservation_id = p_booking_id
     AND alert_type = 'prepayment'
     AND alert_date = v_business_date
     AND status IN ('pending', 'snoozed');

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

-- ============================================================================
-- 5) alert_night_audit_bulk_snooze — migrate pending to next business date
-- ============================================================================
-- Called from Night Audit alert_check gate when FO opts to bulk-snooze.
-- Also: any custom alarm whose alarm_date = p_business_date AND
-- the reservation's checkin_date = p_next_date is marked auto_cancelled_due_in
-- (per Amendment §2.5: due-in custom alarms don't snooze).

CREATE OR REPLACE FUNCTION public.alert_night_audit_bulk_snooze(
  p_business_date date,
  p_next_date date,
  p_note text,
  p_user uuid
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_row record;
  v_migrated int := 0;
  v_will_be_due_in boolean;
BEGIN
  IF length(trim(coalesce(p_note, ''))) = 0 THEN
    RAISE EXCEPTION 'bulk snooze note is required'
      USING ERRCODE = 'check_violation';
  END IF;

  FOR v_row IN
    SELECT ads.*, r.checkin_date
    FROM public.alert_daily_state ads
    JOIN public.reservations r ON r.id = ads.reservation_id
    WHERE ads.alert_date = p_business_date
      AND ads.status IN ('pending', 'snoozed')
  LOOP
    -- Close today's instance as snoozed
    UPDATE public.alert_daily_state
       SET status = 'snoozed',
           snooze_note = p_note,
           cleared_at = timezone('utc', now()),
           cleared_by = p_user,
           clear_note = 'Night Audit bulk-snooze: ' || p_note
     WHERE id = v_row.id;

    -- Decide next-day status
    v_will_be_due_in := (
      v_row.alert_type = 'custom'
      AND v_row.checkin_date = p_next_date
    );

    INSERT INTO public.alert_daily_state
      (alert_date, reservation_id, alert_type, source_id, status, snoozed_from, snooze_note)
    VALUES (
      p_next_date,
      v_row.reservation_id,
      v_row.alert_type,
      v_row.source_id,
      CASE WHEN v_will_be_due_in
           THEN 'auto_cancelled_due_in'::public.alert_status
           ELSE 'pending'::public.alert_status END,
      p_business_date,
      p_note
    )
    ON CONFLICT (alert_date, reservation_id, alert_type, source_id) DO NOTHING;

    v_migrated := v_migrated + 1;
  END LOOP;

  RETURN v_migrated;
END;
$$;

-- ============================================================================
-- 6) alert_admin_force_clear — admin-only, suppresses future regen
-- ============================================================================
CREATE OR REPLACE FUNCTION public.alert_admin_force_clear(
  p_daily_state_id uuid,
  p_note text,
  p_user uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_row record;
  v_is_admin boolean;
BEGIN
  IF length(trim(coalesce(p_note, ''))) = 0 THEN
    RAISE EXCEPTION 'clear note is required for admin force-clear'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Role check: profiles.role = 'admin'
  SELECT (role = 'admin') INTO v_is_admin
  FROM public.profiles
  WHERE user_id = p_user;

  IF NOT coalesce(v_is_admin, false) THEN
    RAISE EXCEPTION 'admin role required for force-clear'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_row FROM public.alert_daily_state WHERE id = p_daily_state_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'alert_daily_state % not found', p_daily_state_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Mark this instance cleared
  UPDATE public.alert_daily_state
     SET status = 'cleared_admin_override',
         cleared_at = timezone('utc', now()),
         cleared_by = p_user,
         clear_note = p_note
   WHERE id = p_daily_state_id;

  -- Suppress regen on the reservation (only for prepayment type)
  IF v_row.alert_type = 'prepayment' THEN
    UPDATE public.reservations
       SET prepayment_admin_cleared_at = timezone('utc', now()),
           prepayment_admin_cleared_by = p_user,
           prepayment_admin_cleared_note = p_note
     WHERE id = v_row.reservation_id;
  END IF;

  RETURN jsonb_build_object(
    'daily_state_id', p_daily_state_id,
    'reservation_id', v_row.reservation_id,
    'alert_type', v_row.alert_type,
    'suppressed_future_regen', v_row.alert_type = 'prepayment'
  );
END;
$$;

-- ============================================================================
-- 7) alert_finish_job — writes job log, guards pending = 0
-- ============================================================================
-- Returns summary payload for the telegram helper to format.
-- Does NOT send telegram itself (edge/server concern).

CREATE OR REPLACE FUNCTION public.alert_finish_job(
  p_business_date date,
  p_user uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_total int;
  v_cleared int;
  v_snoozed int;
  v_pending int;
  v_prepayment_paid int;
  v_prepayment_snoozed int;
  v_prepayment_admin int;
  v_custom_done int;
  v_custom_snoozed int;
  v_id uuid;
BEGIN
  SELECT
    count(*),
    count(*) FILTER (WHERE status IN (
      'cleared_auto','cleared_manual','cleared_admin_override','auto_cancelled_due_in')),
    count(*) FILTER (WHERE status = 'snoozed'),
    count(*) FILTER (WHERE status = 'pending'),
    count(*) FILTER (WHERE alert_type = 'prepayment' AND status = 'cleared_auto'),
    count(*) FILTER (WHERE alert_type = 'prepayment' AND status = 'snoozed'),
    count(*) FILTER (WHERE alert_type = 'prepayment' AND status = 'cleared_admin_override'),
    count(*) FILTER (WHERE alert_type = 'custom' AND status = 'cleared_manual'),
    count(*) FILTER (WHERE alert_type = 'custom' AND status = 'snoozed')
  INTO
    v_total, v_cleared, v_snoozed, v_pending,
    v_prepayment_paid, v_prepayment_snoozed, v_prepayment_admin,
    v_custom_done, v_custom_snoozed
  FROM public.alert_daily_state
  WHERE alert_date = p_business_date;

  IF v_pending > 0 THEN
    RAISE EXCEPTION 'cannot finish alarm job: % pending alerts remain', v_pending
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.alert_job_log
    (job_date, total_alerts, cleared_count, snoozed_count, finished_by)
  VALUES
    (p_business_date, v_total, v_cleared, v_snoozed, p_user)
  ON CONFLICT (job_date) DO UPDATE
    SET total_alerts = EXCLUDED.total_alerts,
        cleared_count = EXCLUDED.cleared_count,
        snoozed_count = EXCLUDED.snoozed_count,
        finished_at = timezone('utc', now()),
        finished_by = EXCLUDED.finished_by
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'job_log_id', v_id,
    'job_date', p_business_date,
    'total', v_total,
    'cleared', v_cleared,
    'snoozed', v_snoozed,
    'prepayment', jsonb_build_object(
      'paid', v_prepayment_paid,
      'snoozed', v_prepayment_snoozed,
      'admin_override', v_prepayment_admin
    ),
    'custom', jsonb_build_object(
      'done', v_custom_done,
      'snoozed', v_custom_snoozed
    )
  );
END;
$$;

-- ============================================================================
-- 8) Grants
-- ============================================================================
GRANT EXECUTE ON FUNCTION public.fn_alert_get_business_date() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_alert_is_thai_customer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_alert_reservation_payment_sum(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_alert_occ_for_date(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.alert_materialize_daily(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.alert_project_daily_counts(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.alert_auto_clear_by_payment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.alert_night_audit_bulk_snooze(date, date, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.alert_admin_force_clear(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.alert_finish_job(date, uuid) TO authenticated;
