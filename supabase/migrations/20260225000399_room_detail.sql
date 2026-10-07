-- =============================================================
-- Phase B: Room Detail System
-- bed_types, room_beds, room_detail, deduction system, scoring_config
-- Created: 2026-02-25
-- Fixed: removed unsupported IF NOT EXISTS from CREATE POLICY
-- =============================================================

BEGIN;

-- ── 1. Occupancy fields on room_types ────────────────────────

ALTER TABLE public.room_types
  ADD COLUMN IF NOT EXISTS max_guests            int  NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS extra_guest_charge    numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS child_free_under_cm   int NOT NULL DEFAULT 110,
  ADD COLUMN IF NOT EXISTS child_extra_charge    numeric(10,2) NOT NULL DEFAULT 100;

-- ── 2. Bed Types (lookup) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.bed_types (
  code      text PRIMARY KEY,     -- 'KING', 'QUEEN', 'SINGLE'
  name      text NOT NULL,        -- 'King Bed 6ft'
  width_ft  numeric(3,1) NOT NULL -- 6.0 / 5.0 / 3.5
);

INSERT INTO public.bed_types (code, name, width_ft) VALUES
  ('KING',   'King Bed 6ft',      6.0),
  ('QUEEN',  'Queen Bed 5ft',     5.0),
  ('SINGLE', 'Single Bed 3.5ft',  3.5)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name, width_ft = EXCLUDED.width_ft;

ALTER TABLE public.bed_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bed_types_read"  ON public.bed_types;
DROP POLICY IF EXISTS "bed_types_write" ON public.bed_types;
CREATE POLICY "bed_types_read" ON public.bed_types FOR SELECT TO authenticated USING (true);
CREATE POLICY "bed_types_write" ON public.bed_types FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['admin','supervisor']::public.user_role[]))
  WITH CHECK (public.has_any_role(ARRAY['admin','supervisor']::public.user_role[]));

-- ── 3. Room Bed Configuration (per physical room) ────────────

CREATE TABLE IF NOT EXISTS public.room_beds (
  room_id       uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  bed_type_code text NOT NULL REFERENCES public.bed_types(code) ON DELETE CASCADE,
  quantity      int  NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  PRIMARY KEY (room_id, bed_type_code)
);

ALTER TABLE public.room_beds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "room_beds_read"  ON public.room_beds;
DROP POLICY IF EXISTS "room_beds_write" ON public.room_beds;
CREATE POLICY "room_beds_read" ON public.room_beds FOR SELECT TO authenticated USING (true);
CREATE POLICY "room_beds_write" ON public.room_beds FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['admin','supervisor']::public.user_role[]))
  WITH CHECK (public.has_any_role(ARRAY['admin','supervisor']::public.user_role[]));

-- ── 4. Room Detail (Condition + Quality Score) ───────────────

CREATE TABLE IF NOT EXISTS public.room_detail (
  room_id         uuid PRIMARY KEY REFERENCES public.rooms(id) ON DELETE CASCADE,

  -- Base ratings 1-5 (default 5 = perfect before any deduction)
  ac_base         int NOT NULL DEFAULT 5 CHECK (ac_base BETWEEN 1 AND 5),
  furniture_base  int NOT NULL DEFAULT 5 CHECK (furniture_base BETWEEN 1 AND 5),
  bathroom_base   int NOT NULL DEFAULT 5 CHECK (bathroom_base BETWEEN 1 AND 5),
  wifi_base       int NOT NULL DEFAULT 5 CHECK (wifi_base BETWEEN 1 AND 5),

  -- Cumulative deductions per category (sum of room_condition_deductions)
  ac_deduct       numeric(4,1) NOT NULL DEFAULT 0,
  furniture_deduct numeric(4,1) NOT NULL DEFAULT 0,
  bathroom_deduct numeric(4,1) NOT NULL DEFAULT 0,
  wifi_deduct     numeric(4,1) NOT NULL DEFAULT 0,

  -- Equipment / info fields
  ac_model        text,
  last_renovated  date,
  tv_size_inch    int,
  floor_number    int,
  extra_notes     text,

  -- Auto-computed quality score (2.0–10.0)
  -- Each category net = GREATEST(1, base - deduct), then avg × 2
  quality_score   numeric(4,2) GENERATED ALWAYS AS (
    (
      (GREATEST(1.0, ac_base::numeric - ac_deduct) +
       GREATEST(1.0, furniture_base::numeric - furniture_deduct) +
       GREATEST(1.0, bathroom_base::numeric - bathroom_deduct) +
       GREATEST(1.0, wifi_base::numeric - wifi_deduct)) / 4.0
    ) * 2.0
  ) STORED,

  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.room_detail ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "room_detail_read"  ON public.room_detail;
DROP POLICY IF EXISTS "room_detail_write" ON public.room_detail;
CREATE POLICY "room_detail_read" ON public.room_detail FOR SELECT TO authenticated USING (true);
CREATE POLICY "room_detail_write" ON public.room_detail FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['admin','supervisor']::public.user_role[]))
  WITH CHECK (public.has_any_role(ARRAY['admin','supervisor']::public.user_role[]));

