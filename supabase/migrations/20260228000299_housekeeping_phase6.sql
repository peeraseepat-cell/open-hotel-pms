-- Phase 6: Housekeeping System Foundation
-- Adds timer/NS/checklist support to housekeeping_tasks
-- Creates 7 new tables for daily plans, extra tasks, stock, checklists
begin;

-- ============================================================
-- 1. ALTER existing tables
-- ============================================================

-- housekeeping_tasks: timer tracking, no-service flag, checklist snapshot, maid name (text)
-- NOTE: assigned_maid (uuid) already exists for future auth; we add assigned_maid_name (text) for current use
ALTER TABLE public.housekeeping_tasks
  ADD COLUMN IF NOT EXISTS accumulated_ms bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_no_service boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS checklist_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS assigned_maid_name text;

-- room_types: cleaning duration per room type
ALTER TABLE public.room_types
  ADD COLUMN IF NOT EXISTS cleaning_duration_min int NOT NULL DEFAULT 60;

-- Seed cleaning durations based on REAL room type codes (from seed.sql)
-- TS=Twin Standard, DS=Double Standard, DQ=Deluxe Queen, DT=Deluxe Twin
-- JS=Junior Suite, TB=Triple Beds, FR=Family Room
UPDATE public.room_types SET cleaning_duration_min = 60  WHERE code IN ('TS', 'DS');
UPDATE public.room_types SET cleaning_duration_min = 60  WHERE code IN ('DQ', 'DT');
UPDATE public.room_types SET cleaning_duration_min = 90  WHERE code IN ('JS', 'TB');
UPDATE public.room_types SET cleaning_duration_min = 100 WHERE code = 'FR';

-- ============================================================
-- 2. CREATE new tables
-- ============================================================

-- checklist_templates: Room amenity checklist items per room type
CREATE TABLE IF NOT EXISTS public.checklist_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_type_code text NOT NULL,
  item_name text NOT NULL,
  default_quantity int NOT NULL DEFAULT 1,
  category text NOT NULL DEFAULT 'General',
  sort_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (room_type_code, item_name)
);

-- daily_plans: Maid-to-room assignment per day (priority 1-15)
CREATE TABLE IF NOT EXISTS public.daily_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_date date NOT NULL,
  room_id uuid NOT NULL REFERENCES public.rooms(id),
  assigned_maid text NOT NULL,
  priority int NOT NULL DEFAULT 1 CHECK (priority >= 1 AND priority <= 15),
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (plan_date, room_id)
);

-- extra_task_templates: Reusable extra task definitions
CREATE TABLE IF NOT EXISTS public.extra_task_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  duration_min int NOT NULL DEFAULT 60,
  category text NOT NULL DEFAULT 'General',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

-- extra_task_assignments: Daily task assignment to maid
CREATE TABLE IF NOT EXISTS public.extra_task_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_date date NOT NULL,
  template_id uuid REFERENCES public.extra_task_templates(id),
  task_name text NOT NULL,
  assigned_maid text NOT NULL DEFAULT 'Others',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','paused','done','cancelled')),
  priority int NOT NULL DEFAULT 999,
  duration_min int NOT NULL DEFAULT 60,
  started_at timestamptz,
  finished_at timestamptz,
  accumulated_ms bigint NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (assignment_date, task_name)
);

-- stock_items: Inventory levels
CREATE TABLE IF NOT EXISTS public.stock_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_name text NOT NULL UNIQUE,
  current_quantity int NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'pieces',
  reorder_level int NOT NULL DEFAULT 10,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

-- maid_cart_items: Per-maid cart inventory
CREATE TABLE IF NOT EXISTS public.maid_cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  maid_name text NOT NULL,
  item_name text NOT NULL,
  quantity int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (maid_name, item_name)
);

-- stock_transactions: Audit trail for all stock changes
CREATE TABLE IF NOT EXISTS public.stock_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_date date NOT NULL DEFAULT current_date,
  action text NOT NULL CHECK (action IN ('refill','use','extra_request','adjust')),
  maid_name text,
  item_name text NOT NULL,
  quantity_change int NOT NULL,
  room_number text,
  note text,
  actor text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

