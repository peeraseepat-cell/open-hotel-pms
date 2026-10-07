-- Phase 55: SCB Mae Manee transfer automation core
-- Sandbox-first rollout

create table if not exists public.scb_payment_requests (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('reservation', 'pos_order')),
  target_id uuid not null,
  channel text not null check (channel in ('booking_folio', 'mobile_checkin', 'pos')),
  mode text not null check (mode in ('outstanding', 'custom')),
  currency text not null default 'THB',
  request_amount_total numeric(12,2) not null check (request_amount_total > 0),
  room_amount numeric(12,2) not null default 0 check (room_amount >= 0),
  deposit_amount numeric(12,2) not null default 0 check (deposit_amount >= 0),
  status text not null check (status in ('pending', 'paid', 'expired', 'cancelled', 'failed', 'unmatched')),
  partner_reference_no text not null unique,
  scb_order_id text null,
  wallet_id text null,
  scb_ref_1 text null,
  scb_ref_2 text null,
  scb_ref_3 text null,
  qr_payload text null,
  qr_image_base64 text null,
  request_payload jsonb not null default '{}'::jsonb,
  provider_raw_response jsonb null,
  error_message text null,
  expires_at timestamptz not null,
  auto_inquiry_after_expiry_at timestamptz not null,
  paid_transaction_id uuid null,
  created_by uuid null references public.profiles(user_id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists uq_scb_payment_requests_active_pending_target
  on public.scb_payment_requests (target_type, target_id)
  where status = 'pending';

create index if not exists idx_scb_payment_requests_status_created
  on public.scb_payment_requests (status, created_at desc);

create index if not exists idx_scb_payment_requests_expires_at
  on public.scb_payment_requests (expires_at);

create table if not exists public.scb_payment_transactions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid null references public.scb_payment_requests(id) on delete set null,
  transaction_id text not null unique,
  order_id text null,
  partner_reference_no text null,
  amount numeric(12,2) not null default 0,
  currency text not null default 'THB',
  payer_name text null,
  payer_account text null,
  payment_channel text null,
  paid_at timestamptz null,
  status text not null check (status in ('pending', 'success', 'failed', 'expired')),
  match_status text not null check (match_status in ('matched', 'unmatched', 'ignored', 'duplicate', 'matching')),
  raw_payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_scb_payment_transactions_request_id
  on public.scb_payment_transactions (request_id);

create index if not exists idx_scb_payment_transactions_match_status_created
  on public.scb_payment_transactions (match_status, created_at desc);

create table if not exists public.scb_recheck_logs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid null references public.scb_payment_requests(id) on delete set null,
  transaction_id text null,
  triggered_by uuid null references public.profiles(user_id),
  source text not null check (source in ('callback_retry', 'manual', 'scheduled')),
  result_status text not null,
  raw_payload jsonb null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_scb_recheck_logs_request_id_created
  on public.scb_recheck_logs (request_id, created_at desc);