-- ── 5. Condition Deduction Templates (Admin-managed presets) ─

CREATE TABLE IF NOT EXISTS public.condition_deduction_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category      text NOT NULL CHECK (category IN ('ac','furniture','bathroom','wifi')),
  label         text NOT NULL,              -- 'โต๊ะมีรอย > 30%', 'ก๊อกรั่ว'
  deduct_points numeric(3,1) NOT NULL CHECK (deduct_points > 0 AND deduct_points <= 5),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category, label)
);

-- Seed common deductions
INSERT INTO public.condition_deduction_templates (category, label, deduct_points) VALUES
  ('ac',        'แอร์เย็นน้อยกว่าปกติ',          1.0),
  ('ac',        'แอร์มีเสียงดัง',                 0.5),
  ('ac',        'รอยสนิมที่ตัวแอร์',              1.0),
  ('furniture', 'โต๊ะมีรอยขีดข่วน > 30%',        1.0),
  ('furniture', 'เก้าอี้ขาหัก/โยก',               2.0),
  ('furniture', 'ผ้าม่านซีดหรือขาด',              0.5),
  ('furniture', 'เฟอร์นิเจอร์เก่ามากกว่า 10 ปี', 1.5),
  ('bathroom',  'ก๊อกน้ำรั่ว',                    1.0),
  ('bathroom',  'กระเบื้องแตก',                   1.5),
  ('bathroom',  'ฝักบัวอุดตัน',                   0.5),
  ('wifi',      'สัญญาณอ่อน (< 1 Mbps)',          2.0),
  ('wifi',      'สัญญาณกลาง (1-5 Mbps)',          1.0)
ON CONFLICT (category, label) DO NOTHING;

ALTER TABLE public.condition_deduction_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "deduct_templates_read"  ON public.condition_deduction_templates;
DROP POLICY IF EXISTS "deduct_templates_write" ON public.condition_deduction_templates;
CREATE POLICY "deduct_templates_read" ON public.condition_deduction_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "deduct_templates_write" ON public.condition_deduction_templates FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['admin','supervisor']::public.user_role[]))
  WITH CHECK (public.has_any_role(ARRAY['admin','supervisor']::public.user_role[]));

-- ── 6. Room Condition Deductions (applied to each room) ──────

CREATE TABLE IF NOT EXISTS public.room_condition_deductions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  template_id   uuid REFERENCES public.condition_deduction_templates(id) ON DELETE SET NULL,
  category      text NOT NULL CHECK (category IN ('ac','furniture','bathroom','wifi')),
  label         text NOT NULL,
  deduct_points numeric(3,1) NOT NULL CHECK (deduct_points > 0),
  noted_at      timestamptz NOT NULL DEFAULT now(),
  noted_by      uuid REFERENCES public.profiles(user_id)
);

CREATE INDEX IF NOT EXISTS idx_room_cond_deductions_room ON public.room_condition_deductions(room_id);

