-- ============================================================
-- Phase 38: Isolate Day Use room type from Family (hard split)
-- ============================================================
-- Goal:
-- 1) Create dedicated room_type code = 'DU' (Day Use)
-- 2) Move all day-use rooms to DU room type
-- 3) Enforce future writes so day-use rooms never drift back to Family/other types

BEGIN;

-- 1) Ensure dedicated Day Use room type exists
INSERT INTO public.room_types (code, name_en, name_local, sort_order, cleaning_duration_min)
VALUES ('DU', 'Day Use', 'Day Use', 65, 60)
ON CONFLICT (code) DO UPDATE
SET
  name_en = EXCLUDED.name_en,
  name_local = EXCLUDED.name_local,
  sort_order = EXCLUDED.sort_order,
  cleaning_duration_min = GREATEST(COALESCE(public.room_types.cleaning_duration_min, EXCLUDED.cleaning_duration_min), 1),
  updated_at = timezone('utc', now());

-- Ensure DU always has a housekeeping cleaning duration
UPDATE public.room_types
SET
  cleaning_duration_min = GREATEST(COALESCE(cleaning_duration_min, 60), 1),
  updated_at = timezone('utc', now())
WHERE code = 'DU';

-- 2) Canonical day-use room numbers should always be day-use
UPDATE public.rooms
SET
  is_dayuse = true,
  is_visible_on_board = true,
  is_sellable = true,
  closure_reason = null,
  updated_at = timezone('utc', now())
WHERE room_number IN ('118', '120', '122');

-- 3) Move all day-use rooms to DU room_type
WITH du_type AS (
  SELECT id
  FROM public.room_types
  WHERE code = 'DU'
  LIMIT 1
)
UPDATE public.rooms r
SET
  room_type_id = du.id,
  is_dayuse = true,
  updated_at = timezone('utc', now())
FROM du_type du
WHERE
  (COALESCE(r.is_dayuse, false) = true OR r.room_number IN ('118', '120', '122'))
  AND r.room_type_id IS DISTINCT FROM du.id;

-- 4) Keep reservation_nights.room_type_id aligned for day-use history rows
WITH du_type AS (
  SELECT id
  FROM public.room_types
  WHERE code = 'DU'
  LIMIT 1
),
dayuse_rooms AS (
  SELECT id
  FROM public.rooms
  WHERE COALESCE(is_dayuse, false) = true
)
UPDATE public.reservation_nights rn
SET room_type_id = du.id
FROM du_type du
WHERE
  rn.room_id IN (SELECT id FROM dayuse_rooms)
  AND rn.room_type_id IS DISTINCT FROM du.id;

-- 5) Enforce split at DB level for all future writes
CREATE OR REPLACE FUNCTION public.enforce_dayuse_room_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_dayuse_type_id bigint;
BEGIN
  SELECT id INTO v_dayuse_type_id
  FROM public.room_types
  WHERE code = 'DU'
  LIMIT 1;

  IF v_dayuse_type_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- If flagged day-use, always lock room_type to DU.
  IF COALESCE(NEW.is_dayuse, false) = true THEN
    NEW.room_type_id := v_dayuse_type_id;
    NEW.is_dayuse := true;
    RETURN NEW;
  END IF;

  -- If DU type is selected, force day-use flag on.
  IF NEW.room_type_id = v_dayuse_type_id THEN
    NEW.is_dayuse := true;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rooms_enforce_dayuse_room_type ON public.rooms;
CREATE TRIGGER trg_rooms_enforce_dayuse_room_type
BEFORE INSERT OR UPDATE OF room_type_id, is_dayuse
ON public.rooms
FOR EACH ROW
EXECUTE FUNCTION public.enforce_dayuse_room_type();

COMMIT;
