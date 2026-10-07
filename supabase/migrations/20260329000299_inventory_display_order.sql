-- Phase 54: Inventory display order
-- Add explicit display order for products list rendering and manual reorder.

ALTER TABLE products
ADD COLUMN IF NOT EXISTS display_order integer DEFAULT 0;

-- Seed active products by current alphabetical order when display_order is unset.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY name ASC) AS rn
  FROM products
  WHERE is_active = true
)
UPDATE products
SET display_order = ranked.rn
FROM ranked
WHERE products.id = ranked.id
  AND COALESCE(products.display_order, 0) = 0;

-- Keep inactive products at the end.
UPDATE products
SET display_order = 9999
WHERE is_active = false
  AND COALESCE(display_order, 0) = 0;

