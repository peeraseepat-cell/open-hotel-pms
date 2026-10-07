-- =============================================================
-- Migration: Phase 11B - Profile Lifecycle + Duplicate Control
-- Date: 2026-03-05
-- =============================================================

-- 1A) guest_profiles expansion
ALTER TABLE public.guest_profiles
  ADD COLUMN IF NOT EXISTS gender text,
  ADD COLUMN IF NOT EXISTS id_type text,
  ADD COLUMN IF NOT EXISTS id_number text,
  ADD COLUMN IF NOT EXISTS nationality_code text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS whatsapp text,
  ADD COLUMN IF NOT EXISTS profile_status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES public.guest_profiles(id),
  ADD COLUMN IF NOT EXISTS do_not_merge boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_stay_date date;

-- Keep existing semantics in codebase: gender = M/F/Other
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_gender') THEN
    ALTER TABLE public.guest_profiles
      ADD CONSTRAINT chk_gender
      CHECK (gender IS NULL OR gender IN ('M', 'F', 'Other'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_id_type') THEN
    ALTER TABLE public.guest_profiles
      ADD CONSTRAINT chk_id_type
      CHECK (id_type IS NULL OR id_type IN ('thai_id', 'passport', 'other'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_profile_status') THEN
    ALTER TABLE public.guest_profiles
      ADD CONSTRAINT chk_profile_status
      CHECK (profile_status IN ('draft', 'verified', 'merged', 'blacklisted'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_id_number_requires_type') THEN
    ALTER TABLE public.guest_profiles
      ADD CONSTRAINT chk_id_number_requires_type
      CHECK (id_number IS NULL OR id_type IS NOT NULL);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_profiles_id_number_unique
  ON public.guest_profiles (id_type, id_number)
  WHERE id_number IS NOT NULL
    AND id_type IS NOT NULL
    AND profile_status <> 'merged';

-- 1B) profile_match_scores
CREATE TABLE IF NOT EXISTS public.profile_match_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_a uuid NOT NULL REFERENCES public.guest_profiles(id) ON DELETE CASCADE,
  profile_b uuid NOT NULL REFERENCES public.guest_profiles(id) ON DELETE CASCADE,
  score numeric(5,2) NOT NULL,
  match_fields jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'merged', 'dismissed', 'do_not_merge')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT no_self_match CHECK (profile_a <> profile_b),
  CONSTRAINT unique_match_pair UNIQUE (profile_a, profile_b)
);

-- 1C) reservation_guests (accompanying)
CREATE TABLE IF NOT EXISTS public.reservation_guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  guest_profile_id uuid NOT NULL REFERENCES public.guest_profiles(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'accompanying'
    CHECK (role IN ('primary', 'accompanying')),
  display_order smallint NOT NULL DEFAULT 1
    CHECK (display_order BETWEEN 1 AND 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unique_guest_per_reservation UNIQUE (reservation_id, guest_profile_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_primary_guest
  ON public.reservation_guests (reservation_id)
  WHERE role = 'primary';

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_accompanying_order
  ON public.reservation_guests (reservation_id, display_order)
  WHERE role = 'accompanying';

-- 1D) Backfill nationality_code + country from legacy nationality
UPDATE public.guest_profiles
SET
  nationality_code = CASE UPPER(TRIM(nationality))
    WHEN 'THA' THEN 'THA' WHEN 'THAI' THEN 'THA' WHEN 'THAILAND' THEN 'THA'
    WHEN 'GBR' THEN 'GBR' WHEN 'BRITISH' THEN 'GBR' WHEN 'UK' THEN 'GBR'
    WHEN 'USA' THEN 'USA' WHEN 'AMERICAN' THEN 'USA' WHEN 'US' THEN 'USA'
    WHEN 'JPN' THEN 'JPN' WHEN 'JAPANESE' THEN 'JPN' WHEN 'JAPAN' THEN 'JPN'
    WHEN 'KOR' THEN 'KOR' WHEN 'KOREAN' THEN 'KOR'
    WHEN 'CHN' THEN 'CHN' WHEN 'CHINESE' THEN 'CHN' WHEN 'CHINA' THEN 'CHN'
    WHEN 'AUS' THEN 'AUS' WHEN 'AUSTRALIAN' THEN 'AUS'
    WHEN 'DEU' THEN 'DEU' WHEN 'GERMAN' THEN 'DEU' WHEN 'GERMANY' THEN 'DEU'
    WHEN 'FRA' THEN 'FRA' WHEN 'FRENCH' THEN 'FRA' WHEN 'FRANCE' THEN 'FRA'
    WHEN 'RUS' THEN 'RUS' WHEN 'RUSSIAN' THEN 'RUS'
    WHEN 'IND' THEN 'IND' WHEN 'INDIAN' THEN 'IND'
    ELSE UPPER(TRIM(nationality))
  END,
  country = CASE UPPER(TRIM(nationality))
    WHEN 'THA' THEN 'Thailand' WHEN 'THAI' THEN 'Thailand' WHEN 'THAILAND' THEN 'Thailand'
    WHEN 'GBR' THEN 'United Kingdom' WHEN 'BRITISH' THEN 'United Kingdom' WHEN 'UK' THEN 'United Kingdom'
    WHEN 'USA' THEN 'United States' WHEN 'AMERICAN' THEN 'United States' WHEN 'US' THEN 'United States'
    WHEN 'JPN' THEN 'Japan' WHEN 'JAPANESE' THEN 'Japan' WHEN 'JAPAN' THEN 'Japan'
    WHEN 'KOR' THEN 'South Korea' WHEN 'KOREAN' THEN 'South Korea'
    WHEN 'CHN' THEN 'China' WHEN 'CHINESE' THEN 'China' WHEN 'CHINA' THEN 'China'
    WHEN 'AUS' THEN 'Australia' WHEN 'AUSTRALIAN' THEN 'Australia'
    WHEN 'DEU' THEN 'Germany' WHEN 'GERMAN' THEN 'Germany' WHEN 'GERMANY' THEN 'Germany'
    WHEN 'FRA' THEN 'France' WHEN 'FRENCH' THEN 'France' WHEN 'FRANCE' THEN 'France'
    WHEN 'RUS' THEN 'Russia' WHEN 'RUSSIAN' THEN 'Russia'
    WHEN 'IND' THEN 'India' WHEN 'INDIAN' THEN 'India'
    ELSE nationality
  END
WHERE nationality IS NOT NULL
  AND nationality_code IS NULL;

-- 1E) Atomic merge RPC
CREATE OR REPLACE FUNCTION public.merge_guest_profiles(
  p_master_id uuid,
  p_source_id uuid,
  p_reason text DEFAULT 'manual_merge'
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_master public.guest_profiles%ROWTYPE;
  v_source public.guest_profiles%ROWTYPE;
BEGIN
  SELECT * INTO v_master
  FROM public.guest_profiles
  WHERE id = p_master_id
  FOR UPDATE;

  SELECT * INTO v_source
  FROM public.guest_profiles
  WHERE id = p_source_id
  FOR UPDATE;

  IF v_master.id IS NULL THEN
    RAISE EXCEPTION 'Master profile not found';
  END IF;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'Source profile not found';
  END IF;
  IF p_master_id = p_source_id THEN
    RAISE EXCEPTION 'Cannot merge profile with itself';
  END IF;
  IF v_master.do_not_merge OR v_source.do_not_merge THEN
    RAISE EXCEPTION 'Profile has do_not_merge flag';
  END IF;
  IF v_source.profile_status = 'merged' THEN
    RAISE EXCEPTION 'Source already merged';
  END IF;

  UPDATE public.reservations
  SET guest_profile_id = p_master_id
  WHERE guest_profile_id = p_source_id;

  UPDATE public.transfers
  SET guest_profile_id = p_master_id
  WHERE guest_profile_id = p_source_id;

  UPDATE public.transfer_transactions
  SET guest_profile_id = p_master_id
  WHERE guest_profile_id = p_source_id;

  UPDATE public.commission_ledger
  SET guest_profile_id = p_master_id
  WHERE guest_profile_id = p_source_id;

  UPDATE public.tip_ledger
  SET guest_profile_id = p_master_id
  WHERE guest_profile_id = p_source_id;

  -- reservation_guests: remove source rows that would violate unique constraints
  DELETE FROM public.reservation_guests src
  USING public.reservation_guests other_row
  WHERE src.guest_profile_id = p_source_id
    AND src.reservation_id = other_row.reservation_id
    AND other_row.guest_profile_id <> p_source_id
    AND (
      other_row.guest_profile_id = p_master_id
      OR (
        src.role = 'accompanying'
        AND other_row.role = 'accompanying'
        AND src.display_order = other_row.display_order
      )
      OR (src.role = 'primary' AND other_row.role = 'primary')
    );

  UPDATE public.reservation_guests
  SET guest_profile_id = p_master_id
  WHERE guest_profile_id = p_source_id;

  UPDATE public.guest_profiles
  SET
    profile_status = 'merged',
    merged_into = p_master_id,
    updated_at = now()
  WHERE id = p_source_id;

  UPDATE public.guest_profiles
  SET
    stay_count = (
      SELECT count(*)
      FROM public.reservations
      WHERE guest_profile_id = p_master_id
        AND status <> 'cancelled'
    ),
    updated_at = now()
  WHERE id = p_master_id;

  UPDATE public.profile_match_scores
  SET status = 'merged'
  WHERE (profile_a = p_source_id OR profile_b = p_source_id)
    AND status = 'pending';

  INSERT INTO public.audit_logs (action, entity_type, entity_id, before_json, after_json, change_reason)
  VALUES (
    'profile_merged',
    'guest_profiles',
    p_master_id::text,
    jsonb_build_object('source_id', p_source_id, 'source_name', concat(v_source.first_name, ' ', v_source.last_name)),
    jsonb_build_object('master_id', p_master_id, 'master_name', concat(v_master.first_name, ' ', v_master.last_name)),
    p_reason
  );

  RETURN jsonb_build_object(
    'success', true,
    'master_id', p_master_id,
    'source_id', p_source_id
  );
END;
$$;

-- 1F) RLS + service role policy
ALTER TABLE public.profile_match_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_full ON public.profile_match_scores;
CREATE POLICY service_full
  ON public.profile_match_scores
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

ALTER TABLE public.reservation_guests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_full ON public.reservation_guests;
CREATE POLICY service_full
  ON public.reservation_guests
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