ALTER TABLE public.room_condition_deductions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "room_deductions_read"  ON public.room_condition_deductions;
DROP POLICY IF EXISTS "room_deductions_write" ON public.room_condition_deductions;
CREATE POLICY "room_deductions_read" ON public.room_condition_deductions FOR SELECT TO authenticated USING (true);
CREATE POLICY "room_deductions_write" ON public.room_condition_deductions FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['admin','supervisor']::public.user_role[]))
  WITH CHECK (public.has_any_role(ARRAY['admin','supervisor']::public.user_role[]));

-- ── 7. Trigger: Update room_detail.xx_deduct when deductions change ─

CREATE OR REPLACE FUNCTION public.sync_room_deduct_totals()
RETURNS TRIGGER AS $$
DECLARE
  v_room_id uuid;
BEGIN
  v_room_id := COALESCE(NEW.room_id, OLD.room_id);

  INSERT INTO public.room_detail (room_id, ac_deduct, furniture_deduct, bathroom_deduct, wifi_deduct)
  SELECT
    v_room_id,
    COALESCE(SUM(CASE WHEN category = 'ac'        THEN deduct_points ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN category = 'furniture' THEN deduct_points ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN category = 'bathroom'  THEN deduct_points ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN category = 'wifi'      THEN deduct_points ELSE 0 END), 0)
  FROM public.room_condition_deductions
  WHERE room_id = v_room_id
  ON CONFLICT (room_id) DO UPDATE SET
    ac_deduct        = EXCLUDED.ac_deduct,
    furniture_deduct = EXCLUDED.furniture_deduct,
    bathroom_deduct  = EXCLUDED.bathroom_deduct,
    wifi_deduct      = EXCLUDED.wifi_deduct,
    updated_at       = now();

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_deduct_on_insert ON public.room_condition_deductions;
CREATE TRIGGER trg_sync_deduct_on_insert
  AFTER INSERT OR DELETE ON public.room_condition_deductions
  FOR EACH ROW EXECUTE FUNCTION public.sync_room_deduct_totals();

-- ── 8. Room Stay History (HK bridge for Usage Balance) ────────

CREATE TABLE IF NOT EXISTS public.room_stay_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  stayed_at   date NOT NULL,
  source      text NOT NULL DEFAULT 'pms' CHECK (source IN ('pms', 'maintenance_app')),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, stayed_at, source)
);

CREATE INDEX IF NOT EXISTS idx_stay_history_room ON public.room_stay_history(room_id);

ALTER TABLE public.room_stay_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stay_history_read"  ON public.room_stay_history;
DROP POLICY IF EXISTS "stay_history_write" ON public.room_stay_history;
CREATE POLICY "stay_history_read" ON public.room_stay_history FOR SELECT TO authenticated USING (true);
CREATE POLICY "stay_history_write" ON public.room_stay_history FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['admin','frontdesk','supervisor']::public.user_role[]))
  WITH CHECK (public.has_any_role(ARRAY['admin','frontdesk','supervisor']::public.user_role[]));

-- ── 9. Scoring Config ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.scoring_config (
  key   text PRIMARY KEY,
  value numeric NOT NULL DEFAULT 0,
  label text
);

INSERT INTO public.scoring_config (key, value, label) VALUES
  ('w_preference', 40, 'Preference Match %'),
  ('w_bed',        25, 'Bed Match %'),
  ('w_quality',    20, 'Room Quality %'),
  ('w_balance',    10, 'Usage Balance %'),
  ('w_hk',          5, 'HK Status %')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.scoring_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "scoring_config_read"  ON public.scoring_config;
DROP POLICY IF EXISTS "scoring_config_write" ON public.scoring_config;
CREATE POLICY "scoring_config_read" ON public.scoring_config FOR SELECT TO authenticated USING (true);
CREATE POLICY "scoring_config_write" ON public.scoring_config FOR ALL TO authenticated
  USING (public.has_any_role(ARRAY['admin']::public.user_role[]))
  WITH CHECK (public.has_any_role(ARRAY['admin']::public.user_role[]));

COMMIT;
