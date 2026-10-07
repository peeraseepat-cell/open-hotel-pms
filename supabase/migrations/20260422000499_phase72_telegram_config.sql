-- ============================================================================
-- Phase 72 · Migration 004 — Telegram Webhook Config + Subscriptions
-- ============================================================================
-- Owner: Agent B
-- Reviewer: Lead (P1 — schema sanity, P3 — index coverage)
-- Depends on: 001 (app_settings)
--
-- LAYER 0 SKELETON — DO NOT APPLY UNTIL AGENT B FILLS BODY.
-- Agent B creates:
--   - telegram_webhook_events (raw update log for debugging + dedupe)
--   - telegram_alert_subscriptions (chat_id → role mapping)
-- See WORK_ASSIGNMENT_PHASE72.md §5.4 for DDL reference.
-- ============================================================================

-- Agent B: implement full migration below this line.

create table if not exists public.telegram_webhook_events (
  id bigserial primary key,
  update_id bigint not null unique,
  raw_payload jsonb not null,
  received_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.telegram_alert_subscriptions (
  chat_id bigint primary key,
  role text not null check (role in ('admin', 'fo', 'manager')),
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now())
);

comment on table public.telegram_webhook_events is
  'Phase 72 raw Telegram updates for debugging, dedupe, and bot setup verification.';

comment on table public.telegram_alert_subscriptions is
  'Phase 72 Telegram recipients for OTA sync alerts.';

alter table public.telegram_webhook_events enable row level security;
alter table public.telegram_alert_subscriptions enable row level security;
