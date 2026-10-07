-- ============================================================
-- Migration: Hotel Settings & Daily Snapshots (EOD System)
-- Date:      2026-02-24
-- ============================================================

-- Part 1: Extend hotel_settings with EOD fields
-- (Assumes hotel_settings table already exists from init migration)
create table if not exists public.hotel_settings (
  id                  int primary key default 1,              -- singleton row
  hotel_name          text not null default 'My Hotel',
  hotel_timezone      text not null default 'Asia/Bangkok',
  sellable_rooms      int  not null default 0,
  business_date       date not null default current_date,
  eod_reminder_time   time not null default '02:00',
  check_in_time       time not null default '14:00',
  check_out_time      time not null default '12:00',
  late_checkout_fee   numeric(10,2) not null default 0,
  updated_at          timestamptz not null default timezone('utc', now()),
  constraint hotel_settings_singleton check (id = 1)
);

-- Ensure exactly 1 row exists
insert into public.hotel_settings (id) values (1)
on conflict (id) do nothing;

-- Add columns if table already had rows
alter table public.hotel_settings
  add column if not exists business_date       date not null default current_date,
  add column if not exists eod_reminder_time   time not null default '02:00',
  add column if not exists hotel_name          text,
  add column if not exists hotel_timezone      text not null default 'Asia/Bangkok',
  add column if not exists sellable_rooms      int  not null default 0,
  add column if not exists check_in_time       time not null default '14:00',
  add column if not exists check_out_time      time not null default '12:00',
  add column if not exists late_checkout_fee   numeric(10,2) not null default 0;

-- Part 2: Daily Snapshots  
create table if not exists public.daily_snapshots (
  id               uuid primary key default gen_random_uuid(),
  business_date    date unique not null,
  -- Revenue (accrual basis from reservation_nights.stay_date)
  total_revenue    numeric(12, 2) not null default 0,
  occupied_nights  int           not null default 0,
  room_nights      int           not null default 0,
  occupancy_pct    numeric(5, 2) not null default 0,
  adr              numeric(10, 2) not null default 0,
  revpar           numeric(10, 2) not null default 0,
  by_source        jsonb         not null default '{}',
  -- Payments (cash basis from folio_payments.paid_date)
  payment_cash     numeric(12, 2) not null default 0,
  payment_transfer numeric(12, 2) not null default 0,
  payment_card     numeric(12, 2) not null default 0,
  payment_other    numeric(12, 2) not null default 0,
  payment_total    numeric(12, 2) not null default 0,
  -- Metadata
  eod_run_at       timestamptz not null default timezone('utc', now()),
  eod_run_by       uuid references public.profiles(user_id),
  notes            text
);

create index if not exists idx_daily_snapshots_date
  on public.daily_snapshots (business_date desc);

-- ============================================================
-- VERIFY:
--   SELECT * FROM public.hotel_settings;
--   SELECT * FROM public.daily_snapshots ORDER BY business_date DESC LIMIT 5;
-- ============================================================
