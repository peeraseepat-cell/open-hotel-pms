-- Phase 51: Guest Profile Migration

-- 1) Add legacy_night_count to guest_profiles
ALTER TABLE public.guest_profiles
  ADD COLUMN IF NOT EXISTS legacy_night_count integer DEFAULT NULL;

-- 2) Legacy stays (historical only, read-only context data)
CREATE TABLE IF NOT EXISTS public.legacy_stays (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_profile_id uuid NOT NULL REFERENCES public.guest_profiles(id) ON DELETE CASCADE,
  date_in          date NOT NULL,
  date_out         date NOT NULL,
  nights           integer NOT NULL DEFAULT 1,
  room_number      text,
  source_file      text,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_legacy_stays_guest
  ON public.legacy_stays(guest_profile_id);

CREATE INDEX IF NOT EXISTS idx_legacy_stays_date
  ON public.legacy_stays(date_in DESC);

ALTER TABLE public.legacy_stays ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legacy_stays_service_role ON public.legacy_stays;
CREATE POLICY legacy_stays_service_role
  ON public.legacy_stays
  FOR ALL
  USING (true)
  WITH CHECK (true);

