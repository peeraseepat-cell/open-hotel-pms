begin;

-- ============================================================
-- Phase 11A: Accounting Backbone (Agent B scope)
-- ============================================================

create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────────
-- transfer_transactions (separate from folio_payments)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.transfer_transactions (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.transfers(id) on delete cascade,
  reservation_id uuid references public.reservations(id) on delete set null,
  guest_profile_id uuid references public.guest_profiles(id) on delete set null,
  tx_type text not null check (tx_type in ('charge', 'refund', 'adjustment')),
  amount numeric(10,2) not null check (amount >= 0),
  selling_price numeric(10,2),
  cost_price numeric(10,2),
  margin numeric(10,2),
  payment_method public.payment_method_type,
  cashier_name text,
  note text,
  transaction_date date not null default current_date,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_transfer_transactions_date
  on public.transfer_transactions (transaction_date desc);

create index if not exists idx_transfer_transactions_transfer
  on public.transfer_transactions (transfer_id);

create index if not exists idx_transfer_transactions_reservation
  on public.transfer_transactions (reservation_id);

create index if not exists idx_transfer_transactions_guest
  on public.transfer_transactions (guest_profile_id);

-- ─────────────────────────────────────────────────────────────
-- commission_ledger (1 transfer = 1 commission, idempotent)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.commission_ledger (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null unique references public.transfers(id) on delete cascade,
  reservation_id uuid references public.reservations(id) on delete set null,
  guest_profile_id uuid references public.guest_profiles(id) on delete set null,
  staff_name text not null,
  rule_type text not null default 'fixed' check (rule_type in ('pct_sell', 'pct_margin', 'fixed')),
  rule_value numeric(10,2) not null default 0,
  base_amount numeric(10,2) not null default 0,
  commission_amount numeric(10,2) not null default 0 check (commission_amount >= 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'paid', 'reversed')),
  payout_cycle text not null default 'monthly' check (payout_cycle in ('monthly', 'bimonthly')),
  approved_by text,
  approved_at timestamptz,
  paid_at timestamptz,
  reversal_reason text,
  reversed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint commission_reversal_reason_required
    check (status <> 'reversed' or (reversal_reason is not null and btrim(reversal_reason) <> ''))
);

create index if not exists idx_commission_ledger_status
  on public.commission_ledger (status);

create index if not exists idx_commission_ledger_created_at
  on public.commission_ledger (created_at desc);

create index if not exists idx_commission_ledger_staff
  on public.commission_ledger (staff_name);

drop trigger if exists trg_commission_ledger_updated_at on public.commission_ledger;
create trigger trg_commission_ledger_updated_at
before update on public.commission_ledger
for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- tip_ledger
-- ─────────────────────────────────────────────────────────────
create table if not exists public.tip_ledger (
  id uuid primary key default gen_random_uuid(),
  tip_type text not null check (tip_type in ('unassigned', 'manual_staff')),
  reservation_id uuid references public.reservations(id) on delete set null,
  guest_profile_id uuid references public.guest_profiles(id) on delete set null,
  transfer_id uuid references public.transfers(id) on delete set null,
  amount numeric(10,2) not null check (amount > 0),
  payment_method public.payment_method_type not null default 'cash',
  assigned_to text,
  recorded_by text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'paid', 'reversed')),
  approved_at timestamptz,
  paid_at timestamptz,
  reversal_reason text,
  reversed_at timestamptz,
  note text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint tip_manual_staff_link_required
    check (
      tip_type <> 'manual_staff'
      or (reservation_id is not null and guest_profile_id is not null)
    ),
  constraint tip_reversal_reason_required
    check (status <> 'reversed' or (reversal_reason is not null and btrim(reversal_reason) <> ''))
);

create index if not exists idx_tip_ledger_status
  on public.tip_ledger (status);

create index if not exists idx_tip_ledger_created_at
  on public.tip_ledger (created_at desc);

create index if not exists idx_tip_ledger_reservation
  on public.tip_ledger (reservation_id);

create index if not exists idx_tip_ledger_guest
  on public.tip_ledger (guest_profile_id);

drop trigger if exists trg_tip_ledger_updated_at on public.tip_ledger;
create trigger trg_tip_ledger_updated_at
before update on public.tip_ledger
for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- folio_payments enhancement (hotel revenue only)
-- ─────────────────────────────────────────────────────────────
alter table public.folio_payments
  add column if not exists revenue_category text,
  add column if not exists cashier_name text;

update public.folio_payments
set revenue_category = case
  when revenue_category is not null then revenue_category
  when tx_type = 'deposit' then 'deposit'
  when pos_order_id is not null then 'pos_revenue'
  else 'room_revenue'
end;

alter table public.folio_payments
  alter column revenue_category set default 'room_revenue';

update public.folio_payments
set revenue_category = 'room_revenue'
where revenue_category is null;

alter table public.folio_payments
  alter column revenue_category set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'folio_payments_revenue_category_check'
  ) then
    alter table public.folio_payments
      add constraint folio_payments_revenue_category_check
      check (revenue_category in ('room_revenue', 'pos_revenue', 'extra_charge', 'deposit'));
  end if;
end $$;

create index if not exists idx_folio_payments_revenue_category
  on public.folio_payments (revenue_category);

create index if not exists idx_folio_payments_cashier_name
  on public.folio_payments (cashier_name);

-- ─────────────────────────────────────────────────────────────
-- audit_logs enhancement
-- ─────────────────────────────────────────────────────────────
alter table public.audit_logs
  add column if not exists change_reason text,
  add column if not exists ip_address text;

create index if not exists idx_audit_logs_entity_created
  on public.audit_logs (entity_type, entity_id, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- daily_snapshots enhancement
-- ─────────────────────────────────────────────────────────────
alter table public.daily_snapshots
  add column if not exists transfer_revenue numeric(12,2) not null default 0,
  add column if not exists transfer_cost numeric(12,2) not null default 0,
  add column if not exists transfer_margin numeric(12,2) not null default 0,
  add column if not exists pos_revenue numeric(12,2) not null default 0,
  add column if not exists tip_total numeric(12,2) not null default 0,
  add column if not exists commission_liability numeric(12,2) not null default 0,
  add column if not exists deposit_received numeric(12,2) not null default 0,
  add column if not exists deposit_refunded numeric(12,2) not null default 0;

-- ─────────────────────────────────────────────────────────────
-- RLS (service role full access)
-- ─────────────────────────────────────────────────────────────
alter table public.transfer_transactions enable row level security;
drop policy if exists transfer_transactions_service_role_full_access on public.transfer_transactions;
create policy transfer_transactions_service_role_full_access on public.transfer_transactions
for all to service_role
using (true)
with check (true);

alter table public.commission_ledger enable row level security;
drop policy if exists commission_ledger_service_role_full_access on public.commission_ledger;
create policy commission_ledger_service_role_full_access on public.commission_ledger
for all to service_role
using (true)
with check (true);

alter table public.tip_ledger enable row level security;
drop policy if exists tip_ledger_service_role_full_access on public.tip_ledger;
create policy tip_ledger_service_role_full_access on public.tip_ledger
for all to service_role
using (true)
with check (true);

commit;
