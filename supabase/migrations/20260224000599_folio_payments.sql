-- ============================================================
-- Migration: Folio Payments
-- Date:      2026-02-24
-- Purpose:
--   Track actual money received (or refunded) per reservation.
--   Each row = 1 payment transaction.
--   Separate from Revenue (which is accrual/stay_date based).
-- ============================================================

-- PostgreSQL does not support CREATE TYPE IF NOT EXISTS
-- Use DO block to safely create enums only if they don't exist
DO $$ BEGIN
    CREATE TYPE public.payment_method_type AS ENUM (
        'cash', 'transfer', 'credit_card', 'other'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE public.payment_tx_type AS ENUM (
        'payment',
        'refund',
        'deposit'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


create table if not exists public.folio_payments (
  id              uuid primary key default gen_random_uuid(),
  reservation_id  uuid not null references public.reservations(id) on delete cascade,
  tx_type         public.payment_tx_type not null default 'payment',
  method          public.payment_method_type not null default 'cash',
  amount          numeric(10, 2) not null,         -- always positive; tx_type determines direction
  note            text,                             -- e.g. "Transfer ref 001", "Deposit refund"
  paid_at         timestamptz not null default timezone('utc', now()),
  paid_date       date not null,                   -- LOCAL date (for daily summary, set by server)
  recorded_by     uuid references public.profiles(user_id),
  created_at      timestamptz not null default timezone('utc', now())
);

create index if not exists idx_folio_payments_reservation
  on public.folio_payments (reservation_id);

create index if not exists idx_folio_payments_paid_date
  on public.folio_payments (paid_date);

-- ============================================================
-- VERIFY:
--   SELECT fp.paid_date, fp.method, fp.tx_type,
--          SUM(fp.amount) as total
--   FROM public.folio_payments fp
--   GROUP BY fp.paid_date, fp.method, fp.tx_type
--   ORDER BY fp.paid_date DESC;
-- ============================================================
