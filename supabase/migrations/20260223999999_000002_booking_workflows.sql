begin;

create or replace function public.generate_booking_code()
returns text
language plpgsql
set search_path = public
as $$
declare
  v_code text;
  v_try int := 0;
begin
  loop
    v_try := v_try + 1;
    v_code := 'BK-' || to_char(timezone('utc', now()), 'YYYYMMDDHH24MISSMS') || '-' || upper(substring(gen_random_uuid()::text from 1 for 6));
    exit when not exists (select 1 from public.reservations where booking_code = v_code);

    if v_try >= 20 then
      raise exception 'Cannot generate unique booking code';
    end if;
  end loop;

  return v_code;
end;
$$;

create or replace function public.booking_create_reservation(
  p_guest_name text,
  p_room_number text,
  p_checkin_date date,
  p_checkout_date date,
  p_source public.booking_source default 'walkin',
  p_phone text default null,
  p_checkin_time text default null,
  p_note text default null,
  p_ota_prices numeric[] default null,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_room public.rooms%rowtype;
  v_night_dates date[];
  v_nights_count int;
  v_prices numeric[];
  v_total_price numeric(10, 2);
  v_reservation_id uuid;
  v_booking_code text;
  v_conflict_date date;
  v_normalized_phone text;
  v_normalized_checkin_time text;
  v_normalized_note text;
begin
  if p_guest_name is null or btrim(p_guest_name) = '' then
    raise exception 'guest_name is required';
  end if;

  if p_room_number is null or btrim(p_room_number) = '' then
    raise exception 'room_number is required';
  end if;

  if p_checkout_date <= p_checkin_date then
    raise exception 'checkout_date must be after checkin_date';
  end if;

  select *
  into v_room
  from public.rooms
  where room_number = btrim(p_room_number)
  for update;

  if not found then
    raise exception 'Room not found';
  end if;

  if not v_room.is_sellable then
    raise exception 'Room % is not sellable', v_room.room_number;
  end if;

  select coalesce(array_agg(day::date order by day::date), array[]::date[])
  into v_night_dates
  from generate_series(
    p_checkin_date::timestamp,
    (p_checkout_date - interval '1 day')::timestamp,
    interval '1 day'
  ) as day;

  v_nights_count := cardinality(v_night_dates);
  if v_nights_count = 0 then
    raise exception 'No nights generated for selected date range';
  end if;

  select rn.stay_date
  into v_conflict_date
  from public.reservation_nights rn
  where rn.room_id = v_room.id
    and rn.cancelled_at is null
    and rn.stay_date = any(v_night_dates)
  limit 1;

  if v_conflict_date is not null then
    raise exception 'Room % already booked on %', v_room.room_number, v_conflict_date;
  end if;

  if p_source = 'ota' then
    if p_ota_prices is null or cardinality(p_ota_prices) <> v_nights_count then
      raise exception 'OTA bookings require ota_prices length = %', v_nights_count;
    end if;

    select coalesce(array_agg(round(coalesce(ota.price, 0)::numeric, 2) order by ota.idx), array[]::numeric[])
    into v_prices
    from unnest(p_ota_prices) with ordinality as ota(price, idx);
  else
    select coalesce(array_agg(coalesce(rt.price, 0)::numeric(10, 2) order by d.stay_date), array[]::numeric[])
    into v_prices
    from unnest(v_night_dates) as d(stay_date)
    left join public.rate_templates rt
      on rt.room_id = v_room.id
     and rt.stay_date = d.stay_date;
  end if;

  select round(coalesce(sum(coalesce(price, 0)), 0)::numeric, 2)
  into v_total_price
  from unnest(v_prices) as p(price);

  v_booking_code := public.generate_booking_code();
  v_normalized_phone := nullif(btrim(coalesce(p_phone, '')), '');
  v_normalized_checkin_time := nullif(btrim(coalesce(p_checkin_time, '')), '');
  v_normalized_note := nullif(btrim(coalesce(p_note, '')), '');

  insert into public.reservations (
    booking_code,
    guest_name,
    phone,
    source,
    status,
    checkin_date,
    checkout_date,
    checkin_time,
    note,
    total_price,
    created_by,
    updated_by
  )
  values (
    v_booking_code,
    btrim(p_guest_name),
    v_normalized_phone,
    p_source,
    'active',
    p_checkin_date,
    p_checkout_date,
    v_normalized_checkin_time,
    v_normalized_note,
    v_total_price,
    p_actor_user_id,
    p_actor_user_id
  )
  returning id into v_reservation_id;

  insert into public.reservation_nights (
    reservation_id,
    room_id,
    stay_date,
    nightly_price,
    is_ota
  )
  select
    v_reservation_id,
    v_room.id,
    d.stay_date,
    round(coalesce(pr.price, 0)::numeric, 2),
    p_source = 'ota'
  from unnest(v_night_dates) with ordinality as d(stay_date, idx)
  join unnest(v_prices) with ordinality as pr(price, idx)
    on pr.idx = d.idx;

  insert into public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    after_json
  )
  values (
    p_actor_user_id,
    'booking_created',
    'reservation',
    v_reservation_id::text,
    jsonb_build_object(
      'booking_code', v_booking_code,
      'room_number', v_room.room_number,
      'checkin_date', p_checkin_date,
      'checkout_date', p_checkout_date,
      'total_price', v_total_price
    )
  );

  return jsonb_build_object(
    'id', v_reservation_id,
    'booking_code', v_booking_code,
    'guest_name', btrim(p_guest_name),
    'room_number', v_room.room_number,
    'source', p_source,
    'checkin_date', p_checkin_date,
    'checkout_date', p_checkout_date,
    'total_nights', v_nights_count,
    'nightly_prices', to_jsonb(v_prices),
    'total_price', v_total_price
  );
