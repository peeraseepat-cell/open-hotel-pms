-- ============================================================================
-- Phase 72 · Migration 001 — Rate Floor + App Settings
-- ============================================================================
-- Owner: Agent B
-- Reviewer: Lead (P1)
-- Depends on: 20260219_000001_init_core.sql (room_types), auth schema (users)
--
-- LAYER 0 SKELETON — DO NOT APPLY UNTIL AGENT B FILLS BODY.
-- Agent B adds: ALTER TABLE room_types, app_settings table, seed rows.
-- See WORK_ASSIGNMENT_PHASE72.md §5.1 for full DDL reference.
-- ============================================================================

-- Agent B: implement full migration below this line.

alter table public.room_types
  add column if not exists min_rate_floor numeric(10, 2) null
    check (min_rate_floor is null or min_rate_floor >= 0);

comment on column public.room_types.min_rate_floor is
  'Admin-set hard floor for manual rate_templates edits. Rate Plan overrides bypass this floor by design (Phase 72 D3).';

create table if not exists public.app_settings (
  key text primary key,
  value_json jsonb not null,
  description text,
  updated_at timestamptz not null default timezone('utc', now()),
  updated_by uuid references auth.users(id)
);

comment on table public.app_settings is
  'Phase 72 app-level settings for rate grid guard rails and OTA alarm delivery.';

insert into public.app_settings (key, value_json, description) values
  ('rate.price_delta_warn_threshold', '0.20'::jsonb, 'Fraction. Edits above this delta show a warning modal.'),
  ('ota.alarm_minutes', '120'::jsonb, 'Minutes before pending OTA sync tasks trigger a Telegram alert.'),
  ('telegram.admin_chat_id', '""'::jsonb, 'Admin Telegram chat id configured from the bot /start flow.')
on conflict (key) do nothing;

alter table public.app_settings enable row level security;
