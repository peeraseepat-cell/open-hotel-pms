begin;

create table if not exists public.laundry_batches (
  id uuid primary key default gen_random_uuid(),
  business_date date not null,
  pickup_round smallint not null default 1 check (pickup_round > 0),
  vendor_name text,
  status text not null default 'draft' check (status in (
    'draft',
    'fo_dirty_counted',
    'fo_return_counted',
    'vendor_signed',
    'fo_return_signed',
    'closed',
    'partial',
    'disputed'
  )),
  cutoff_time time default '11:00',
  vendor_pickup_signature_url text,
  fo_return_signature_url text,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (business_date, pickup_round)
);

create table if not exists public.laundry_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.laundry_batches(id) on delete cascade,
  linen_item_id int not null references public.linen_items(id),
  is_dayuse boolean not null default false,
  estimated_qty smallint not null default 0 check (estimated_qty >= 0),
  sent_by_hotel smallint not null default 0 check (sent_by_hotel >= 0),
  received_back smallint not null default 0 check (received_back >= 0),
  damaged_qty smallint not null default 0 check (damaged_qty >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  unique (batch_id, linen_item_id, is_dayuse)
);

create table if not exists public.laundry_batch_events (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.laundry_batches(id) on delete cascade,
  event_type text not null check (event_type in (
    'created',
    'fo_dirty_counted',
    'fo_return_counted',
    'vendor_signed',
    'fo_return_signed',
    'vendor_shop_confirmed',
    'closed',
    'partial_closed',
    'disputed',
    'reopened',
    'dayuse_added',
    'pending_resolved'
  )),
  actor_name text,
  actor_role text check (actor_role in ('fo', 'vendor', 'admin')),
  data jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.laundry_vendor_tokens (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.laundry_batches(id) on delete cascade,
  token uuid not null default gen_random_uuid() unique,
  vendor_name text,
  expires_at timestamptz not null,
  revoked boolean not null default false,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.laundry_pending_items (
  id uuid primary key default gen_random_uuid(),
  source_batch_id uuid not null references public.laundry_batches(id),
  linen_item_id int not null references public.linen_items(id),
  pending_qty smallint not null check (pending_qty > 0),
  created_by_batch_id uuid references public.laundry_batches(id),
  resolved_batch_id uuid references public.laundry_batches(id),
  resolved_at timestamptz,
  reason text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.linen_dayuse_pending (
  id uuid primary key default gen_random_uuid(),
  linen_item_id int not null references public.linen_items(id) unique,
  qty_accumulated smallint not null default 0 check (qty_accumulated >= 0),
  last_added_date date,
  sent_in_batch_id uuid references public.laundry_batches(id),
  sent_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_laundry_batches_date on public.laundry_batches (business_date);
create index if not exists idx_laundry_batches_status on public.laundry_batches (status);
create index if not exists idx_laundry_batch_items_batch on public.laundry_batch_items (batch_id);
create index if not exists idx_laundry_batch_events_batch on public.laundry_batch_events (batch_id);
create index if not exists idx_laundry_vendor_tokens_token on public.laundry_vendor_tokens (token);
create index if not exists idx_laundry_vendor_tokens_batch on public.laundry_vendor_tokens (batch_id);
create index if not exists idx_laundry_pending_items_source on public.laundry_pending_items (source_batch_id);
create index if not exists idx_laundry_pending_items_created_by on public.laundry_pending_items (created_by_batch_id);
create index if not exists idx_laundry_pending_items_unresolved on public.laundry_pending_items (resolved_at) where resolved_at is null;

drop trigger if exists trg_laundry_batches_updated_at on public.laundry_batches;
create trigger trg_laundry_batches_updated_at
before update on public.laundry_batches
for each row execute function public.set_updated_at();

alter table public.laundry_batches enable row level security;
alter table public.laundry_batch_items enable row level security;
alter table public.laundry_batch_events enable row level security;
alter table public.laundry_vendor_tokens enable row level security;
alter table public.laundry_pending_items enable row level security;
alter table public.linen_dayuse_pending enable row level security;

drop policy if exists laundry_batches_auth on public.laundry_batches;
create policy laundry_batches_auth on public.laundry_batches
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists laundry_batch_items_auth on public.laundry_batch_items;
create policy laundry_batch_items_auth on public.laundry_batch_items
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists laundry_batch_events_auth on public.laundry_batch_events;
create policy laundry_batch_events_auth on public.laundry_batch_events
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists laundry_vendor_tokens_auth on public.laundry_vendor_tokens;
create policy laundry_vendor_tokens_auth on public.laundry_vendor_tokens
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists laundry_pending_items_auth on public.laundry_pending_items;
create policy laundry_pending_items_auth on public.laundry_pending_items
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists linen_dayuse_pending_auth on public.linen_dayuse_pending;
create policy linen_dayuse_pending_auth on public.linen_dayuse_pending
  for all to authenticated
  using (true)
  with check (true);

commit;
