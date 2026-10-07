-- Phase 80 — Thai prepayment alert detection accepts ISO alpha-3 nationality.
--
-- Context:
-- Some Thai guests have English names and guest_profiles.nationality_code = 'THA'.
-- Phase 74 only matched nationality_code = 'TH', so prepayment alerts could be
-- missed unless the name contained Thai text or reservations.is_thai_manual was set.

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

    -- (2) nationality_code = TH / THA
    IF upper(trim(coalesce(v_gp.nationality_code, ''))) IN ('TH', 'THA') THEN
      RETURN true;
    END IF;

    -- (3) nationality free-text
    IF lower(trim(coalesce(v_gp.nationality, ''))) IN ('thai', 'thailand', 'ไทย', 'ประเทศไทย') THEN
      RETURN true;
    END IF;

    -- (4) profile name regex (Thai Unicode)
    IF coalesce(v_gp.first_name, '') ~ '[\u0E00-\u0E7F]'
       OR coalesce(v_gp.last_name, '') ~ '[\u0E00-\u0E7F]' THEN
      RETURN true;
    END IF;
  END IF;

  -- (5) reservation guest_name fallback for bookings without a linked profile.
  IF coalesce(v_res.guest_name, '') ~ '[\u0E00-\u0E7F]' THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_alert_is_thai_customer(uuid) TO authenticated;