end;
$$;

create or replace function public.booking_update_reservation(
  p_reservation_id uuid,
  p_guest_name text,
  p_room_number text,
  p_checkin_date date,
  p_checkout_date date,
  p_source public.booking_source default 'walkin',
  p_phone text default null,
  p_checkin_time text default null,
  p_note text default null,
  p_ota_prices numeric[] default null,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_reservation public.reservations%rowtype;
  v_room public.rooms%rowtype;
  v_night_dates date[];
  v_nights_count int;
  v_prices numeric[];
  v_total_price numeric(10, 2);
  v_conflict_date date;
  v_replaced_nights int;
  v_cancelled_at timestamptz;
  v_before jsonb;
  v_normalized_phone text;
  v_normalized_checkin_time text;
  v_normalized_note text;
begin
  if p_guest_name is null or btrim(p_guest_name) = '' then
    raise exception 'guest_name is required';
  end if;

  if p_room_number is null or btrim(p_room_number) = '' then
    raise exception 'room_number is required';
  end if;

  if p_checkout_date <= p_checkin_date then
    raise exception 'checkout_date must be after checkin_date';
  end if;

  select *
  into v_reservation
  from public.reservations
  where id = p_reservation_id
  for update;

  if not found then
    raise exception 'Reservation not found';
  end if;

  if v_reservation.status <> 'active' then
    raise exception 'Reservation is not active';
  end if;

  select *
  into v_room
  from public.rooms
  where room_number = btrim(p_room_number)
  for update;

  if not found then
    raise exception 'Room not found';
  end if;

  if not v_room.is_sellable then
    raise exception 'Room % is not sellable', v_room.room_number;
  end if;

  select coalesce(array_agg(day::date order by day::date), array[]::date[])
  into v_night_dates
  from generate_series(
    p_checkin_date::timestamp,
    (p_checkout_date - interval '1 day')::timestamp,
    interval '1 day'
  ) as day;

  v_nights_count := cardinality(v_night_dates);
  if v_nights_count = 0 then
    raise exception 'No nights generated for selected date range';
  end if;

  select rn.stay_date
  into v_conflict_date
  from public.reservation_nights rn
  where rn.room_id = v_room.id
    and rn.cancelled_at is null
    and rn.stay_date = any(v_night_dates)
    and rn.reservation_id <> p_reservation_id
  limit 1;

  if v_conflict_date is not null then
    raise exception 'Room % already booked on %', v_room.room_number, v_conflict_date;
  end if;

  if p_source = 'ota' then
    if p_ota_prices is null or cardinality(p_ota_prices) <> v_nights_count then
      raise exception 'OTA bookings require ota_prices length = %', v_nights_count;
    end if;

    select coalesce(array_agg(round(coalesce(ota.price, 0)::numeric, 2) order by ota.idx), array[]::numeric[])
    into v_prices
    from unnest(p_ota_prices) with ordinality as ota(price, idx);
  else
    select coalesce(array_agg(coalesce(rt.price, 0)::numeric(10, 2) order by d.stay_date), array[]::numeric[])
    into v_prices
    from unnest(v_night_dates) as d(stay_date)
    left join public.rate_templates rt
      on rt.room_id = v_room.id
     and rt.stay_date = d.stay_date;
  end if;

  select round(coalesce(sum(coalesce(price, 0)), 0)::numeric, 2)
  into v_total_price
  from unnest(v_prices) as p(price);

  v_before := jsonb_build_object(
    'guest_name', v_reservation.guest_name,
    'source', v_reservation.source,
    'checkin_date', v_reservation.checkin_date,
    'checkout_date', v_reservation.checkout_date,
    'total_price', v_reservation.total_price
  );

  v_cancelled_at := timezone('utc', now());
  update public.reservation_nights
  set cancelled_at = v_cancelled_at
  where reservation_id = p_reservation_id
    and cancelled_at is null;
  get diagnostics v_replaced_nights = row_count;

  v_normalized_phone := nullif(btrim(coalesce(p_phone, '')), '');
  v_normalized_checkin_time := nullif(btrim(coalesce(p_checkin_time, '')), '');
  v_normalized_note := nullif(btrim(coalesce(p_note, '')), '');

  update public.reservations
  set
    guest_name = btrim(p_guest_name),
    phone = v_normalized_phone,
    source = p_source,
    checkin_date = p_checkin_date,
    checkout_date = p_checkout_date,
    checkin_time = v_normalized_checkin_time,
    note = v_normalized_note,
    total_price = v_total_price,
    updated_by = coalesce(p_actor_user_id, updated_by)
  where id = p_reservation_id;

  insert into public.reservation_nights (
    reservation_id,
    room_id,
    stay_date,
    nightly_price,
    is_ota
  )
  select
    p_reservation_id,
    v_room.id,
    d.stay_date,
    round(coalesce(pr.price, 0)::numeric, 2),
    p_source = 'ota'
  from unnest(v_night_dates) with ordinality as d(stay_date, idx)
  join unnest(v_prices) with ordinality as pr(price, idx)
    on pr.idx = d.idx;

  insert into public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_json,
    after_json
  )
  values (
    p_actor_user_id,
    'booking_updated',
    'reservation',
    p_reservation_id::text,
    v_before,
    jsonb_build_object(
      'room_number', v_room.room_number,
      'source', p_source,
      'checkin_date', p_checkin_date,
      'checkout_date', p_checkout_date,
      'total_price', v_total_price,
      'replaced_nights', v_replaced_nights
    )
  );

  return jsonb_build_object(
    'id', p_reservation_id,
    'booking_code', v_reservation.booking_code,
    'guest_name', btrim(p_guest_name),
    'room_number', v_room.room_number,
    'source', p_source,
    'checkin_date', p_checkin_date,
    'checkout_date', p_checkout_date,
    'total_nights', v_nights_count,
    'nightly_prices', to_jsonb(v_prices),
    'total_price', v_total_price
  );
