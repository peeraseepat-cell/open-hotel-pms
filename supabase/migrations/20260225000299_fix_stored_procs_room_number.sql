-- =============================================================
-- Fix booking_create_reservation & booking_update_reservation
-- Remove references to reservations.room_number (column was dropped)
-- The room assignment is stored in reservation_nights.room_id instead.
-- Created: 2026-02-25
-- =============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.booking_create_reservation(
  p_guest_name text,
  p_checkin_date date,
  p_checkout_date date,
  p_room_number text DEFAULT NULL,
  p_room_type_id bigint DEFAULT NULL,
  p_source public.booking_source DEFAULT 'walkin',
  p_phone text DEFAULT NULL,
  p_checkin_time text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_ota_prices numeric[] DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_reservation_id uuid;
  v_booking_code text;
  v_room public.rooms%rowtype;
  v_room_id uuid;
  v_effective_room_type_id bigint;
  v_pricing_room_id uuid;
  v_night_dates date[];
  v_nights_count int;
  v_prices numeric[];
  v_total_price numeric(10, 2);
  v_conflict_date date;
  v_capacity_date date;
  v_room_capacity int;
  v_normalized_phone text;
  v_normalized_checkin_time text;
  v_normalized_note text;
BEGIN
  IF p_guest_name IS NULL OR btrim(p_guest_name) = '' THEN
    RAISE EXCEPTION 'guest_name is required';
  END IF;

  IF (p_room_number IS NULL OR btrim(p_room_number) = '') AND p_room_type_id IS NULL THEN
    RAISE EXCEPTION 'Either room_number or room_type_id is required';
  END IF;

  IF p_checkout_date <= p_checkin_date THEN
    RAISE EXCEPTION 'checkout_date must be after checkin_date';
  END IF;

  -- 1. Resolve Room & Room Type
  IF p_room_number IS NOT NULL AND btrim(p_room_number) <> '' THEN
    SELECT * INTO v_room
    FROM public.rooms
    WHERE room_number = btrim(p_room_number)
    FOR UPDATE;

    IF NOT found THEN
      RAISE EXCEPTION 'Room not found: %', p_room_number;
    END IF;

    IF NOT v_room.is_sellable THEN
      RAISE EXCEPTION 'Room % is not sellable', v_room.room_number;
    END IF;

    v_room_id := v_room.id;
    v_effective_room_type_id := v_room.room_type_id;
    v_pricing_room_id := v_room.id;
  ELSE
    v_room_id := NULL;
    v_effective_room_type_id := p_room_type_id;

    -- Pick any room of this type to use for pricing templates
    SELECT id INTO v_pricing_room_id
    FROM public.rooms
    WHERE room_type_id = p_room_type_id
      AND is_sellable = true
    LIMIT 1;

    IF v_pricing_room_id IS NULL THEN
      RAISE EXCEPTION 'No rooms found for room_type_id: %', p_room_type_id;
    END IF;
  END IF;

  -- 2. Generate Dates
  SELECT COALESCE(array_agg(day::date ORDER BY day::date), ARRAY[]::date[])
  INTO v_night_dates
  FROM generate_series(
    p_checkin_date::timestamp,
    (p_checkout_date - INTERVAL '1 day')::timestamp,
    INTERVAL '1 day'
  ) AS day;

  v_nights_count := cardinality(v_night_dates);
  IF v_nights_count = 0 THEN
    RAISE EXCEPTION 'No nights generated for selected date range';
  END IF;

  -- 3. Check Conflicts (specific room) OR Capacity (floating booking)
  IF v_room_id IS NOT NULL THEN
    SELECT rn.stay_date INTO v_conflict_date
    FROM public.reservation_nights rn
    WHERE rn.room_id = v_room_id
      AND rn.cancelled_at IS NULL
      AND rn.stay_date = ANY(v_night_dates)
    LIMIT 1;

    IF v_conflict_date IS NOT NULL THEN
      RAISE EXCEPTION 'Room % already booked on %', v_room.room_number, v_conflict_date;
    END IF;
  ELSE
    -- Floating booking: check per-night capacity
    SELECT COUNT(*) INTO v_room_capacity
    FROM public.rooms
    WHERE room_type_id = v_effective_room_type_id
      AND is_sellable = true;

    SELECT d INTO v_capacity_date
    FROM unnest(v_night_dates) AS d
    WHERE (
      SELECT COUNT(DISTINCT rn.reservation_id)
      FROM public.reservation_nights rn
      WHERE rn.room_type_id = v_effective_room_type_id
        AND rn.stay_date = d
        AND rn.cancelled_at IS NULL
    ) >= v_room_capacity
    LIMIT 1;

    IF v_capacity_date IS NOT NULL THEN
      RAISE EXCEPTION 'No availability: all % rooms of this type are fully booked on %', v_room_capacity, v_capacity_date;
    END IF;
  END IF;

  -- 4. Calculate Prices
  IF p_source = 'ota' THEN
    IF p_ota_prices IS NULL OR cardinality(p_ota_prices) <> v_nights_count THEN
      RAISE EXCEPTION 'OTA bookings require ota_prices length = %', v_nights_count;
    END IF;

    SELECT COALESCE(array_agg(round(COALESCE(ota.price, 0)::numeric, 2) ORDER BY ota.idx), ARRAY[]::numeric[])
    INTO v_prices
    FROM unnest(p_ota_prices) WITH ORDINALITY AS ota(price, idx);
  ELSE
    SELECT COALESCE(array_agg(COALESCE(rt.price, 0)::numeric(10, 2) ORDER BY d.stay_date), ARRAY[]::numeric[])
    INTO v_prices
    FROM unnest(v_night_dates) AS d(stay_date)
    LEFT JOIN public.rate_templates rt
      ON rt.room_id = v_pricing_room_id
     AND rt.stay_date = d.stay_date;
  END IF;

  SELECT round(COALESCE(sum(COALESCE(price, 0)), 0)::numeric, 2)
  INTO v_total_price
  FROM unnest(v_prices) AS p(price);

  -- 5. Insert Reservation (no room_number column — room tracked via reservation_nights.room_id)
  v_booking_code := public.generate_booking_code();
  v_normalized_phone := nullif(btrim(COALESCE(p_phone, '')), '');
  v_normalized_checkin_time := nullif(btrim(COALESCE(p_checkin_time, '')), '');
  v_normalized_note := nullif(btrim(COALESCE(p_note, '')), '');

  INSERT INTO public.reservations (
    booking_code, guest_name, phone, source, status,
    checkin_date, checkout_date, checkin_time, note,
    total_price, created_by, updated_by
  ) VALUES (
    v_booking_code,
    btrim(p_guest_name),
    v_normalized_phone,
    p_source,
    'active',
    p_checkin_date,
    p_checkout_date,
    v_normalized_checkin_time,
    v_normalized_note,
    v_total_price,
    p_actor_user_id,
    p_actor_user_id
  )
  RETURNING id INTO v_reservation_id;

  -- 6. Insert Reservation Nights
  INSERT INTO public.reservation_nights (
    reservation_id, room_id, room_type_id, stay_date, nightly_price, is_ota
  )
  SELECT
    v_reservation_id,
    v_room_id,
    v_effective_room_type_id,
    d.stay_date,
    round(COALESCE(pr.price, 0)::numeric, 2),
    p_source = 'ota'
  FROM unnest(v_night_dates) WITH ORDINALITY AS d(stay_date, idx)
  JOIN unnest(v_prices) WITH ORDINALITY AS pr(price, idx)
    ON pr.idx = d.idx;

  -- 7. Audit Log
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, after_json)
  VALUES (
    p_actor_user_id,
    'booking_created',
    'reservation',
    v_reservation_id::text,
    jsonb_build_object(
      'booking_code', v_booking_code,
      'room_number', p_room_number,
      'room_type_id', v_effective_room_type_id,
      'checkin_date', p_checkin_date,
      'checkout_date', p_checkout_date,
      'total_price', v_total_price
    )
  );

  RETURN jsonb_build_object(
    'id', v_reservation_id,
    'booking_code', v_booking_code,
    'guest_name', btrim(p_guest_name),
    'room_number', p_room_number,
    'room_type_id', v_effective_room_type_id,
    'source', p_source,
    'checkin_date', p_checkin_date,
    'checkout_date', p_checkout_date,
    'total_nights', v_nights_count,
    'nightly_prices', to_jsonb(v_prices),
    'total_price', v_total_price
  );
