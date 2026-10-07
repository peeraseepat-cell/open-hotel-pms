begin;

create table if not exists public.guest_vehicles (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null,
  guest_profile_id uuid null references public.guest_profiles(id) on delete set null,
  room_id uuid null references public.rooms(id) on delete set null,
  room_number text null,
  booking_code text null,
  guest_name text null,
  vehicle_type text not null default 'car',
  plate_number text null,
  plate_province text null,
  plate_country text not null default 'TH',
  vehicle_brand text null,
  vehicle_model text null,
  vehicle_color text not null default 'white',
  description text null,
  registered_at timestamptz not null default timezone('utc', now()),
  registered_by text null,
  checked_out_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_guest_vehicles_vehicle_type'
  ) then
    alter table public.guest_vehicles
      add constraint chk_guest_vehicles_vehicle_type
      check (vehicle_type in ('car', 'motorcycle', 'bicycle'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_guest_vehicles_plate_country'
  ) then
    alter table public.guest_vehicles
      add constraint chk_guest_vehicles_plate_country
      check (plate_country in ('TH', 'MY'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_guest_vehicles_vehicle_color'
  ) then
    alter table public.guest_vehicles
      add constraint chk_guest_vehicles_vehicle_color
      check (vehicle_color in ('white', 'black', 'silver', 'red', 'blue', 'yellow', 'other'));
  end if;
end $$;

create index if not exists idx_gv_reservation
  on public.guest_vehicles (reservation_id);

create index if not exists idx_gv_guest_profile
  on public.guest_vehicles (guest_profile_id)
  where guest_profile_id is not null;

create index if not exists idx_gv_room
  on public.guest_vehicles (room_id)
  where room_id is not null;

create index if not exists idx_gv_active
  on public.guest_vehicles (checked_out_at)
  where checked_out_at is null;

create index if not exists idx_gv_plate
  on public.guest_vehicles (plate_number)
  where plate_number is not null;

drop trigger if exists trg_guest_vehicles_updated_at on public.guest_vehicles;
create trigger trg_guest_vehicles_updated_at
before update on public.guest_vehicles
for each row execute function public.set_updated_at();

commit;
