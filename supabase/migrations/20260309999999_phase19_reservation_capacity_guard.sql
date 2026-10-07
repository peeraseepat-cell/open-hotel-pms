-- ============================================================
-- Phase 19: Reservation Capacity Guard (Hard Stop)
-- Enforce non-dayuse room-type capacity at DB level to prevent overbook.
-- ============================================================

BEGIN;

-- Backfill room_type_id for rows that already have room_id.
UPDATE public.reservation_nights rn
SET room_type_id = r.room_type_id
FROM public.rooms r
WHERE rn.room_id = r.id
  AND rn.room_type_id IS NULL;

CREATE OR REPLACE FUNCTION public.enforce_reservation_night_capacity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_reservation record;
  v_room record;
  v_effective_room_type_id bigint;
  v_capacity int;
  v_occupied int;
BEGIN
  IF NEW.cancelled_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT id, status, is_dayuse
  INTO v_reservation
  FROM public.reservations
  WHERE id = NEW.reservation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation not found for reservation_night %', NEW.reservation_id;
  END IF;

  -- Only enforce against active reservations.
  IF v_reservation.status <> 'active' THEN
    RETURN NEW;
  END IF;

  IF NEW.room_id IS NOT NULL THEN
    SELECT id, room_number, room_type_id, is_sellable, is_dayuse
    INTO v_room
    FROM public.rooms
    WHERE id = NEW.room_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Room not found';
    END IF;

    v_effective_room_type_id := COALESCE(NEW.room_type_id, v_room.room_type_id);
    NEW.room_type_id := v_effective_room_type_id;

    IF v_reservation.is_dayuse THEN
      IF COALESCE(v_room.is_dayuse, false) = false THEN
        RAISE EXCEPTION 'Day-use reservation must use a day-use room.';
      END IF;
      RETURN NEW;
    END IF;

    IF COALESCE(v_room.is_dayuse, false) = true THEN
      RAISE EXCEPTION 'Cannot assign overnight reservation to day-use room %', v_room.room_number;
    END IF;

    IF COALESCE(v_room.is_sellable, false) = false THEN
      RAISE EXCEPTION 'Room % is not sellable', v_room.room_number;
    END IF;
  ELSE
    -- Floating reservation night: require room_type_id and enforce capacity.
    v_effective_room_type_id := NEW.room_type_id;
    IF v_effective_room_type_id IS NULL THEN
      RAISE EXCEPTION 'room_type_id is required for floating reservation night';
    END IF;

    IF v_reservation.is_dayuse THEN
      RAISE EXCEPTION 'Day-use reservation night must reference a room_id.';
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_capacity
  FROM public.rooms r
  WHERE r.room_type_id = v_effective_room_type_id
    AND r.is_sellable = true
    AND COALESCE(r.is_dayuse, false) = false
    AND NOT EXISTS (
      SELECT 1
      FROM public.room_blocks rb
      WHERE rb.room_id = r.id
        AND rb.block_type = 'OOO'
        AND rb.start_date <= NEW.stay_date
        AND rb.end_date > NEW.stay_date
    );

  IF v_capacity <= 0 THEN
    RAISE EXCEPTION 'No availability: all 0 rooms of this type are fully booked on %', NEW.stay_date;
  END IF;

  SELECT COUNT(DISTINCT rn.reservation_id) INTO v_occupied
  FROM public.reservation_nights rn
  JOIN public.reservations rs
    ON rs.id = rn.reservation_id
  LEFT JOIN public.rooms rr
    ON rr.id = rn.room_id
  WHERE rn.cancelled_at IS NULL
    AND rn.stay_date = NEW.stay_date
    AND rn.reservation_id <> NEW.reservation_id
    AND rs.status = 'active'
    AND COALESCE(rs.is_dayuse, false) = false
    AND (
      rn.room_type_id = v_effective_room_type_id
      OR (
        rr.room_type_id = v_effective_room_type_id
        AND COALESCE(rr.is_dayuse, false) = false
      )
    );

  IF v_occupied >= v_capacity THEN
    RAISE EXCEPTION 'No availability: all % rooms of this type are fully booked on %', v_capacity, NEW.stay_date;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_reservation_night_capacity ON public.reservation_nights;
CREATE TRIGGER trg_enforce_reservation_night_capacity
BEFORE INSERT OR UPDATE OF reservation_id, room_id, room_type_id, stay_date, cancelled_at
ON public.reservation_nights
FOR EACH ROW
EXECUTE FUNCTION public.enforce_reservation_night_capacity();

COMMIT;
