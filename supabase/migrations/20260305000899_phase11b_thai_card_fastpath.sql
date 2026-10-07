-- =============================================================
-- Migration: Phase 11B Thai Card Fast Path
-- Date: 2026-03-04
-- Purpose:
--   1) Backfill legacy Thai ID rows into unified (id_type, id_number)
--   2) Add fast lookup index for Thai card check-in flow
-- =============================================================

-- Backfill from legacy id_card_number when id_number is empty.
UPDATE public.guest_profiles
SET
  id_type = COALESCE(NULLIF(id_type, ''), 'thai_id'),
  id_number = regexp_replace(COALESCE(id_card_number, ''), '\D', '', 'g')
WHERE COALESCE(NULLIF(id_card_number, ''), '') <> ''
  AND COALESCE(NULLIF(id_number, ''), '') = '';

-- Fast exact-lookup path for card reader flow.
CREATE INDEX IF NOT EXISTS idx_guest_profiles_thai_id_lookup
  ON public.guest_profiles (id_number)
  WHERE id_type = 'thai_id'
    AND profile_status <> 'merged';
