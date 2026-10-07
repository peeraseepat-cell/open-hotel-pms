-- ============================================================================
-- Phase 72 · Migration 002 — OTA Channels + Rate Sync Tasks
-- ============================================================================
-- Owner: Agent B
-- Reviewer: Lead (P1)
-- Depends on: 001 (app_settings), 20260219_000001_init_core.sql (room_types)
--
-- LAYER 0 SKELETON — DO NOT APPLY UNTIL AGENT B FILLS BODY.
-- Agent B creates: ota_channels, ota_rate_sync_tasks, indexes, BOOKING seed.
-- See WORK_ASSIGNMENT_PHASE72.md §5.2 for full DDL reference.
--
-- NOTE (D-B4 reply): created_by is NULLABLE (trigger-inserted tasks have no
-- session actor). acked_by is NULLABLE at DB level; API layer enforces NOT
-- NULL when status transitions to 'synced' | 'skipped'.
-- ============================================================================

-- Agent B: implement full migration below this line.

create table if not exists public.ota_channels (
  code text primary key,
  name_en text not null,
  markup_type text not null check (markup_type in ('none', 'percent', 'fixed')),
  markup_value numeric(10, 2) not null default 0,
  is_active boolean not null default false,
  sync_method text not null default 'manual' check (sync_method in ('manual', 'api')),
  created_at timestamptz not null default timezone('utc', now())
);

comment on table public.ota_channels is
  'Phase 72 OTA channels used to derive manual sync tasks from base room prices.';

insert into public.ota_channels (code, name_en, markup_type, markup_value, is_active, sync_method) values
  ('BOOKING', 'Booking.com', 'percent', 15.00, true, 'manual')
on conflict (code) do nothing;

create table if not exists public.ota_rate_sync_tasks (
  id uuid primary key default gen_random_uuid(),
  channel_code text not null references public.ota_channels(code),
  room_type_id bigint not null references public.room_types(id) on delete cascade,
  stay_date date not null,
  old_price numeric(10, 2),
  new_price numeric(10, 2) not null,
  calculated_ota_price numeric(10, 2) not null,
  markup_snapshot jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'synced', 'superseded', 'skipped')),
  superseded_by uuid references public.ota_rate_sync_tasks(id) on delete set null,
  reason text,
  created_at timestamptz not null default timezone('utc', now()),
  created_by uuid references auth.users(id),
  acked_at timestamptz,
  acked_by uuid references auth.users(id),
  staff_note text
);

comment on table public.ota_rate_sync_tasks is
  'Phase 72 manual OTA sync queue. created_by may be NULL when inserted by DB trigger.';

create index if not exists idx_ota_tasks_pending
  on public.ota_rate_sync_tasks(channel_code, status, stay_date)
  where status = 'pending';

create index if not exists idx_ota_tasks_stale
  on public.ota_rate_sync_tasks(created_at)
  where status = 'pending';

create index if not exists idx_ota_tasks_key_status
  on public.ota_rate_sync_tasks(channel_code, room_type_id, stay_date, status, created_at desc);

alter table public.ota_channels enable row level security;
alter table public.ota_rate_sync_tasks enable row level security;
