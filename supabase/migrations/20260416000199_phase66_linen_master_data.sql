begin;

create table if not exists public.linen_items (
  id serial primary key,
  item_number smallint not null unique,
  name_th text not null,
  name_en text not null,
  category text not null check (category in ('bed', 'bath', 'misc')),
  is_active boolean not null default true,
  laundry_rate_per_piece numeric(8, 2) not null default 0,
  sort_order smallint not null default 0,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.room_linen_setups (
  id serial primary key,
  room_type_code text not null,
  linen_item_id int not null references public.linen_items(id) on delete cascade,
  qty smallint not null default 0 check (qty >= 0),
  unique (room_type_code, linen_item_id)
);

create table if not exists public.linen_dayuse_setup (
  id serial primary key,
  linen_item_id int not null references public.linen_items(id) on delete cascade unique,
  qty_per_room smallint not null default 0 check (qty_per_room >= 0)
);

create table if not exists public.linen_usage_rules (
  id serial primary key,
  category text not null check (category in (
    'checkout_serviced',
    'checkout_towel_only',
    'inhouse_serviced',
    'inhouse_not_started',
    'inhouse_no_task',
    'inhouse_no_service',
    'after_cutoff'
  )),
  linen_item_id int not null references public.linen_items(id) on delete cascade,
  percentage smallint not null default 0 check (percentage >= 0 and percentage <= 100),
  use_checklist boolean not null default false,
  notes text,
  unique (category, linen_item_id)
);

alter table public.linen_items enable row level security;
alter table public.room_linen_setups enable row level security;
alter table public.linen_dayuse_setup enable row level security;
alter table public.linen_usage_rules enable row level security;

drop policy if exists linen_items_read on public.linen_items;
create policy linen_items_read on public.linen_items
  for select to authenticated
  using (true);

drop policy if exists linen_items_write on public.linen_items;
create policy linen_items_write on public.linen_items
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists room_linen_setups_read on public.room_linen_setups;
create policy room_linen_setups_read on public.room_linen_setups
  for select to authenticated
  using (true);

drop policy if exists room_linen_setups_write on public.room_linen_setups;
create policy room_linen_setups_write on public.room_linen_setups
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists linen_dayuse_setup_read on public.linen_dayuse_setup;
create policy linen_dayuse_setup_read on public.linen_dayuse_setup
  for select to authenticated
  using (true);

drop policy if exists linen_dayuse_setup_write on public.linen_dayuse_setup;
create policy linen_dayuse_setup_write on public.linen_dayuse_setup
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists linen_usage_rules_read on public.linen_usage_rules;
create policy linen_usage_rules_read on public.linen_usage_rules
  for select to authenticated
  using (true);

drop policy if exists linen_usage_rules_write on public.linen_usage_rules;
create policy linen_usage_rules_write on public.linen_usage_rules
  for all to authenticated
  using (true)
  with check (true);

commit;
