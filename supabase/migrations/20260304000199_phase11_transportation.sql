begin;

-- ═══════════════════════════════════════════════════
-- Phase 11: Transportation & Transfer Management
-- ═══════════════════════════════════════════════════

-- 1. boat_companies — บริษัทเรือ
create table if not exists public.boat_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  contact_phone text,
  contact_line text,
  contact_whatsapp text,
  website text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. boat_piers — ท่าเรือ (1 company → many piers)
create table if not exists public.boat_piers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.boat_companies(id) on delete cascade,
  name text not null,
  location_note text,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

create index if not exists idx_boat_piers_company on public.boat_piers (company_id);

-- 3. boat_routes — เส้นทาง + ตารางเวลา + ราคา + commission
create table if not exists public.boat_routes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.boat_companies(id) on delete cascade,
  departure_pier_id uuid references public.boat_piers(id) on delete set null,
  origin text not null,
  destination text not null,
  boat_type text default 'speedboat',
  departure_times text[],
  duration_minutes int,
  ticket_price numeric(10,2),
  cost_price numeric(10,2),
  includes_pickup boolean not null default false,
  pickup_fee numeric(10,2),
  season_label text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_boat_routes_company on public.boat_routes (company_id);
create index if not exists idx_boat_routes_active on public.boat_routes (is_active);

-- 4. drivers — คนขับ
create table if not exists public.drivers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  license_type text,
  company text,
  photo_url text,
  rating_avg numeric(3,2) not null default 0,
  total_trips int not null default 0,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_drivers_active on public.drivers (is_active);
create index if not exists idx_drivers_rating on public.drivers (rating_avg desc, total_trips desc);

-- 5. vehicles — รถ
create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  plate_number text not null unique,
  vehicle_type text not null default 'sedan',
  capacity int not null default 4,
  color text,
  default_driver_id uuid references public.drivers(id) on delete set null,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_vehicles_driver on public.vehicles (default_driver_id);
create index if not exists idx_vehicles_active on public.vehicles (is_active);

-- 6. transfers — การจอง Transfer (หัวใจระบบ)
create table if not exists public.transfers (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  guest_name text not null,
  guest_phone text,
  transfer_type text not null check (transfer_type in (
    'airport_pickup', 'airport_dropoff',
    'hotel_to_anywhere', 'bus_ferry_pickup', 'ticket_only'
  )),
  service_mode text not null default 'driver_only' check (service_mode in (
    'company_pickup', 'hotel_arrange', 'ticket_only', 'driver_only'
  )),
  pickup_datetime timestamptz not null,
  pickup_location text not null,
  dropoff_location text not null,
  pax int not null default 1,
  luggage_count int default 0,
  driver_id uuid references public.drivers(id) on delete set null,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  boat_company_id uuid references public.boat_companies(id) on delete set null,
  boat_route_id uuid references public.boat_routes(id) on delete set null,
  selling_price numeric(10,2),
  cost_price numeric(10,2),
  driver_fee numeric(10,2),
  driver_commission numeric(10,2) default 0,
  net_commission numeric(10,2),
  actual_price numeric(10,2),
  payment_status text not null default 'unpaid' check (payment_status in (
    'unpaid', 'paid_to_hotel', 'paid_to_driver', 'settled'
  )),
  payment_method text,
  status text not null default 'pending' check (status in (
    'pending', 'confirmed', 'driver_assigned', 'in_progress', 'completed', 'cancelled', 'no_show'
  )),
  staff_note text,
  guest_note text,
  voucher_note text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_transfers_pickup on public.transfers (pickup_datetime);
create index if not exists idx_transfers_reservation on public.transfers (reservation_id);
create index if not exists idx_transfers_driver on public.transfers (driver_id);
create index if not exists idx_transfers_status on public.transfers (status);
-- NOTE: do not create expression index on timestamptz::date (not immutable in Postgres).
-- Daily filters should use pickup_datetime range predicates and idx_transfers_pickup.

-- 7. driver_ratings — คะแนน per-trip (staff-only Phase 11)
create table if not exists public.driver_ratings (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.transfers(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  score_punctuality int not null check (score_punctuality between 1 and 5),
  score_value int not null check (score_value between 1 and 5),
  score_service int not null check (score_service between 1 and 5),
  comment text,
  rated_by text,
  created_at timestamptz not null default now(),
  unique (transfer_id)
);

create index if not exists idx_driver_ratings_driver on public.driver_ratings (driver_id);
create index if not exists idx_driver_ratings_created_at on public.driver_ratings (created_at desc);

-- 8. transfer_notifications — log แจ้งเตือน (in-app only Phase 11)
create table if not exists public.transfer_notifications (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.transfers(id) on delete cascade,
  notification_type text not null,
  channel text not null default 'in_app',
  message text,
  sent_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'acknowledged')),
  created_at timestamptz not null default now()
);