-- ============================================================
-- 3. Triggers (updated_at) using existing set_updated_at()
-- ============================================================

DROP TRIGGER IF EXISTS trg_daily_plans_updated_at ON public.daily_plans;
CREATE TRIGGER trg_daily_plans_updated_at
BEFORE UPDATE ON public.daily_plans
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_extra_task_assignments_updated_at ON public.extra_task_assignments;
CREATE TRIGGER trg_extra_task_assignments_updated_at
BEFORE UPDATE ON public.extra_task_assignments
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 4. Seed checklist_templates (Standard room — expand per type)
-- ============================================================

-- Real room type codes: TS, DS, DQ, DT, JS, TB, FR (from seed.sql)
INSERT INTO public.checklist_templates (room_type_code, item_name, default_quantity, category, sort_order) VALUES
  -- TS (Twin Standard — 2 beds, 2 guests)
  ('TS', 'Make Bed', 1, 'Bed', 1),
  ('TS', 'Change Sheets', 1, 'Bed', 2),
  ('TS', 'Pillow Case', 2, 'Bed', 3),
  ('TS', 'Bath Towel', 2, 'Bathroom', 10),
  ('TS', 'Hand Towel', 2, 'Bathroom', 11),
  ('TS', 'Floor Mat', 1, 'Bathroom', 12),
  ('TS', 'Tissue Box', 1, 'Bathroom', 13),
  ('TS', 'Toilet Paper', 1, 'Bathroom', 14),
  ('TS', 'Soap', 2, 'Amenity', 20),
  ('TS', 'Shampoo', 2, 'Amenity', 21),
  ('TS', 'Water Bottle', 2, 'Amenity', 22),
  ('TS', 'Trash Bin', 1, 'Room', 30),
  ('TS', 'Vacuum', 1, 'Room', 31),
  ('TS', 'Mop Floor', 1, 'Room', 32),
  -- DS (Double Standard — 1 bed, 2 guests)
  ('DS', 'Make Bed', 1, 'Bed', 1),
  ('DS', 'Change Sheets', 1, 'Bed', 2),
  ('DS', 'Pillow Case', 2, 'Bed', 3),
  ('DS', 'Bath Towel', 2, 'Bathroom', 10),
  ('DS', 'Hand Towel', 2, 'Bathroom', 11),
  ('DS', 'Floor Mat', 1, 'Bathroom', 12),
  ('DS', 'Tissue Box', 1, 'Bathroom', 13),
  ('DS', 'Toilet Paper', 1, 'Bathroom', 14),
  ('DS', 'Soap', 2, 'Amenity', 20),
  ('DS', 'Shampoo', 2, 'Amenity', 21),
  ('DS', 'Water Bottle', 2, 'Amenity', 22),
  ('DS', 'Trash Bin', 1, 'Room', 30),
  ('DS', 'Vacuum', 1, 'Room', 31),
  ('DS', 'Mop Floor', 1, 'Room', 32),
  -- DQ (Deluxe Queen)
  ('DQ', 'Make Bed', 1, 'Bed', 1),
  ('DQ', 'Change Sheets', 1, 'Bed', 2),
  ('DQ', 'Pillow Case', 2, 'Bed', 3),
  ('DQ', 'Bath Towel', 2, 'Bathroom', 10),
  ('DQ', 'Hand Towel', 2, 'Bathroom', 11),
  ('DQ', 'Floor Mat', 1, 'Bathroom', 12),
  ('DQ', 'Tissue Box', 1, 'Bathroom', 13),
  ('DQ', 'Toilet Paper', 1, 'Bathroom', 14),
  ('DQ', 'Soap', 2, 'Amenity', 20),
  ('DQ', 'Shampoo', 2, 'Amenity', 21),
  ('DQ', 'Water Bottle', 2, 'Amenity', 22),
  ('DQ', 'Trash Bin', 1, 'Room', 30),
  ('DQ', 'Vacuum', 1, 'Room', 31),
  ('DQ', 'Mop Floor', 1, 'Room', 32),
  -- DT (Deluxe Twin)
  ('DT', 'Make Bed', 1, 'Bed', 1),
  ('DT', 'Change Sheets', 1, 'Bed', 2),
  ('DT', 'Pillow Case', 2, 'Bed', 3),
  ('DT', 'Bath Towel', 2, 'Bathroom', 10),
  ('DT', 'Hand Towel', 2, 'Bathroom', 11),
  ('DT', 'Floor Mat', 1, 'Bathroom', 12),
  ('DT', 'Tissue Box', 1, 'Bathroom', 13),
  ('DT', 'Toilet Paper', 1, 'Bathroom', 14),
  ('DT', 'Soap', 2, 'Amenity', 20),
  ('DT', 'Shampoo', 2, 'Amenity', 21),
  ('DT', 'Water Bottle', 2, 'Amenity', 22),
  ('DT', 'Trash Bin', 1, 'Room', 30),
  ('DT', 'Vacuum', 1, 'Room', 31),
  ('DT', 'Mop Floor', 1, 'Room', 32),
  -- JS (Junior Suite — larger, 90min)
  ('JS', 'Make Bed', 1, 'Bed', 1),
  ('JS', 'Change Sheets', 1, 'Bed', 2),
  ('JS', 'Pillow Case', 2, 'Bed', 3),
  ('JS', 'Bath Towel', 2, 'Bathroom', 10),
  ('JS', 'Hand Towel', 2, 'Bathroom', 11),
  ('JS', 'Floor Mat', 1, 'Bathroom', 12),
  ('JS', 'Tissue Box', 1, 'Bathroom', 13),
  ('JS', 'Toilet Paper', 1, 'Bathroom', 14),
  ('JS', 'Soap', 2, 'Amenity', 20),
  ('JS', 'Shampoo', 2, 'Amenity', 21),
  ('JS', 'Water Bottle', 2, 'Amenity', 22),
  ('JS', 'Trash Bin', 1, 'Room', 30),
  ('JS', 'Vacuum', 1, 'Room', 31),
  ('JS', 'Mop Floor', 1, 'Room', 32),
  -- TB (Triple Beds — 3 guests, extra amenities, 90min)
  ('TB', 'Make Bed', 1, 'Bed', 1),
  ('TB', 'Change Sheets', 1, 'Bed', 2),
  ('TB', 'Pillow Case', 3, 'Bed', 3),
  ('TB', 'Bath Towel', 3, 'Bathroom', 10),
  ('TB', 'Hand Towel', 3, 'Bathroom', 11),
  ('TB', 'Floor Mat', 1, 'Bathroom', 12),
  ('TB', 'Tissue Box', 1, 'Bathroom', 13),
  ('TB', 'Toilet Paper', 1, 'Bathroom', 14),
  ('TB', 'Soap', 3, 'Amenity', 20),
  ('TB', 'Shampoo', 3, 'Amenity', 21),
  ('TB', 'Water Bottle', 3, 'Amenity', 22),
  ('TB', 'Trash Bin', 1, 'Room', 30),
  ('TB', 'Vacuum', 1, 'Room', 31),
  ('TB', 'Mop Floor', 1, 'Room', 32),
  -- FR (Family Room — 4+ guests, extra everything, 100min)
  ('FR', 'Make Bed', 1, 'Bed', 1),
  ('FR', 'Change Sheets', 2, 'Bed', 2),
  ('FR', 'Pillow Case', 4, 'Bed', 3),
  ('FR', 'Bath Towel', 4, 'Bathroom', 10),
  ('FR', 'Hand Towel', 4, 'Bathroom', 11),
  ('FR', 'Floor Mat', 1, 'Bathroom', 12),
  ('FR', 'Tissue Box', 2, 'Bathroom', 13),
  ('FR', 'Toilet Paper', 2, 'Bathroom', 14),
  ('FR', 'Soap', 4, 'Amenity', 20),
  ('FR', 'Shampoo', 4, 'Amenity', 21),
  ('FR', 'Water Bottle', 4, 'Amenity', 22),
  ('FR', 'Trash Bin', 1, 'Room', 30),
  ('FR', 'Vacuum', 1, 'Room', 31),
  ('FR', 'Mop Floor', 1, 'Room', 32)
ON CONFLICT (room_type_code, item_name) DO NOTHING;

commit;
