-- =============================================================
-- Phase A: UUID Standardization (Idempotent version)
-- Migrate room_feature_mapping + room_blocks from room_number text FK → room_id UUID
-- Safe to run even if columns already exist or were never created
-- Created: 2026-02-25  Fixed: 2026-02-25
-- =============================================================

BEGIN;

-- ── 1. room_feature_mapping ──────────────────────────────────

-- Step 1a: Add room_id column if not present
ALTER TABLE public.room_feature_mapping
  ADD COLUMN IF NOT EXISTS room_id uuid REFERENCES public.rooms(id) ON DELETE CASCADE;

-- Step 1b–1f: Only backfill from room_number if that column still exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'room_feature_mapping'
      AND column_name  = 'room_number'
  ) THEN
    -- Backfill room_id from rooms.room_number
    UPDATE public.room_feature_mapping rfm
    SET room_id = r.id
    FROM public.rooms r
    WHERE r.room_number = rfm.room_number
      AND rfm.room_id IS NULL;

    -- Drop orphan rows
    DELETE FROM public.room_feature_mapping WHERE room_id IS NULL;

    -- Drop old PK and replace
    ALTER TABLE public.room_feature_mapping DROP CONSTRAINT IF EXISTS room_feature_mapping_pkey;
    ALTER TABLE public.room_feature_mapping ADD PRIMARY KEY (room_id, feature_code);

    -- Drop old column
    ALTER TABLE public.room_feature_mapping DROP COLUMN room_number;
  END IF;
END $$;

-- Ensure room_id is NOT NULL (in case backfill wasn't needed but col was just added)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'room_feature_mapping'
      AND column_name  = 'room_id'
      AND is_nullable  = 'YES'
  ) THEN
    -- Only set NOT NULL if all rows have room_id
    IF NOT EXISTS (SELECT 1 FROM public.room_feature_mapping WHERE room_id IS NULL) THEN
      ALTER TABLE public.room_feature_mapping ALTER COLUMN room_id SET NOT NULL;
    END IF;
  END IF;
END $$;

-- Ensure PK exists
ALTER TABLE public.room_feature_mapping DROP CONSTRAINT IF EXISTS room_feature_mapping_pkey;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.room_feature_mapping'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE public.room_feature_mapping ADD PRIMARY KEY (room_id, feature_code);
  END IF;
END $$;

-- ── 2. room_blocks ───────────────────────────────────────────

-- Step 2a: Add room_id column if not present
ALTER TABLE public.room_blocks
  ADD COLUMN IF NOT EXISTS room_id uuid REFERENCES public.rooms(id) ON DELETE CASCADE;

-- Step 2b–2c: Only backfill from room_number if that column still exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'room_blocks'
      AND column_name  = 'room_number'
  ) THEN
    -- Backfill room_id from rooms.room_number
    UPDATE public.room_blocks rb
    SET room_id = r.id
    FROM public.rooms r
    WHERE r.room_number = rb.room_number
      AND rb.room_id IS NULL;

    -- Drop old column
    ALTER TABLE public.room_blocks DROP COLUMN room_number;
  END IF;
END $$;

-- ── 3. reservation_preferences — already uses reservation_id (UUID), no change needed

COMMIT;
