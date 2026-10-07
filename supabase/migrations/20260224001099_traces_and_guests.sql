-- =============================================================
-- Migration: Traces System + Guest Profiles
-- Created: 2026-02-24
-- =============================================================

-- ── 1. Enums ──────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trace_dept') THEN
    CREATE TYPE public.trace_dept AS ENUM ('FD', 'HK', 'MAINT', 'MGMT', 'OTHER');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trace_status') THEN
    CREATE TYPE public.trace_status AS ENUM ('open', 'done', 'cancelled');
  END IF;
END $$;

-- ── 2. Guest Profiles ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.guest_profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Identity
  first_name    text,
  last_name     text NOT NULL,
  nationality   text,
  passport_no   text,
  dob           date,

  -- Contact
  phone         text,
  email         text,

  -- Hotel fields (inspired by Opera "Preferences" + "VIP" + "Specials")
  vip_tier      text,         -- 'regular' | 'loyal' | 'vip' | 'longest'
  preferences   text,         -- e.g. "Prefers floor 3, extra pillow"
  notes         text,         -- internal staff-only notes
  blacklisted   boolean NOT NULL DEFAULT false,

  -- OCR passport raw data (from Google Vision)
  passport_raw  jsonb
);

ALTER TABLE public.guest_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role full access" ON public.guest_profiles FOR ALL USING (true);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_guest_profiles_updated_at ON public.guest_profiles;
CREATE TRIGGER trg_guest_profiles_updated_at
  BEFORE UPDATE ON public.guest_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 3. Extend reservations table ──────────────────────────────

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS guest_profile_id  uuid REFERENCES public.guest_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS adults            smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS children          smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS arrival_time      text,    -- "14:00"
  ADD COLUMN IF NOT EXISTS departure_time    text,    -- "12:00"
  ADD COLUMN IF NOT EXISTS specials          text;    -- free-text: "Anniversary, quiet room"

-- ── 4. Alert Codes (predefined list) ──────────────────────────

CREATE TABLE IF NOT EXISTS public.alert_codes (
  code        text PRIMARY KEY,
  description text NOT NULL,
  dept        public.trace_dept,
  auto_on_co  boolean NOT NULL DEFAULT false,  -- auto-show at checkout
  icon        text                             -- emoji hint for UI
);

ALTER TABLE public.alert_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role full access" ON public.alert_codes FOR ALL USING (true);

-- Seed alert codes (idempotent)
INSERT INTO public.alert_codes (code, description, dept, auto_on_co, icon) VALUES
  ('ADA',   'Guest has EU/UK/US adaptor — collect on checkout', 'FD',    true,  '🔌'),
  ('HAIR',  'Guest has hair dryer — collect on checkout',        'FD',    true,  '💇'),
  ('IRON',  'Guest has iron & board — collect on checkout',      'FD',    true,  '👔'),
  ('BED',   'Extra bed/mattress requested',                      'HK',   false,  '🛏️'),
  ('PIL',   'Extra pillow/blanket requested',                    'HK',   false,  '🛏️'),
  ('DND',   'Do Not Disturb — guest requested privacy',          'HK',   false,  '🚫'),
  ('DEP',   'Take deposit on arrival',                           'FD',   false,  '💰'),
  ('GRT',   'Manager to greet guest on arrival',                 'MGMT', false,  '🤝'),
  ('ANN',   'Anniversary — arrange celebration',                 'FD',   false,  '🎉'),
  ('BIR',   'Birthday — arrange celebration',                    'FD',   false,  '🎂'),
  ('PCP',   'Previous complaint — handle with extra care',       'MGMT', false,  '⚠️'),
  ('BOAT',  'Guest has boat transfer booked — confirm time',     'FD',   false,  '⛵'),
  ('CAR',   'Guest has car transfer booked — confirm time',      'FD',   false,  '🚗'),
  ('VIP',   'VIP Guest — priority service',                      'MGMT', false,  '⭐'),
  ('OTH',   'Other — see trace notes',                           'FD',   false,  '📋')
ON CONFLICT (code) DO UPDATE
  SET description = EXCLUDED.description,
      dept        = EXCLUDED.dept,
      auto_on_co  = EXCLUDED.auto_on_co,
      icon        = EXCLUDED.icon;

-- ── 5. Reservation Alerts (many-to-many) ──────────────────────

CREATE TABLE IF NOT EXISTS public.reservation_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id  uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  alert_code      text NOT NULL REFERENCES public.alert_codes(code) ON DELETE CASCADE,
  note            text,         -- optional custom note for this instance
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id, alert_code)
);

ALTER TABLE public.reservation_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role full access" ON public.reservation_alerts FOR ALL USING (true);

-- ── 6. Loan Items (stock management) ──────────────────────────

CREATE TABLE IF NOT EXISTS public.loan_items (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  total_qty   smallint NOT NULL DEFAULT 0,
  available   smallint NOT NULL DEFAULT 0,
  icon        text
);

ALTER TABLE public.loan_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role full access" ON public.loan_items FOR ALL USING (true);

-- Seed loan items (idempotent)
INSERT INTO public.loan_items (code, name, total_qty, available, icon) VALUES
  ('ADAPTER_EU',   'EU Adapter',          10, 10, '🔌'),
  ('ADAPTER_UK',   'UK Adapter',          10, 10, '🔌'),
  ('ADAPTER_US',   'US Adapter',           5,  5, '🔌'),
  ('HAIR_DRYER',   'Hair Dryer',           5,  5, '💇'),
  ('IRON',         'Iron & Board',         3,  3, '👔'),
  ('EXTRA_BED',    'Extra Bed/Mattress',   4,  4, '🛏️'),
  ('EXTRA_PILLOW', 'Extra Pillow',        20, 20, '🛏️'),
  ('EXTRA_TOWEL',  'Extra Towel',         30, 30, '🪥'),
  ('KETTLE',       'Electric Kettle',      5,  5, '☕'),
  ('UMBRELLA',     'Umbrella',             8,  8, '☂️'),
  ('YOGA_MAT',     'Yoga Mat',             4,  4, '🧘')
ON CONFLICT (code) DO UPDATE
  SET name      = EXCLUDED.name,
      total_qty = EXCLUDED.total_qty,
      icon      = EXCLUDED.icon;
  -- Note: available stock is NOT reset on re-run to avoid wiping live data

-- ── 7. Reservation Traces ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.reservation_traces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id  uuid NOT NULL REFERENCES public.reservations(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,                  -- staff name

  -- Oracle-inspired fields
  dept            public.trace_dept NOT NULL DEFAULT 'FD',
  trace_text      text NOT NULL,
  from_date       date NOT NULL,
  to_date         date NOT NULL,

  -- Loan item link (optional — ties into loan_items stock)
  loan_item_code  text REFERENCES public.loan_items(code) ON DELETE SET NULL,
  loan_qty        smallint NOT NULL DEFAULT 0,

  -- Resolution
  status          public.trace_status NOT NULL DEFAULT 'open',
  resolved_at     timestamptz,
  resolved_by     text
);

CREATE INDEX IF NOT EXISTS idx_reservation_traces_reservation_id
  ON public.reservation_traces (reservation_id);
CREATE INDEX IF NOT EXISTS idx_reservation_traces_from_date
  ON public.reservation_traces (from_date);
CREATE INDEX IF NOT EXISTS idx_reservation_traces_status
  ON public.reservation_traces (status);

ALTER TABLE public.reservation_traces ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role full access" ON public.reservation_traces FOR ALL USING (true);

-- ── Done ─────────────────────────────────────────────────────
