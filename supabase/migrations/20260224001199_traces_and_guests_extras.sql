-- =============================================================
-- Migration: Add extra fields to Guest Profiles
-- Created: 2026-02-24
-- =============================================================

-- Add the sequence for the auto-generated member number
CREATE SEQUENCE IF NOT EXISTS public.guest_member_seq START 10001;

-- Add the new columns to the guest_profiles table
ALTER TABLE public.guest_profiles
ADD COLUMN IF NOT EXISTS gender             text,
ADD COLUMN IF NOT EXISTS car_registration   text,
ADD COLUMN IF NOT EXISTS line_id            text,
ADD COLUMN IF NOT EXISTS member_no          text UNIQUE;

-- We can set a default value for new records directly using the sequence,
-- but since some records might already exist without a member_no,
-- let's backfill existing records and set a default.

-- 1. Set the default for future inserts
ALTER TABLE public.guest_profiles
ALTER COLUMN member_no SET DEFAULT 'MEM-' || nextval('public.guest_member_seq')::text;

-- 2. Backfill existing records that don't have a member_no
UPDATE public.guest_profiles
SET member_no = 'MEM-' || nextval('public.guest_member_seq')::text
WHERE member_no IS NULL;
