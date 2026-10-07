-- =============================================================
-- Phase 11A: Accounting Backbone — RPC Patch
-- Patches transfer_create_booking to:
--   1. Insert into transfer_transactions instead of folio_payments
--   2. Auto-create commission_ledger entry (1:1 with transfer)
-- Depends on: 20260305_phase11a_accounting_backbone.sql (new tables)
-- =============================================================

-- ★ Replace the folio_payments insert section in transfer_create_booking
-- Original: lines 546-566 inserted into folio_payments
-- New: insert into transfer_transactions + commission_ledger

CREATE OR REPLACE FUNCTION public.transfer_create_booking(
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
  v_reservation_checkout_date date;
  v_guest_name text;
  v_guest_phone text;
  v_guest_profile_id uuid;
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
  v_margin numeric(10,2);
  v_alert_created boolean := false;
  v_trace_created boolean := false;
  v_transfer_tx_posted boolean := false;
  v_commission_created boolean := false;
begin
  -- ── Validation (unchanged from Phase 11) ──
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

  -- ── Lookup reservation + guest_profile_id (★ NEW: also fetch guest_profile_id) ──
  select
    r.status::text,
    r.checkout_date,
    r.guest_name,
    coalesce(nullif(trim(r.phone), ''), nullif(trim(gp.phone), '')),
    r.guest_profile_id
  into
    v_reservation_status,
    v_reservation_checkout_date,
    v_guest_name,
    v_guest_phone,
    v_guest_profile_id
  from public.reservations r
  left join public.guest_profiles gp on gp.id = r.guest_profile_id
  where r.id = p_reservation_id;

  if not found then
    raise exception 'Reservation not found';
  end if;
  if v_reservation_status <> 'active'
     and not (
       v_reservation_status = 'checked_out'
       and v_reservation_checkout_date = (now() at time zone 'Asia/Bangkok')::date
     ) then
    raise exception 'Reservation must be active or checked out today to create transfer';
  end if;

  -- ── Payment method validation ──
  v_payment_method := nullif(trim(coalesce(p_payment_method, '')), '');
  if v_payment_method is not null and v_payment_method not in ('cash', 'transfer', 'credit_card', 'other') then
    raise exception 'payment_method must be cash|transfer|credit_card|other';
  end if;

  -- ── Price rounding ──
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

  v_margin := round(coalesce(v_selling_price, 0) - coalesce(v_cost_price, 0), 2);

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

  -- ── Lookup driver/vehicle/boat (unchanged) ──
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

  -- ── Insert transfer (unchanged) ──
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

  -- ── Voucher (unchanged) ──
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

  -- ── Alert (unchanged) ──
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

  -- ── Trace (unchanged) ──
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

  -- ══════════════════════════════════════════════════════
  -- ★ PHASE 11A CHANGE: Insert transfer_transactions instead of folio_payments
  -- ══════════════════════════════════════════════════════
  if v_payment_status = 'paid_to_hotel' and v_selling_price is not null and v_selling_price > 0 then
    insert into public.transfer_transactions (
      transfer_id,
      reservation_id,
      guest_profile_id,
      tx_type,
      amount,
      selling_price,
      cost_price,
      margin,
      payment_method,
      cashier_name,
      note
    )
    values (
      v_transfer_id,
      p_reservation_id,
      v_guest_profile_id,
      'charge',
      v_selling_price,
      v_selling_price,
      v_cost_price,
      v_margin,
      v_payment_method::public.payment_method_type,
      nullif(trim(coalesce(p_created_by, '')), ''),
      'Transfer: ' || p_transfer_type || ' - ' || v_voucher_number
    );
    v_transfer_tx_posted := true;
  end if;

  -- ══════════════════════════════════════════════════════
  -- ★ PHASE 11A: Auto-create commission_ledger (1:1 with transfer)
  -- Only when selling_price > 0 (has financial data)
  -- ══════════════════════════════════════════════════════
  if v_selling_price is not null and v_selling_price > 0 then
    insert into public.commission_ledger (
      transfer_id,
      reservation_id,
      guest_profile_id,
      staff_name,
      rule_type,
      rule_value,
      base_amount,
      commission_amount,
      status,
      payout_cycle
    )
    values (
      v_transfer_id,
      p_reservation_id,
      v_guest_profile_id,
      coalesce(v_driver_name, nullif(trim(coalesce(p_created_by, '')), ''), 'N/A'),
      'pct_sell',
      case when v_selling_price > 0 then round((v_driver_commission / v_selling_price) * 100, 2) else 0 end,
      v_selling_price,
      v_driver_commission,
      'pending',
      'monthly'
    );
    v_commission_created := true;
  end if;

  return jsonb_build_object(
    'success', true,
    'transfer_id', v_transfer_id,
    'voucher_number', v_voucher_number,
    'alert_created', v_alert_created,
    'trace_created', v_trace_created,
    'transfer_tx_posted', v_transfer_tx_posted,
    'commission_created', v_commission_created
  );
end;
$$;