END;
$$;

-- ── Fix booking_update_reservation: remove room_number from UPDATE ──────────

CREATE OR REPLACE FUNCTION public.booking_update_reservation(
  p_reservation_id uuid,
  p_guest_name text,
  p_checkin_date date,
  p_checkout_date date,
  p_room_number text DEFAULT NULL,
  p_room_type_id bigint DEFAULT NULL,
  p_source public.booking_source DEFAULT 'walkin',
  p_phone text DEFAULT NULL,
  p_checkin_time text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_ota_prices numeric[] DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_reservation public.reservations%rowtype;
  v_room public.rooms%rowtype;
  v_room_id uuid;
  v_effective_room_type_id bigint;
  v_pricing_room_id uuid;
  v_night_dates date[];
  v_nights_count int;
  v_prices numeric[];
  v_total_price numeric(10, 2);
  v_conflict_date date;
  v_capacity_date date;
  v_room_capacity int;
  v_replaced_nights int;
  v_cancelled_at timestamptz;
  v_before jsonb;
  v_normalized_phone text;
  v_normalized_checkin_time text;
  v_normalized_note text;
BEGIN
  IF p_guest_name IS NULL OR btrim(p_guest_name) = '' THEN
    RAISE EXCEPTION 'guest_name is required';
  END IF;

  IF (p_room_number IS NULL OR btrim(p_room_number) = '') AND p_room_type_id IS NULL THEN
    RAISE EXCEPTION 'Either room_number or room_type_id is required';
  END IF;

  IF p_checkout_date <= p_checkin_date THEN
    RAISE EXCEPTION 'checkout_date must be after checkin_date';
  END IF;

  SELECT * INTO v_reservation
  FROM public.reservations
  WHERE id = p_reservation_id
  FOR UPDATE;

  IF NOT found THEN
    RAISE EXCEPTION 'Reservation not found';
  END IF;

  IF v_reservation.status <> 'active' THEN
    RAISE EXCEPTION 'Reservation is not active';
  END IF;

  -- 1. Resolve Room & Room Type
  IF p_room_number IS NOT NULL AND btrim(p_room_number) <> '' THEN
    SELECT * INTO v_room
    FROM public.rooms
    WHERE room_number = btrim(p_room_number)
    FOR UPDATE;

    IF NOT found THEN
      RAISE EXCEPTION 'Room not found: %', p_room_number;
    END IF;

    IF NOT v_room.is_sellable THEN
      RAISE EXCEPTION 'Room % is not sellable', v_room.room_number;
    END IF;

    v_room_id := v_room.id;
    v_effective_room_type_id := v_room.room_type_id;
    v_pricing_room_id := v_room.id;
  ELSE
    v_room_id := NULL;
    v_effective_room_type_id := p_room_type_id;

    SELECT id INTO v_pricing_room_id
    FROM public.rooms
    WHERE room_type_id = p_room_type_id
      AND is_sellable = true
    LIMIT 1;

    IF v_pricing_room_id IS NULL THEN
      RAISE EXCEPTION 'No rooms found for room_type_id: %', p_room_type_id;
    END IF;
  END IF;

  -- 2. Generate Dates
  SELECT COALESCE(array_agg(day::date ORDER BY day::date), ARRAY[]::date[])
  INTO v_night_dates
  FROM generate_series(
    p_checkin_date::timestamp,
    (p_checkout_date - INTERVAL '1 day')::timestamp,
    INTERVAL '1 day'
  ) AS day;

  v_nights_count := cardinality(v_night_dates);
  IF v_nights_count = 0 THEN
    RAISE EXCEPTION 'No nights generated for selected date range';
  END IF;

  -- 3. Conflict or Capacity check
  IF v_room_id IS NOT NULL THEN
    SELECT rn.stay_date INTO v_conflict_date
    FROM public.reservation_nights rn
    WHERE rn.room_id = v_room_id
      AND rn.cancelled_at IS NULL
      AND rn.stay_date = ANY(v_night_dates)
      AND rn.reservation_id <> p_reservation_id
    LIMIT 1;

    IF v_conflict_date IS NOT NULL THEN
      RAISE EXCEPTION 'Room % already booked on %', v_room.room_number, v_conflict_date;
    END IF;
  ELSE
    -- Capacity check: exclude THIS reservation's existing nights from count
    SELECT COUNT(*) INTO v_room_capacity
    FROM public.rooms
    WHERE room_type_id = v_effective_room_type_id
      AND is_sellable = true;

    SELECT d INTO v_capacity_date
    FROM unnest(v_night_dates) AS d
    WHERE (
      SELECT COUNT(DISTINCT rn.reservation_id)
      FROM public.reservation_nights rn
      WHERE rn.room_type_id = v_effective_room_type_id
        AND rn.stay_date = d
        AND rn.cancelled_at IS NULL
        AND rn.reservation_id <> p_reservation_id  -- exclude self
    ) >= v_room_capacity
    LIMIT 1;

    IF v_capacity_date IS NOT NULL THEN
      RAISE EXCEPTION 'No availability: all % rooms of this type are fully booked on %', v_room_capacity, v_capacity_date;
    END IF;
  END IF;

  -- 4. Calculate Prices
  IF p_source = 'ota' THEN
    IF p_ota_prices IS NULL OR cardinality(p_ota_prices) <> v_nights_count THEN
      RAISE EXCEPTION 'OTA bookings require ota_prices length = %', v_nights_count;
    END IF;

    SELECT COALESCE(array_agg(round(COALESCE(ota.price, 0)::numeric, 2) ORDER BY ota.idx), ARRAY[]::numeric[])
    INTO v_prices
    FROM unnest(p_ota_prices) WITH ORDINALITY AS ota(price, idx);
  ELSE
    SELECT COALESCE(array_agg(COALESCE(rt.price, 0)::numeric(10, 2) ORDER BY d.stay_date), ARRAY[]::numeric[])
    INTO v_prices
    FROM unnest(v_night_dates) AS d(stay_date)
    LEFT JOIN public.rate_templates rt
      ON rt.room_id = v_pricing_room_id
     AND rt.stay_date = d.stay_date;
  END IF;

  SELECT round(COALESCE(sum(COALESCE(price, 0)), 0)::numeric, 2)
  INTO v_total_price
  FROM unnest(v_prices) AS p(price);

  v_before := jsonb_build_object(
    'guest_name', v_reservation.guest_name,
    'source', v_reservation.source,
    'checkin_date', v_reservation.checkin_date,
    'checkout_date', v_reservation.checkout_date,
    'total_price', v_reservation.total_price
  );

  -- 5. Cancel old nights
  v_cancelled_at := timezone('utc', now());
  UPDATE public.reservation_nights
  SET cancelled_at = v_cancelled_at
  WHERE reservation_id = p_reservation_id
    AND cancelled_at IS NULL;
  GET DIAGNOSTICS v_replaced_nights = ROW_COUNT;

  -- 6. Update Reservation (no room_number column — room tracked via reservation_nights.room_id)
  v_normalized_phone := nullif(btrim(COALESCE(p_phone, '')), '');
  v_normalized_checkin_time := nullif(btrim(COALESCE(p_checkin_time, '')), '');
  v_normalized_note := nullif(btrim(COALESCE(p_note, '')), '');

  UPDATE public.reservations SET
    guest_name = btrim(p_guest_name),
    phone = v_normalized_phone,
    source = p_source,
    checkin_date = p_checkin_date,
    checkout_date = p_checkout_date,
    checkin_time = v_normalized_checkin_time,
    note = v_normalized_note,
    total_price = v_total_price,
    updated_by = COALESCE(p_actor_user_id, updated_by)
  WHERE id = p_reservation_id;

  -- 7. Insert New Nights
  INSERT INTO public.reservation_nights (
    reservation_id, room_id, room_type_id, stay_date, nightly_price, is_ota
  )
  SELECT
    p_reservation_id,
    v_room_id,
    v_effective_room_type_id,
    d.stay_date,
    round(COALESCE(pr.price, 0)::numeric, 2),
    p_source = 'ota'
  FROM unnest(v_night_dates) WITH ORDINALITY AS d(stay_date, idx)
  JOIN unnest(v_prices) WITH ORDINALITY AS pr(price, idx)
    ON pr.idx = d.idx;

  -- 8. Audit Log
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, before_json, after_json)
  VALUES (
    p_actor_user_id,
    'booking_updated',
    'reservation',
    p_reservation_id::text,
    v_before,
    jsonb_build_object(
      'room_number', p_room_number,
      'room_type_id', v_effective_room_type_id,
      'source', p_source,
      'checkin_date', p_checkin_date,
      'checkout_date', p_checkout_date,
      'total_price', v_total_price,
      'replaced_nights', v_replaced_nights
    )
  );

  RETURN jsonb_build_object(
    'id', p_reservation_id,
    'booking_code', v_reservation.booking_code,
    'guest_name', btrim(p_guest_name),
    'room_number', p_room_number,
    'room_type_id', v_effective_room_type_id,
    'source', p_source,
    'checkin_date', p_checkin_date,
    'checkout_date', p_checkout_date,
    'total_nights', v_nights_count,
    'nightly_prices', to_jsonb(v_prices),
    'total_price', v_total_price
  );
END;
$$;

COMMIT;
