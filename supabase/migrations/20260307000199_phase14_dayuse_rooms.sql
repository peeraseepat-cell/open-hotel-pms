-- ============================================================
-- Phase 14: Day Use Rooms
-- ============================================================

-- 1) Rooms day-use flag
alter table public.rooms
  add column if not exists is_dayuse boolean not null default false;

-- 2) Reservations day-use fields
alter table public.reservations
  add column if not exists is_dayuse boolean not null default false,
  add column if not exists dayuse_expires_at timestamptz;

-- 3) reservation_nights dayuse_session
alter table public.reservation_nights
  add column if not exists dayuse_session smallint not null default 0;

-- 4) Replace unique index to allow multi-use same room/day
drop index if exists public.uq_reservation_nights_active_room_day;

create unique index if not exists uq_reservation_nights_room_date_session
  on public.reservation_nights (room_id, stay_date, dayuse_session)
  where cancelled_at is null;

-- 5) Relax reservation date range for same-day day use
alter table public.reservations
  drop constraint if exists reservation_date_range;

alter table public.reservations
  add constraint reservation_date_range
  check (checkout_date >= checkin_date);

-- 6) Extend folio revenue category constraint
alter table public.folio_payments
  drop constraint if exists folio_payments_revenue_category_check;

alter table public.folio_payments
  add constraint folio_payments_revenue_category_check
  check (
    revenue_category in (
      'room_revenue',
      'pos_revenue',
      'extra_charge',
      'deposit',
      'no_show_fee',
      'dayuse_revenue'
    )
  );

-- 7) Day-use config in hotel_settings
alter table public.hotel_settings
  add column if not exists dayuse_rate numeric(10,2) default 200.00,
  add column if not exists dayuse_duration_min int default 120,
  add column if not exists dayuse_extend_rate numeric(10,2) default 100.00,
  add column if not exists dayuse_extend_min int default 60;

-- 8) Daily snapshots day-use metrics
alter table public.daily_snapshots
  add column if not exists dayuse_revenue numeric(12,2) default 0,
  add column if not exists dayuse_sessions int default 0;

-- 9) Seed day-use rooms (silent skip if not found)
update public.rooms
set is_dayuse = true
where room_number in ('118', '120', '122');

-- 10) Helpful index
create index if not exists idx_reservations_dayuse_active
  on public.reservations (checkin_date, status)
  where is_dayuse = true and status = 'active';

