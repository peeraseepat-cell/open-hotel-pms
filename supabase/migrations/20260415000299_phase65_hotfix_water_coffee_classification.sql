-- Phase 65 hotfix — 2026-04-15
-- Problem: 202604150001 backfill used exact name match `lower(trim(name)) in ('water bottle', 'water for room', 'coffee')`
-- Actual product names in the catalog are:
--   - "Water Bottle For Room" (amenity, should be amenity_prepare)
--   - "Coffee For Room"       (amenity, should be amenity_prepare)
--   - "Water Bottle For Sale" (POS, already pos_main_only via category=pos rule — untouched)
--   - "Coffee"                (POS, already pos_main_only via category=pos rule — untouched)
--
-- Effect: the two amenity items fell through to the default `amenity_direct` and started showing
-- in the FO Amenity Audit page even though they belong to the FO Prepare flow.
--
-- This hotfix only touches rows currently mis-classified as `amenity_direct`. It does not
-- overwrite any row that an admin may have fixed manually after the original backfill.

do $$
declare
  v_updated int;
begin
  update public.products
  set stock_tracking_mode = 'amenity_prepare',
      updated_at = timezone('utc', now())
  where is_active = true
    and stock_tracking_mode = 'amenity_direct'
    and lower(trim(name)) in (
      'water bottle for room',
      'coffee for room'
    );

  get diagnostics v_updated = row_count;
  raise notice 'phase65 hotfix: reclassified % product row(s) from amenity_direct to amenity_prepare', v_updated;
end $$;

-- Defensive sweep (belt-and-suspenders): any product with category='pos' must be pos_main_only.
-- This guards against a future admin accidentally classifying a POS product as amenity_direct.
do $$
declare
  v_fixed int;
begin
  update public.products
  set stock_tracking_mode = 'pos_main_only',
      updated_at = timezone('utc', now())
  where is_active = true
    and category = 'pos'
    and stock_tracking_mode <> 'pos_main_only';

  get diagnostics v_fixed = row_count;
  raise notice 'phase65 hotfix: repaired % POS product(s) to pos_main_only', v_fixed;
end $$;
