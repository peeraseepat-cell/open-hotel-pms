begin;

-- Keep Amenity Analytics Max config in sync with the existing Room Setup
-- checklist. Operators should only need to link an amenity product once in
-- Room Setup; analytics reads the normalized room_type_amenity_setups table.

create or replace function public.sync_room_type_amenity_setup_from_checklist(p_room_type_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_type_id bigint;
begin
  if nullif(trim(coalesce(p_room_type_code, '')), '') is null then
    return;
  end if;

  select rt.id
  into v_room_type_id
  from public.room_types rt
  where rt.code = p_room_type_code
    and upper(coalesce(rt.code, '')) <> 'CLOSED'
    and lower(coalesce(rt.name_en, '')) not like '%closed%'
  limit 1;

  if v_room_type_id is null then
    return;
  end if;

  delete from public.room_type_amenity_setups rtas
  using public.products p
  where rtas.room_type_id = v_room_type_id
    and p.id = rtas.product_id
    and p.stock_tracking_mode in ('amenity_prepare', 'amenity_direct');

  insert into public.room_type_amenity_setups (
    room_type_id,
    product_id,
    units_per_occupied_night
  )
  select
    v_room_type_id,
    ct.product_id,
    max(ct.default_quantity)::int as units_per_occupied_night
  from public.checklist_templates ct
  join public.products p
    on p.id = ct.product_id
  where ct.room_type_code = p_room_type_code
    and ct.is_active = true
    and ct.product_id is not null
    and coalesce(ct.default_quantity, 0) > 0
    and coalesce(p.is_active, true) = true
    and p.stock_tracking_mode in ('amenity_prepare', 'amenity_direct')
  group by ct.product_id
  on conflict (room_type_id, product_id) do update
  set units_per_occupied_night = excluded.units_per_occupied_night,
      updated_at = timezone('utc', now());
end;
$$;

create or replace function public.trg_sync_room_type_amenity_setup_from_checklist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_room_type_amenity_setup_from_checklist(coalesce(new.room_type_code, old.room_type_code));

  if tg_op = 'UPDATE' and old.room_type_code is distinct from new.room_type_code then
    perform public.sync_room_type_amenity_setup_from_checklist(old.room_type_code);
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_sync_room_type_amenity_setup_from_checklist on public.checklist_templates;
create trigger trg_sync_room_type_amenity_setup_from_checklist
after insert or update or delete on public.checklist_templates
for each row execute function public.trg_sync_room_type_amenity_setup_from_checklist();

grant execute on function public.sync_room_type_amenity_setup_from_checklist(text) to authenticated;

commit;
