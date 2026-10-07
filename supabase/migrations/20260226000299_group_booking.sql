-- Group Booking table
CREATE TABLE IF NOT EXISTS booking_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_code  TEXT NOT NULL UNIQUE,
  group_name  TEXT NOT NULL,            -- e.g. "Wang Family Reunion"
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  source      booking_source NOT NULL DEFAULT 'direct',
  note        TEXT,
  total_rooms INT NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','cancelled','completed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Link reservations to group
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS booking_group_id UUID REFERENCES booking_groups(id);

CREATE INDEX IF NOT EXISTS idx_reservations_group
  ON reservations(booking_group_id) WHERE booking_group_id IS NOT NULL;

-- Auto-generate group code
CREATE OR REPLACE FUNCTION generate_group_code()
RETURNS TRIGGER AS $$
BEGIN
  NEW.group_code := 'GRP-' || TO_CHAR(NOW(), 'YYMMDD') || '-' ||
    LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_group_code
  BEFORE INSERT ON booking_groups
  FOR EACH ROW
  WHEN (NEW.group_code IS NULL OR NEW.group_code = '')
  EXECUTE FUNCTION generate_group_code();
