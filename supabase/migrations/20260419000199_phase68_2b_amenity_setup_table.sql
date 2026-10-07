begin;

-- Phase 68.2b: Amenity per-room setup used by Analytics Max baseline.
-- room_types.id is bigserial, so room_type_id must be bigint (not uuid).

create table if not exists public.room_type_amenity_setups (
  room_type_id bigint not null references public.room_types(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  units_per_occupied_night int not null default 0 check (units_per_occupied_night >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (room_type_id, product_id)
);

create index if not exists idx_room_type_amenity_setups_product
  on public.room_type_amenity_setups(product_id);

drop trigger if exists trg_room_type_amenity_setups_updated_at on public.room_type_amenity_setups;
create trigger trg_room_type_amenity_setups_updated_at
before update on public.room_type_amenity_setups
for each row execute function public.set_updated_at();

alter table public.room_type_amenity_setups enable row level security;

drop policy if exists room_type_amenity_setups_read on public.room_type_amenity_setups;
create policy room_type_amenity_setups_read on public.room_type_amenity_setups
  for select to authenticated
  using (true);

drop policy if exists room_type_amenity_setups_write on public.room_type_amenity_setups;
create policy room_type_amenity_setups_write on public.room_type_amenity_setups
  for all to authenticated
  using (true)
  with check (true);

grant select, insert, update, delete on table public.room_type_amenity_setups to authenticated;

commit;
