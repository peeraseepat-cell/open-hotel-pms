begin;

alter table public.reservations
  add column if not exists parent_reservation_id uuid references public.reservations(id) on delete set null;

create table if not exists public.reservation_room_plans (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  from_room_id_snapshot uuid references public.rooms(id) on delete set null,
  to_room_type_id bigint not null references public.room_types(id),
  to_room_id uuid not null references public.rooms(id),
  move_reason text not null,
  pricing_policy text not null default 'keep_rtc',
  discount_type text,
  discount_value numeric(10,2),
  discount_reason text,
  do_not_move boolean not null default false,
  do_not_move_note text,
  status text not null default 'planned',
  executed_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid references public.profiles(user_id),
  updated_by uuid references public.profiles(user_id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint reservation_room_plans_date_range_check check (end_date >= start_date),
  constraint reservation_room_plans_pricing_policy_check check (pricing_policy in ('keep_rtc', 'reprice_grid', 'reprice_grid_discount')),
  constraint reservation_room_plans_discount_type_check check (discount_type is null or discount_type in ('percent', 'fixed')),
  constraint reservation_room_plans_status_check check (status in ('planned', 'executed', 'cancelled')),
  constraint reservation_room_plans_do_not_move_note_check check ((not do_not_move) or (do_not_move_note is not null and btrim(do_not_move_note) <> ''))
);

create index if not exists idx_reservation_room_plans_reservation_status_start
  on public.reservation_room_plans (reservation_id, status, start_date);

create index if not exists idx_reservation_room_plans_room_status_dates
  on public.reservation_room_plans (to_room_id, status, start_date, end_date);

create index if not exists idx_reservations_parent_reservation_id
  on public.reservations (parent_reservation_id)
  where parent_reservation_id is not null;

create or replace function public.set_reservation_room_plans_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_reservation_room_plans_updated_at on public.reservation_room_plans;
create trigger trg_reservation_room_plans_updated_at
before update on public.reservation_room_plans
for each row
execute function public.set_reservation_room_plans_updated_at();

alter table public.reservation_room_plans enable row level security;
drop policy if exists service_full_access on public.reservation_room_plans;
create policy service_full_access
  on public.reservation_room_plans
  for all
  using (true)
  with check (true);

comment on table public.reservation_room_plans is
  'Future planned room move segments. to_room_id blocks inventory for the nightly date range while status=planned.';

comment on column public.reservation_room_plans.from_room_id_snapshot is
  'Reference-only snapshot of the source room at planning time. Execute must not require it to match current room.';

comment on column public.reservation_room_plans.do_not_move is
  'Hard lock for this planned segment. Override or cancel requires operator note in API workflow.';

commit;