end;
$$;

create or replace function public.booking_cancel_reservation(
  p_reservation_id uuid,
  p_cancel_reason text default null,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_reservation public.reservations%rowtype;
  v_cancelled_at timestamptz;
  v_cancelled_nights int;
  v_note text;
  v_reason text;
begin
  select *
  into v_reservation
  from public.reservations
  where id = p_reservation_id
  for update;

  if not found then
    raise exception 'Reservation not found';
  end if;

  if v_reservation.status <> 'active' then
    raise exception 'Reservation is not active';
  end if;

  v_cancelled_at := timezone('utc', now());
  v_reason := nullif(btrim(coalesce(p_cancel_reason, '')), '');
  v_note := nullif(btrim(coalesce(v_reservation.note, '')), '');

  if v_reason is not null then
    v_note := concat_ws(E'\n', v_note, 'Cancelled: ' || v_reason);
  end if;

  update public.reservations
  set
    status = 'cancelled',
    note = v_note,
    updated_by = coalesce(p_actor_user_id, updated_by)
  where id = p_reservation_id;

  update public.reservation_nights
  set cancelled_at = v_cancelled_at
  where reservation_id = p_reservation_id
    and cancelled_at is null;
  get diagnostics v_cancelled_nights = row_count;

  insert into public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    before_json,
    after_json
  )
  values (
    p_actor_user_id,
    'booking_cancelled',
    'reservation',
    p_reservation_id::text,
    jsonb_build_object(
      'status', 'active'
    ),
    jsonb_build_object(
      'status', 'cancelled',
      'cancelled_nights', v_cancelled_nights
    )
  );

  return jsonb_build_object(
    'id', p_reservation_id,
    'booking_code', v_reservation.booking_code,
    'status', 'cancelled',
    'cancelled_nights', v_cancelled_nights
  );
end;
$$;

grant execute on function public.generate_booking_code() to authenticated, service_role;
grant execute on function public.booking_create_reservation(text, text, date, date, public.booking_source, text, text, text, numeric[], uuid) to authenticated, service_role;
grant execute on function public.booking_update_reservation(uuid, text, text, date, date, public.booking_source, text, text, text, numeric[], uuid) to authenticated, service_role;
grant execute on function public.booking_cancel_reservation(uuid, text, uuid) to authenticated, service_role;

commit;
