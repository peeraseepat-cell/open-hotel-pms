begin;

-- Phase 68.2b hotfix: reuse the existing room-type checklist setup as the
-- initial Max baseline config for Amenity Analytics.
--
-- The analytics RPC intentionally returns max_qty = NULL when a product has no
-- room_type_amenity_setups rows. Existing room setup already stores linked
-- amenity products in checklist_templates, so this backfill prevents operators
-- from having to re-enter the same matrix manually.

insert into public.room_type_amenity_setups (
  room_type_id,
  product_id,
  units_per_occupied_night
)
select
  rt.id as room_type_id,
  ct.product_id,
  max(ct.default_quantity)::int as units_per_occupied_night
from public.checklist_templates ct
join public.room_types rt
  on rt.code = ct.room_type_code
join public.products p
  on p.id = ct.product_id
where ct.is_active = true
  and ct.product_id is not null
  and coalesce(ct.default_quantity, 0) > 0
  and coalesce(p.is_active, true) = true
  and p.stock_tracking_mode in ('amenity_prepare', 'amenity_direct')
  and upper(coalesce(rt.code, '')) <> 'CLOSED'
  and lower(coalesce(rt.name_en, '')) not like '%closed%'
group by rt.id, ct.product_id
on conflict (room_type_id, product_id) do update
set units_per_occupied_night = excluded.units_per_occupied_night,
    updated_at = timezone('utc', now());

commit;
