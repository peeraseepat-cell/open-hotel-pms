begin;

create extension if not exists "pgcrypto";

do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('admin', 'frontdesk', 'maid', 'supervisor');
  end if;

  if not exists (select 1 from pg_type where typname = 'booking_source') then
    create type public.booking_source as enum ('walkin', 'ota', 'direct', 'agent');
  end if;

  if not exists (select 1 from pg_type where typname = 'reservation_status') then
    create type public.reservation_status as enum ('active', 'cancelled', 'checked_out', 'no_show');
  end if;

  if not exists (select 1 from pg_type where typname = 'housekeeping_status') then
    create type public.housekeeping_status as enum ('dirty', 'in_progress', 'paused', 'cleaned', 'approved');
  end if;
end $$;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.user_role not null default 'frontdesk',
  full_name text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.room_types (
  id bigserial primary key,
  code text not null unique,
  name_en text not null,
  name_local text,
  sort_order int not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  room_number text not null unique,
  room_type_id bigint not null references public.room_types (id),
  is_sellable boolean not null default true,
  is_visible_on_board boolean not null default true,
  closure_reason text,
  sort_order int not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.room_layouts (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  view_type text not null check (view_type in ('month', 'week', 'day')),
  grid_x int,
  grid_y int,
  zone text not null default 'default',
  sort_order int not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (room_id, view_type)
);

create table if not exists public.rate_templates (
  id uuid primary key default gen_random_uuid(),
  stay_date date not null,
  room_id uuid not null references public.rooms (id) on delete cascade,
  price numeric(10, 2) not null default 0,
  updated_by uuid references public.profiles (user_id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (stay_date, room_id)
);

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  booking_code text not null unique,
  guest_name text not null,
  phone text,
  source public.booking_source not null default 'walkin',
  status public.reservation_status not null default 'active',
  checkin_date date not null,
  checkout_date date not null,
  checkin_time text,
  note text,
  total_price numeric(10, 2) not null default 0,
  created_by uuid references public.profiles (user_id),
  updated_by uuid references public.profiles (user_id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint reservation_date_range check (checkout_date > checkin_date)
);

create table if not exists public.reservation_nights (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations (id) on delete cascade,
  room_id uuid not null references public.rooms (id),
  stay_date date not null,
  nightly_price numeric(10, 2) not null default 0,
  is_ota boolean not null default false,
  cancelled_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists uq_reservation_nights_active_room_day
  on public.reservation_nights (room_id, stay_date)
  where cancelled_at is null;

create table if not exists public.housekeeping_tasks (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id),
  stay_date date not null,
  reservation_night_id uuid references public.reservation_nights (id),
  status public.housekeeping_status not null default 'dirty',
  assigned_maid uuid references public.profiles (user_id),
  requested_by uuid references public.profiles (user_id),
  approved_by uuid references public.profiles (user_id),
  started_at timestamptz,
  finished_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists uq_housekeeping_tasks_room_day
  on public.housekeeping_tasks (room_id, stay_date);

create table if not exists public.housekeeping_logs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.housekeeping_tasks (id) on delete cascade,
  status public.housekeeping_status not null,
  actor_user_id uuid references public.profiles (user_id),
  note text,
  checklist jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles (user_id),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists trg_room_types_updated_at on public.room_types;
create trigger trg_room_types_updated_at
before update on public.room_types
for each row execute function public.set_updated_at();

drop trigger if exists trg_rooms_updated_at on public.rooms;
create trigger trg_rooms_updated_at
before update on public.rooms
for each row execute function public.set_updated_at();

drop trigger if exists trg_room_layouts_updated_at on public.room_layouts;
create trigger trg_room_layouts_updated_at
before update on public.room_layouts
for each row execute function public.set_updated_at();

drop trigger if exists trg_rate_templates_updated_at on public.rate_templates;
create trigger trg_rate_templates_updated_at
before update on public.rate_templates
for each row execute function public.set_updated_at();

drop trigger if exists trg_reservations_updated_at on public.reservations;
create trigger trg_reservations_updated_at
before update on public.reservations
for each row execute function public.set_updated_at();

drop trigger if exists trg_housekeeping_tasks_updated_at on public.housekeeping_tasks;
create trigger trg_housekeeping_tasks_updated_at
before update on public.housekeeping_tasks
for each row execute function public.set_updated_at();

create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select p.role
  from public.profiles p
  where p.user_id = auth.uid() and p.is_active = true
  limit 1;
$$;

create or replace function public.has_any_role(roles public.user_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_user_role() = any(roles), false);
$$;

grant execute on function public.current_user_role() to authenticated;
grant execute on function public.has_any_role(public.user_role[]) to authenticated;

alter table public.profiles enable row level security;
alter table public.room_types enable row level security;
alter table public.rooms enable row level security;
alter table public.room_layouts enable row level security;
alter table public.rate_templates enable row level security;
alter table public.reservations enable row level security;
alter table public.reservation_nights enable row level security;
alter table public.housekeeping_tasks enable row level security;
alter table public.housekeeping_logs enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_select_policy on public.profiles
for select to authenticated
using (user_id = auth.uid() or public.has_any_role(array['admin', 'supervisor']::public.user_role[]));

create policy profiles_insert_policy on public.profiles
for insert to authenticated
with check (user_id = auth.uid() or public.has_any_role(array['admin']::public.user_role[]));

create policy profiles_update_policy on public.profiles
for update to authenticated
using (user_id = auth.uid() or public.has_any_role(array['admin']::public.user_role[]))
with check (user_id = auth.uid() or public.has_any_role(array['admin']::public.user_role[]));

create policy room_types_read_policy on public.room_types
for select to authenticated using (true);

create policy room_types_write_policy on public.room_types
for all to authenticated
using (public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
with check (public.has_any_role(array['admin', 'supervisor']::public.user_role[]));

create policy rooms_read_policy on public.rooms
for select to authenticated using (true);

create policy rooms_write_policy on public.rooms
for all to authenticated
using (public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
with check (public.has_any_role(array['admin', 'supervisor']::public.user_role[]));

create policy room_layouts_read_policy on public.room_layouts
for select to authenticated using (true);

create policy room_layouts_write_policy on public.room_layouts
for all to authenticated
using (public.has_any_role(array['admin', 'supervisor']::public.user_role[]))
with check (public.has_any_role(array['admin', 'supervisor']::public.user_role[]));

create policy rate_templates_read_policy on public.rate_templates
for select to authenticated using (true);

create policy rate_templates_write_policy on public.rate_templates
for all to authenticated
using (public.has_any_role(array['admin', 'frontdesk', 'supervisor']::public.user_role[]))
with check (public.has_any_role(array['admin', 'frontdesk', 'supervisor']::public.user_role[]));

create policy reservations_read_policy on public.reservations
for select to authenticated using (true);

create policy reservations_write_policy on public.reservations
for all to authenticated
using (public.has_any_role(array['admin', 'frontdesk', 'supervisor']::public.user_role[]))
with check (public.has_any_role(array['admin', 'frontdesk', 'supervisor']::public.user_role[]));

create policy reservation_nights_read_policy on public.reservation_nights
for select to authenticated using (true);

create policy reservation_nights_write_policy on public.reservation_nights
for all to authenticated
using (public.has_any_role(array['admin', 'frontdesk', 'supervisor']::public.user_role[]))
with check (public.has_any_role(array['admin', 'frontdesk', 'supervisor']::public.user_role[]));

create policy housekeeping_tasks_read_policy on public.housekeeping_tasks
for select to authenticated using (true);

create policy housekeeping_tasks_write_policy on public.housekeeping_tasks
for all to authenticated
using (public.has_any_role(array['admin', 'frontdesk', 'maid', 'supervisor']::public.user_role[]))
with check (public.has_any_role(array['admin', 'frontdesk', 'maid', 'supervisor']::public.user_role[]));

create policy housekeeping_logs_read_policy on public.housekeeping_logs
for select to authenticated using (true);

create policy housekeeping_logs_write_policy on public.housekeeping_logs
for insert to authenticated
with check (public.has_any_role(array['admin', 'maid', 'supervisor']::public.user_role[]));

create policy audit_logs_read_policy on public.audit_logs
for select to authenticated
using (public.has_any_role(array['admin', 'supervisor']::public.user_role[]));

create policy audit_logs_insert_policy on public.audit_logs
for insert to authenticated
with check (public.has_any_role(array['admin', 'frontdesk', 'maid', 'supervisor']::public.user_role[]));

commit;
