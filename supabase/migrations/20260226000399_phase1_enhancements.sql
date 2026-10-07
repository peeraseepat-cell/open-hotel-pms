-- =============================================================
-- Migration: Phase 1 Enhancements
-- Date:      2026-02-26
-- Purpose:
--   1. Add discount fields to reservations
--   2. Add checked_in_at timestamp
--   3. Add guest identity fields (address, ID card)
--   4. RLS policies for new tables
-- =============================================================

-- 1. Discount fields on reservations
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS discount_percent numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_reason  text;

-- 2. Check-in timestamp
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;

-- Index for quickly finding checked-in reservations
CREATE INDEX IF NOT EXISTS idx_reservations_checked_in
  ON public.reservations (checked_in_at)
  WHERE checked_in_at IS NOT NULL;

-- 3. Guest identity fields (for check-in ID/passport flow)
ALTER TABLE public.guest_profiles
  ADD COLUMN IF NOT EXISTS id_card_number text,
  ADD COLUMN IF NOT EXISTS address_line1  text,
  ADD COLUMN IF NOT EXISTS address_line2  text,
  ADD COLUMN IF NOT EXISTS city           text,
  ADD COLUMN IF NOT EXISTS province       text,
  ADD COLUMN IF NOT EXISTS postal_code    text,
  ADD COLUMN IF NOT EXISTS country        text;

-- 4. Stay count on guest profiles (for loyalty tracking)
ALTER TABLE public.guest_profiles
  ADD COLUMN IF NOT EXISTS stay_count integer NOT NULL DEFAULT 0;

-- =============================================================
-- VERIFY:
--   SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'reservations'
--     AND column_name IN ('discount_percent', 'discount_reason', 'checked_in_at');
--
--   SELECT column_name, data_type
--   FROM information_schema.columns
--   WHERE table_name = 'guest_profiles'
--     AND column_name IN ('id_card_number', 'address_line1', 'country', 'stay_count');
-- =============================================================
