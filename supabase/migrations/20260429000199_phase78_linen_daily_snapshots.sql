begin;

create table if not exists public.linen_daily_snapshots (
  id uuid primary key default gen_random_uuid(),
  business_date date not null unique,
  computed_at timestamptz not null default timezone('utc', now()),
  computed_by uuid references auth.users(id),
  recomputed_count int not null default 0 check (recomputed_count >= 0),
  recompute_reason text,
  total_sent_normal int not null default 0 check (total_sent_normal >= 0),
  total_sent_rewash int not null default 0 check (total_sent_rewash >= 0),
  total_sent_old_dayuse int not null default 0 check (total_sent_old_dayuse >= 0),
  total_received_normal int not null default 0 check (total_received_normal >= 0),
  total_received_rewash int not null default 0 check (total_received_rewash >= 0),
  total_received_pending int not null default 0 check (total_received_pending >= 0),
  total_received_old_dayuse int not null default 0 check (total_received_old_dayuse >= 0),
  total_balance_normal_today int not null default 0 check (total_balance_normal_today >= 0),
  total_balance_old_dayuse int not null default 0 check (total_balance_old_dayuse >= 0),
  total_balance_pending_old int not null default 0 check (total_balance_pending_old >= 0),
  total_balance_rewash int not null default 0 check (total_balance_rewash >= 0),
  total_balance_vendor int not null default 0 check (total_balance_vendor >= 0),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.linen_daily_snapshot_items (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.linen_daily_snapshots(id) on delete cascade,
  business_date date not null,
  linen_item_id int not null references public.linen_items(id),
  item_number smallint,
  name_th text not null default '',
  sent_normal int not null default 0 check (sent_normal >= 0),
  sent_rewash int not null default 0 check (sent_rewash >= 0),
  sent_old_dayuse int not null default 0 check (sent_old_dayuse >= 0),
  received_normal int not null default 0 check (received_normal >= 0),
  received_rewash int not null default 0 check (received_rewash >= 0),
  received_pending int not null default 0 check (received_pending >= 0),
  received_old_dayuse int not null default 0 check (received_old_dayuse >= 0),
  balance_normal_today int not null default 0 check (balance_normal_today >= 0),
  balance_old_dayuse int not null default 0 check (balance_old_dayuse >= 0),
  balance_pending_old int not null default 0 check (balance_pending_old >= 0),
  balance_rewash int not null default 0 check (balance_rewash >= 0),
  balance_total int not null default 0 check (balance_total >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  unique (snapshot_id, linen_item_id),
  unique (business_date, linen_item_id)
);

create index if not exists idx_linen_daily_snapshots_date
  on public.linen_daily_snapshots (business_date desc);

create index if not exists idx_linen_daily_snapshot_items_date
  on public.linen_daily_snapshot_items (business_date, item_number);

drop trigger if exists trg_linen_daily_snapshots_updated_at on public.linen_daily_snapshots;
create trigger trg_linen_daily_snapshots_updated_at
before update on public.linen_daily_snapshots
for each row execute function public.set_updated_at();

alter table public.linen_daily_snapshots enable row level security;
alter table public.linen_daily_snapshot_items enable row level security;

drop policy if exists linen_daily_snapshots_auth on public.linen_daily_snapshots;
create policy linen_daily_snapshots_auth on public.linen_daily_snapshots
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists linen_daily_snapshot_items_auth on public.linen_daily_snapshot_items;
create policy linen_daily_snapshot_items_auth on public.linen_daily_snapshot_items
  for all to authenticated
  using (true)
  with check (true);

commit;
