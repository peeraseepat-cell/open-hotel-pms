-- =============================================================
-- Migration: Room Assignment, Room Features, and Room Blocks
-- Created: 2026-02-24
-- =============================================================

-- ── 1. Enums ──────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'room_block_type') THEN
    CREATE TYPE public.room_block_type AS ENUM ('OOO', 'OOS');
  END IF;
END $$;

-- ── 2. Room Features (Characteristics) ────────────────────────

CREATE TABLE IF NOT EXISTS public.room_features (
    code text PRIMARY KEY,        
    name text NOT NULL,
    category text NOT NULL,       -- e.g., 'View', 'Bedding', 'Location', 'Smoking', 'Misc'
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.room_features ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role full access" ON public.room_features FOR ALL USING (true);

-- Seed basic features
INSERT INTO public.room_features (code, name, category) VALUES
  ('BALC', 'Balcony', 'View'),
  ('SEA', 'Sea View', 'View'),
  ('POOL', 'Pool Access', 'View'),
  ('HIGH', 'High Floor', 'Location'),
  ('LOW', 'Low Floor', 'Location'),
  ('CORNER', 'Corner Room', 'Location'),
  ('NS', 'Non-Smoking', 'Smoking'),
  ('SMOKE', 'Smoking Allowed', 'Smoking'),
  ('KING', 'King Bed', 'Bedding'),
  ('TWIN', 'Twin Beds', 'Bedding'),
  ('QUIET', 'Quiet Room', 'Location'),
  ('ACC', 'Accessible', 'Misc'),
  ('CONN', 'Connecting Room', 'Misc')
ON CONFLICT (code) DO UPDATE 
  SET name = EXCLUDED.name, category = EXCLUDED.category;

-- ── 3. Map Features to Physical Rooms ─────────────────────────

CREATE TABLE IF NOT EXISTS public.room_feature_mapping (
    room_number text NOT NULL REFERENCES public.rooms(room_number) ON DELETE CASCADE,
    feature_code text NOT NULL REFERENCES public.room_features(code) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (room_number, feature_code)
);

ALTER TABLE public.room_feature_mapping ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role full access" ON public.room_feature_mapping FOR ALL USING (true);

-- ── 4. Guest Preferences for a specific reservation ───────────

CREATE TABLE IF NOT EXISTS public.reservation_preferences (
    reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
    feature_code text NOT NULL REFERENCES public.room_features(code) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (reservation_id, feature_code)
);

ALTER TABLE public.reservation_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role full access" ON public.reservation_preferences FOR ALL USING (true);

-- ── 5. Room Blocks (Out of Order / Out of Service) ────────────

CREATE TABLE IF NOT EXISTS public.room_blocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_number text REFERENCES public.rooms(room_number) ON DELETE CASCADE,
    block_type public.room_block_type NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES public.profiles(user_id)
);

CREATE INDEX IF NOT EXISTS idx_room_blocks_dates 
  ON public.room_blocks (start_date, end_date);

ALTER TABLE public.room_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role full access" ON public.room_blocks FOR ALL USING (true);

-- ── 6. Modify reservation_nights for Floating Assignment ──────

-- Add room_type_id so we know what type they booked, even if room_id is NULL
ALTER TABLE public.reservation_nights
  ADD COLUMN IF NOT EXISTS room_type_id bigint REFERENCES public.room_types(id);

-- Backfill room_type_id from the assigned room
UPDATE public.reservation_nights rn
SET room_type_id = r.room_type_id
FROM public.rooms r
WHERE rn.room_id = r.id AND rn.room_type_id IS NULL;

-- Now make room_id optional (unassigned/floating reservations)
ALTER TABLE public.reservation_nights
  ALTER COLUMN room_id DROP NOT NULL;

-- ── Done ─────────────────────────────────────────────────────
