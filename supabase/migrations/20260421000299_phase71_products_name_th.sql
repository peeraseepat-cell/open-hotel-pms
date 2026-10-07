-- Phase 71: products — add name_th + pos_abbreviated_enabled, seed POS items
--
-- name_th                 → Thai label printed on ใบกำกับภาษีอย่างย่อ (POS)
-- pos_abbreviated_enabled → gate for POS abbreviated-invoice aggregation
--
-- Seed strategy (per WA Phase 71, verified against Phase 10 seed
-- 202603020001_phase10_pos_inventory.sql):
--   - Water Bottle  EXISTS (category='both', sale_price=20.00)
--                   → UPDATE: set name_th, enable POS abbreviated
--   - Coffee        EXISTS (category='amenity', sale_price=NULL)
--                   → UPDATE: promote to 'both', set name_th,
--                     enable POS abbreviated.  sale_price stays NULL until
--                     Admin sets it via ProductsTab (pos_create_order
--                     already guards NULL, double-guarded by is_active).
--   - Est           NEW   (insert inactive, sale_price NULL)
--   - Chang Beer    NEW   (insert inactive, sale_price NULL)
--   - Leo Beer      NEW   (insert inactive, sale_price NULL)
--   - Singha Beer   NEW   (insert inactive, sale_price NULL)
--
-- Beer + Est default to is_active=false so they cannot be sold until
-- Admin supplies sale_price. pos_create_order already raises if sale_price
-- is NULL, but is_active=false is the primary user-facing gate.

BEGIN;

-- ------------------------------------------------------------
-- 1) Schema additions
-- ------------------------------------------------------------
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS name_th text;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS pos_abbreviated_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.products.name_th
  IS 'Phase 71: Thai name printed on ใบกำกับภาษีอย่างย่อ (POS). Required when pos_abbreviated_enabled = true.';

COMMENT ON COLUMN public.products.pos_abbreviated_enabled
  IS 'Phase 71: true = include in POS daily abbreviated tax invoice aggregation.';

-- Row-level guard: if enabled, name_th must be non-empty.
-- (UI-level validation is enforced in ProductsTab; this is the DB defence.)
ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_name_th_required_when_abbr_enabled;
ALTER TABLE public.products
  ADD CONSTRAINT products_name_th_required_when_abbr_enabled
  CHECK (
    pos_abbreviated_enabled = false
    OR (name_th IS NOT NULL AND btrim(name_th) <> '')
  );

-- ------------------------------------------------------------
-- 2) Seed — existing rows
-- ------------------------------------------------------------
UPDATE public.products
  SET name_th = 'น้ำดื่ม',
      pos_abbreviated_enabled = true
  WHERE name = 'Water Bottle';

UPDATE public.products
  SET category = 'both',
      name_th  = 'กาแฟ',
      pos_abbreviated_enabled = true
  WHERE name = 'Coffee';

-- ------------------------------------------------------------
-- 3) Seed — new POS-only items (inactive until Admin sets sale_price)
-- ------------------------------------------------------------
INSERT INTO public.products (name, category, unit, sale_price, is_active, name_th, pos_abbreviated_enabled)
VALUES
  ('Est',         'pos', 'bottles', NULL, false, 'เอส',         true),
  ('Chang Beer',  'pos', 'bottles', NULL, false, 'เบียร์ช้าง',   true),
  ('Leo Beer',    'pos', 'bottles', NULL, false, 'เบียร์ลีโอ',   true),
  ('Singha Beer', 'pos', 'bottles', NULL, false, 'เบียร์สิงห์',  true)
ON CONFLICT (name) DO UPDATE
  SET category                 = EXCLUDED.category,
      unit                     = EXCLUDED.unit,
      name_th                  = EXCLUDED.name_th,
      pos_abbreviated_enabled  = EXCLUDED.pos_abbreviated_enabled;

-- ------------------------------------------------------------
-- 4) Lookup index — POS abbreviated aggregation query path
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_products_pos_abbreviated_enabled
  ON public.products(pos_abbreviated_enabled)
  WHERE pos_abbreviated_enabled = true;

COMMIT;
