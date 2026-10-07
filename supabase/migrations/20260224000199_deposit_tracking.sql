-- ============================================================
-- Migration: Deposit Tracking
-- Date:      2026-02-24
-- Purpose:
--   Add deposit fields to reservations table:
--     deposit_amount  — amount requested at booking time
--     deposit_paid_at — when it was collected
--     deposit_note    — payment method or reference
-- ============================================================

alter table public.reservations
  add column if not exists deposit_amount  numeric(10, 2) not null default 0,
  add column if not exists deposit_paid_at timestamptz,
  add column if not exists deposit_note    text;

-- Optional: partial index to quickly find unpaid deposits
create index if not exists idx_reservations_unpaid_deposit
  on public.reservations (checkin_date)
  where deposit_amount > 0 and deposit_paid_at is null;

-- ============================================================
-- VERIFY:
--   SELECT id, booking_code, guest_name, deposit_amount,
--          deposit_paid_at, deposit_note
--   FROM public.reservations
--   ORDER BY created_at DESC LIMIT 5;
-- ============================================================