create index if not exists idx_transfer_notifications_transfer on public.transfer_notifications (transfer_id);
create index if not exists idx_transfer_notifications_status on public.transfer_notifications (status);

-- 9. transfer_vouchers — voucher data (for browser print)
create table if not exists public.transfer_vouchers (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null unique references public.transfers(id) on delete cascade,
  voucher_number text not null unique,
  guest_name text not null,
  route_description text,
  departure_time text,
  pier_name text,
  boat_company_name text,
  pickup_time text,
  pickup_location text,
  driver_name text,
  driver_phone text,
  vehicle_info text,
  special_instructions text,
  printed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_transfer_vouchers_number on public.transfer_vouchers (voucher_number);

-- Voucher number sequence (global running, no daily reset)
create sequence if not exists public.transfer_voucher_seq start with 1;

create or replace function public.generate_transfer_voucher_number()
returns text
language plpgsql
as $$
declare
  v_seq bigint;
  v_today text;
begin
  v_today := to_char(current_date, 'YYYYMMDD');
  v_seq := nextval('public.transfer_voucher_seq');
  return 'TRF-' || v_today || '-' || lpad(v_seq::text, 4, '0');
end;
$$;

-- Create transfer booking in one atomic DB transaction.
create or replace function public.transfer_create_booking(
  p_reservation_id uuid,
  p_transfer_type text,
  p_service_mode text,
  p_pickup_datetime timestamptz,
  p_pickup_location text,
  p_dropoff_location text,
  p_pax int default 1,
  p_luggage_count int default 0,
  p_driver_id uuid default null,
  p_vehicle_id uuid default null,
  p_boat_company_id uuid default null,
  p_boat_route_id uuid default null,
  p_selling_price numeric default null,
  p_cost_price numeric default null,
  p_driver_fee numeric default null,
  p_driver_commission numeric default 0,
  p_payment_method text default null,
  p_staff_note text default null,
  p_created_by text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation_status text;
  v_guest_name text;
  v_guest_phone text;
  v_transfer_id uuid;
  v_voucher_number text;
  v_payment_method text;
  v_payment_status text;
  v_transfer_status text;
  v_alert_code text;
  v_alert_line text;
  v_alert_note text;
  v_alert_id uuid;
  v_trace_text text;
  v_pickup_date date;
  v_pickup_time text;
  v_driver_name text;
  v_driver_phone text;
  v_vehicle_info text;
  v_boat_company_name text;
  v_pier_name text;
  v_route_description text;
  v_departure_time text;
  v_operator_label text;
  v_net_commission numeric(10,2);
  v_selling_price numeric(10,2);
  v_cost_price numeric(10,2);
  v_driver_fee numeric(10,2);
  v_driver_commission numeric(10,2);
  v_alert_created boolean := false;
  v_trace_created boolean := false;
  v_folio_posted boolean := false;
begin
  if p_reservation_id is null then
    raise exception 'reservation_id is required';
  end if;
  if p_pickup_datetime is null then
    raise exception 'pickup_datetime is required';
  end if;
  if p_pickup_datetime <= now() then
    raise exception 'pickup_datetime must be future';
  end if;
  if coalesce(trim(p_pickup_location), '') = '' then
    raise exception 'pickup_location is required';
  end if;
  if coalesce(trim(p_dropoff_location), '') = '' then
    raise exception 'dropoff_location is required';
  end if;
  if coalesce(p_pax, 0) <= 0 then
    raise exception 'pax must be greater than 0';
  end if;
  if coalesce(p_driver_commission, 0) < 0 then
    raise exception 'driver_commission must be >= 0';
  end if;
  if p_selling_price is not null and p_selling_price < 0 then
    raise exception 'selling_price must be >= 0';
  end if;
  if p_cost_price is not null and p_cost_price < 0 then
    raise exception 'cost_price must be >= 0';
  end if;
  if p_driver_fee is not null and p_driver_fee < 0 then
    raise exception 'driver_fee must be >= 0';
  end if;

  select
    r.status::text,
    r.guest_name,
    coalesce(nullif(trim(r.phone), ''), nullif(trim(gp.phone), ''))
  into
    v_reservation_status,
    v_guest_name,
    v_guest_phone
  from public.reservations r
  left join public.guest_profiles gp on gp.id = r.guest_profile_id
  where r.id = p_reservation_id;

  if not found then
    raise exception 'Reservation not found';
  end if;
  if v_reservation_status <> 'active' then
    raise exception 'Reservation must be active to create transfer';
  end if;

  v_payment_method := nullif(trim(coalesce(p_payment_method, '')), '');
  if v_payment_method is not null and v_payment_method not in ('cash', 'transfer', 'credit_card', 'other') then
    raise exception 'payment_method must be cash|transfer|credit_card|other';
  end if;

  v_selling_price := case when p_selling_price is null then null else round(p_selling_price::numeric, 2) end;
  v_cost_price := case when p_cost_price is null then null else round(p_cost_price::numeric, 2) end;
  v_driver_fee := case when p_driver_fee is null then null else round(p_driver_fee::numeric, 2) end;
  v_driver_commission := round(coalesce(p_driver_commission, 0)::numeric, 2);

  v_net_commission := round(
    coalesce(v_selling_price, 0)
    - coalesce(v_cost_price, 0)
    - coalesce(v_driver_fee, 0)
    + coalesce(v_driver_commission, 0),
    2
  );

  if v_payment_method is not null then
    v_payment_status := 'paid_to_hotel';
    if v_selling_price is null or v_selling_price <= 0 then
      raise exception 'selling_price must be > 0 when payment_method is provided';
    end if;
  else
    v_payment_status := 'unpaid';
  end if;

  if p_driver_id is not null then
    v_transfer_status := 'driver_assigned';
  else
    v_transfer_status := 'pending';
  end if;

  v_pickup_date := (p_pickup_datetime at time zone 'Asia/Bangkok')::date;
  v_pickup_time := to_char((p_pickup_datetime at time zone 'Asia/Bangkok'), 'HH24:MI');

  if p_driver_id is not null then
    select d.name, d.phone into v_driver_name, v_driver_phone
    from public.drivers d
    where d.id = p_driver_id;
  end if;

  if p_vehicle_id is not null then
    select concat_ws(' ', v.vehicle_type, '-', v.plate_number, coalesce('(' || v.color || ')', ''))
    into v_vehicle_info
    from public.vehicles v
    where v.id = p_vehicle_id;
  end if;

  if p_boat_route_id is not null then
    select
      br.origin || ' -> ' || br.destination,
      br.departure_times[1],
      bp.name,
      bc.name
    into
      v_route_description,
      v_departure_time,
      v_pier_name,
      v_boat_company_name
    from public.boat_routes br
    left join public.boat_piers bp on bp.id = br.departure_pier_id
    left join public.boat_companies bc on bc.id = br.company_id
    where br.id = p_boat_route_id;
  elsif p_boat_company_id is not null then
    select bc.name into v_boat_company_name
    from public.boat_companies bc
    where bc.id = p_boat_company_id;
  end if;

  if v_route_description is null then
    v_route_description := p_pickup_location || ' -> ' || p_dropoff_location;
  end if;

  insert into public.transfers (
    reservation_id,
    guest_name,
    guest_phone,
    transfer_type,
    service_mode,
    pickup_datetime,
    pickup_location,
    dropoff_location,
    pax,
    luggage_count,
    driver_id,
    vehicle_id,
    boat_company_id,
    boat_route_id,
    selling_price,
    cost_price,
    driver_fee,
    driver_commission,
    net_commission,
    payment_status,
    payment_method,
    status,
    staff_note,
    created_by
  )
  values (
    p_reservation_id,
    v_guest_name,
    v_guest_phone,
    p_transfer_type,
    p_service_mode,
    p_pickup_datetime,
    p_pickup_location,
    p_dropoff_location,
    coalesce(p_pax, 1),
    coalesce(p_luggage_count, 0),
    p_driver_id,
    p_vehicle_id,
    p_boat_company_id,
    p_boat_route_id,
    v_selling_price,
    v_cost_price,
    v_driver_fee,
    v_driver_commission,
    v_net_commission,
    v_payment_status,
    v_payment_method,
    v_transfer_status,
    nullif(trim(coalesce(p_staff_note, '')), ''),
    nullif(trim(coalesce(p_created_by, '')), '')
  )
  returning id into v_transfer_id;

  v_voucher_number := public.generate_transfer_voucher_number();
  v_operator_label := coalesce(nullif(v_boat_company_name, ''), nullif(v_driver_name, ''), 'Transfer');

  insert into public.transfer_vouchers (
    transfer_id,
    voucher_number,
    guest_name,
    route_description,
    departure_time,
    pier_name,
    boat_company_name,
    pickup_time,
    pickup_location,
    driver_name,
    driver_phone,
    vehicle_info,
    special_instructions
  )
  values (
    v_transfer_id,
    v_voucher_number,
    v_guest_name,
    v_route_description,
    v_departure_time,
    v_pier_name,
    v_boat_company_name,
    v_pickup_time,
    p_pickup_location,
    v_driver_name,
    v_driver_phone,
    v_vehicle_info,
    nullif(trim(coalesce(p_staff_note, '')), '')
  );

  v_alert_code := case
    when p_transfer_type in ('bus_ferry_pickup', 'ticket_only') then 'BOAT'
    else 'CAR'
  end;
  v_alert_line := '[' || v_voucher_number || '] ' || v_pickup_time || ' ' || v_operator_label;

  select ra.id, ra.note
  into v_alert_id, v_alert_note
  from public.reservation_alerts ra
  where ra.reservation_id = p_reservation_id
    and ra.alert_code = v_alert_code
  for update;

  if not found then
    insert into public.reservation_alerts (reservation_id, alert_code, note)
    values (p_reservation_id, v_alert_code, v_alert_line);
  else
    if coalesce(trim(v_alert_note), '') = '' then
      v_alert_note := v_alert_line;
    elsif strpos(v_alert_note, v_alert_line) > 0 then
      v_alert_note := v_alert_note;
    else
      v_alert_note := v_alert_note || E'\n' || v_alert_line;
    end if;

    update public.reservation_alerts
    set note = v_alert_note
    where id = v_alert_id;
  end if;
  v_alert_created := true;

  v_trace_text := '[TRANSFER][' || v_voucher_number || '] '
    || p_transfer_type
    || ' pickup '
    || v_pickup_time
    || ' - '
    || v_operator_label;

  insert into public.reservation_traces (
    reservation_id,
    created_by,
    dept,
    trace_text,
    from_date,
    to_date,
    status
  )
  values (
    p_reservation_id,
    nullif(trim(coalesce(p_created_by, '')), ''),
    'FD',
    v_trace_text,
    v_pickup_date,
    v_pickup_date,
    'open'
  );
  v_trace_created := true;

  if v_payment_status = 'paid_to_hotel' and v_selling_price is not null and v_selling_price > 0 then
    insert into public.folio_payments (
      reservation_id,
      tx_type,
      method,
      amount,
      note,
      paid_date,
      paid_at
    )
    values (
      p_reservation_id,
      'payment',
      v_payment_method::public.payment_method_type,
      v_selling_price,
      'Transfer: ' || p_transfer_type || ' - ' || v_voucher_number,
      current_date,
      now()
    );
    v_folio_posted := true;
  end if;

  return jsonb_build_object(
    'success', true,
    'transfer_id', v_transfer_id,
    'voucher_number', v_voucher_number,
    'alert_created', v_alert_created,
    'trace_created', v_trace_created,
    'folio_posted', v_folio_posted
  );
end;
$$;

-- RLS Policies (service role only)
alter table public.boat_companies enable row level security;
drop policy if exists boat_companies_service_role_full_access on public.boat_companies;
create policy boat_companies_service_role_full_access on public.boat_companies
for all to service_role
using (true)
with check (true);

alter table public.boat_piers enable row level security;
drop policy if exists boat_piers_service_role_full_access on public.boat_piers;
create policy boat_piers_service_role_full_access on public.boat_piers
for all to service_role
using (true)
with check (true);

alter table public.boat_routes enable row level security;
drop policy if exists boat_routes_service_role_full_access on public.boat_routes;
create policy boat_routes_service_role_full_access on public.boat_routes
for all to service_role
using (true)
with check (true);

alter table public.drivers enable row level security;
drop policy if exists drivers_service_role_full_access on public.drivers;
create policy drivers_service_role_full_access on public.drivers
for all to service_role
using (true)
with check (true);

alter table public.vehicles enable row level security;
drop policy if exists vehicles_service_role_full_access on public.vehicles;
create policy vehicles_service_role_full_access on public.vehicles
for all to service_role
using (true)
with check (true);

alter table public.transfers enable row level security;
drop policy if exists transfers_service_role_full_access on public.transfers;
create policy transfers_service_role_full_access on public.transfers
for all to service_role
using (true)
with check (true);

alter table public.driver_ratings enable row level security;
drop policy if exists driver_ratings_service_role_full_access on public.driver_ratings;
create policy driver_ratings_service_role_full_access on public.driver_ratings
for all to service_role
using (true)
with check (true);

alter table public.transfer_notifications enable row level security;
drop policy if exists transfer_notifications_service_role_full_access on public.transfer_notifications;
create policy transfer_notifications_service_role_full_access on public.transfer_notifications
for all to service_role
using (true)
with check (true);

alter table public.transfer_vouchers enable row level security;
drop policy if exists transfer_vouchers_service_role_full_access on public.transfer_vouchers;
create policy transfer_vouchers_service_role_full_access on public.transfer_vouchers
for all to service_role
using (true)
with check (true);

-- Updated_at triggers
drop trigger if exists trg_boat_companies_updated_at on public.boat_companies;
create trigger trg_boat_companies_updated_at
before update on public.boat_companies
for each row execute function public.set_updated_at();

drop trigger if exists trg_boat_routes_updated_at on public.boat_routes;
create trigger trg_boat_routes_updated_at
before update on public.boat_routes
for each row execute function public.set_updated_at();

drop trigger if exists trg_drivers_updated_at on public.drivers;
create trigger trg_drivers_updated_at
before update on public.drivers
for each row execute function public.set_updated_at();

drop trigger if exists trg_vehicles_updated_at on public.vehicles;
create trigger trg_vehicles_updated_at
before update on public.vehicles
for each row execute function public.set_updated_at();

drop trigger if exists trg_transfers_updated_at on public.transfers;
create trigger trg_transfers_updated_at
before update on public.transfers
for each row execute function public.set_updated_at();

-- Seed Data
insert into public.boat_companies (name, contact_phone, website)
values ('Lomprayah High-Speed Ferry', null, 'https://www.lomprayah.com/')
on conflict (name) do nothing;

insert into public.boat_piers (company_id, name, location_note)
values
  (
    (select id from public.boat_companies where name = 'Lomprayah High-Speed Ferry'),
    'Example Pier',
    'ถนนตัวอย่าง'
  ),
  (
    (select id from public.boat_companies where name = 'Lomprayah High-Speed Ferry'),
    'Example Pier',
    'อ.ตัวอย่าง'
  )
on conflict (company_id, name) do nothing;

insert into public.boat_companies (name, website)
values ('Raja Ferry Port', 'https://www.rajaferryport.com/')
on conflict (name) do nothing;

insert into public.boat_routes (
  company_id,
  departure_pier_id,
  origin,
  destination,
  boat_type,
  departure_times,
  duration_minutes,
  ticket_price,
  cost_price
)
values
  (
    (select id from public.boat_companies where name = 'Lomprayah High-Speed Ferry'),
    (
      select bp.id
      from public.boat_piers bp
      join public.boat_companies bc on bc.id = bp.company_id
      where bc.name = 'Lomprayah High-Speed Ferry'
        and bp.name = 'Example Pier'
      limit 1
    ),
    'Example Pier', 'Island A', 'speedboat',
    array['08:00', '12:00'], 90, null, null
  ),
  (
    (select id from public.boat_companies where name = 'Lomprayah High-Speed Ferry'),
    (
      select bp.id
      from public.boat_piers bp
      join public.boat_companies bc on bc.id = bp.company_id
      where bc.name = 'Lomprayah High-Speed Ferry'
        and bp.name = 'Example Pier'
      limit 1
    ),
    'Example Pier', 'Island B', 'speedboat',
    array['08:00', '12:00'], 120, null, null
  ),
  (
    (select id from public.boat_companies where name = 'Lomprayah High-Speed Ferry'),
    (
      select bp.id
      from public.boat_piers bp
      join public.boat_companies bc on bc.id = bp.company_id
      where bc.name = 'Lomprayah High-Speed Ferry'
        and bp.name = 'Example Pier'
      limit 1
    ),
    'Example Pier', 'Island C', 'speedboat',
    array['08:00'], 150, null, null
  )
on conflict do nothing;

grant execute on function public.generate_transfer_voucher_number() to anon, authenticated;
grant execute on function public.transfer_create_booking(
  uuid,
  text,
  text,
  timestamptz,
  text,
  text,
  int,
  int,
  uuid,
  uuid,
  uuid,
  uuid,
  numeric,
  numeric,
  numeric,
  numeric,
  text,
  text,
  text
) to anon, authenticated;

commit;
