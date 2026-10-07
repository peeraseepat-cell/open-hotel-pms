BEGIN;

-- Transfer pools may be negative when recorded costs exceed the selling price.
ALTER TABLE public.commission_ledger DROP CONSTRAINT IF EXISTS commission_ledger_commission_amount_check;

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
    - coalesce(v_driver_fee, 0),
    2
  );

  v_margin := case
    when v_cost_price is null then 0
    else round(coalesce(v_selling_price, 0) - coalesce(v_cost_price, 0), 2)
  end;

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
      case when v_selling_price > 0 then round((v_net_commission / v_selling_price) * 100, 2) else 0 end,
      v_selling_price,
      v_net_commission,
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

create or replace function public.transfer_write_atomic(
  p_transfer_id           uuid,
  p_patch                 jsonb,
  p_cancel_reason         text default null,
  p_cancel_voucher_number text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_locked            public.transfers%rowtype;
  v_updated           public.transfers%rowtype;
  v_ledger            public.commission_ledger%rowtype;
  v_reservation_id    uuid;
  v_guest_profile_id  uuid;
  v_selling           numeric;
  v_cost              numeric;
  v_fee               numeric;
  v_pay_status        text;
  v_pay_method        text;
  v_pool              numeric(12,2);
  v_rule_value        numeric(12,2);
  v_desired           numeric(12,2);
  v_cost_ratio        numeric;
  v_is_cancel         boolean;
  v_pricing_diff      boolean;
  v_payment_diff      boolean;
  v_net_selling       numeric(12,2);
  v_net_cost          numeric(12,2);
  v_net_margin        numeric(12,2);
  v_desired_margin    numeric(12,2);
  v_margin_delta      numeric(12,2);
  v_delta             numeric(12,2);
  v_desired_cost      numeric(12,2);
  v_cost_delta        numeric(12,2);
  v_tx_sell           numeric(12,2);
  v_tx_cost           numeric(12,2);
  v_tx_margin         numeric(12,2);
  v_tx_type           text;
  v_outstanding       numeric(12,2);
  v_refund_cost       numeric(12,2);
  v_refund_margin     numeric(12,2);
  v_sync_pm           public.payment_method_type;
begin
  select * into v_locked from public.transfers where id = p_transfer_id for update;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  select * into v_ledger from public.commission_ledger where transfer_id = p_transfer_id for update;

  v_selling    := case when p_patch ? 'selling_price'  then (p_patch->>'selling_price')::numeric  else v_locked.selling_price end;
  v_cost       := case when p_patch ? 'cost_price'     then (p_patch->>'cost_price')::numeric     else v_locked.cost_price end;
  v_fee        := case when p_patch ? 'driver_fee'     then (p_patch->>'driver_fee')::numeric     else v_locked.driver_fee end;
  v_pay_status := case when p_patch ? 'payment_status' then (p_patch->>'payment_status')          else v_locked.payment_status end;
  v_pay_method := case when p_patch ? 'payment_method' then (p_patch->>'payment_method')          else v_locked.payment_method end;

  v_pricing_diff :=
       (p_patch ? 'selling_price' and round((p_patch->>'selling_price')::numeric, 2) is distinct from round(v_locked.selling_price, 2))
    or (p_patch ? 'cost_price'    and round((p_patch->>'cost_price')::numeric, 2)    is distinct from round(v_locked.cost_price, 2))
    or (p_patch ? 'driver_fee'    and round((p_patch->>'driver_fee')::numeric, 2)    is distinct from round(v_locked.driver_fee, 2));
  v_payment_diff :=
       (p_patch ? 'payment_status' and (p_patch->>'payment_status') is distinct from v_locked.payment_status)
    or (p_patch ? 'payment_method' and (p_patch->>'payment_method') is distinct from v_locked.payment_method);
  v_is_cancel  := (p_patch ? 'status' and (p_patch->>'status') = 'cancelled' and v_locked.status <> 'cancelled');

  if v_pay_status = 'paid_to_hotel' and coalesce(v_pay_method, '') = '' then
    return jsonb_build_object('found', true, 'invalid', 'payment_method_required');
  end if;

  v_pool := (round(coalesce(v_selling,0) * 100) - round(coalesce(v_cost,0) * 100) - round(coalesce(v_fee,0) * 100)) / 100.0;

  update public.transfers set
    selling_price     = v_selling,
    cost_price        = v_cost,
    driver_fee        = v_fee,
    driver_commission = case when p_patch ? 'driver_commission' then (p_patch->>'driver_commission')::numeric else driver_commission end,
    net_commission    = v_pool,
    actual_price      = case when p_patch ? 'actual_price'  then (p_patch->>'actual_price')::numeric  else actual_price end,
    payment_status    = v_pay_status,
    payment_method    = v_pay_method,
    status            = case when p_patch ? 'status'          then (p_patch->>'status')                    else status end,
    pickup_datetime   = case when p_patch ? 'pickup_datetime' then (p_patch->>'pickup_datetime')::timestamptz else pickup_datetime end,
    driver_id         = case when p_patch ? 'driver_id'       then (p_patch->>'driver_id')::uuid           else driver_id end,
    vehicle_id        = case when p_patch ? 'vehicle_id'      then (p_patch->>'vehicle_id')::uuid          else vehicle_id end,
    staff_note        = case when p_patch ? 'staff_note'      then (p_patch->>'staff_note')                else staff_note end,
    guest_note        = case when p_patch ? 'guest_note'      then (p_patch->>'guest_note')                else guest_note end,
    alert_enabled     = case when p_patch ? 'alert_enabled'   then (p_patch->>'alert_enabled')::boolean    else alert_enabled end
  where id = p_transfer_id
  returning * into v_updated;

  v_reservation_id := v_updated.reservation_id;
  select guest_profile_id into v_guest_profile_id from public.reservations where id = v_reservation_id;

  if v_is_cancel then
    select
      coalesce(sum((case when tx_type = 'refund' then -1 else 1 end) * coalesce(selling_price, amount, 0)), 0),
      coalesce(sum((case when tx_type = 'refund' then -1 else 1 end) * coalesce(cost_price, 0)), 0),
      coalesce(sum((case when tx_type = 'refund' then -1 else 1 end) * coalesce(margin, 0)), 0)
    into v_net_selling, v_net_cost, v_net_margin
    from public.transfer_transactions where transfer_id = p_transfer_id;

    v_outstanding := round(greatest(0, v_net_selling), 2);
    if v_outstanding > 0 then
      v_refund_cost := round(v_net_cost, 2);
      v_refund_margin := round(v_net_margin, 2);
      v_sync_pm := case when v_locked.payment_method in ('cash','transfer','credit_card')
                        then v_locked.payment_method::public.payment_method_type else null end;
      insert into public.transfer_transactions
        (transfer_id, reservation_id, guest_profile_id, tx_type, amount, selling_price, cost_price, margin, payment_method, cashier_name, note)
      values
        (p_transfer_id, v_reservation_id, v_guest_profile_id, 'refund', v_outstanding, v_outstanding, v_refund_cost, v_refund_margin,
         v_sync_pm, null,
         'Cancel refund: ' || coalesce(p_cancel_reason, 'Transfer cancelled') || ' - ' ||
         coalesce(nullif(p_cancel_voucher_number, ''), p_transfer_id::text));
    end if;

    if v_ledger.transfer_id is not null and v_ledger.status <> 'reversed' then
      update public.commission_ledger
        set status = 'reversed', reversal_reason = coalesce(p_cancel_reason, 'Transfer cancelled'), reversed_at = now()
        where transfer_id = p_transfer_id and status <> 'reversed';
    end if;
  else
    if v_pricing_diff then
      v_rule_value := case when coalesce(v_selling,0) > 0 then round((v_pool / v_selling) * 10000) / 100.0 else 0 end;
      if v_ledger.transfer_id is not null and v_ledger.status <> 'reversed' then
        update public.commission_ledger
          set commission_amount = v_pool, rule_value = v_rule_value
          where transfer_id = p_transfer_id;
      elsif v_ledger.transfer_id is null and coalesce(v_selling,0) > 0 then
        insert into public.commission_ledger
          (transfer_id, reservation_id, staff_name, rule_type, rule_value, base_amount, commission_amount, status, payout_cycle)
        values
          (p_transfer_id, v_reservation_id, 'N/A', 'pct_sell', v_rule_value, v_selling, v_pool, 'pending', 'monthly');
      end if;
    end if;

    if v_pricing_diff or v_payment_diff then
      v_desired := case when v_pay_status = 'paid_to_hotel' then round(coalesce(v_selling,0), 2) else 0 end;
      v_cost_ratio := case when coalesce(v_selling,0) > 0 then least(1, greatest(0, coalesce(v_cost,0) / v_selling)) else 0 end;
      select coalesce(sum((case when tx_type = 'refund' then -1 else 1 end) * coalesce(selling_price, amount, 0)), 0)
      into v_net_selling from public.transfer_transactions where transfer_id = p_transfer_id;

      v_delta := round(v_desired - v_net_selling, 2);
      if abs(v_delta) >= 0.01 then
        v_tx_sell := abs(v_delta);
        v_tx_cost := round(v_tx_sell * v_cost_ratio, 2);
        v_tx_margin := round(v_tx_sell - v_tx_cost, 2);
        v_tx_type := case when v_delta > 0 then 'charge' else 'refund' end;
        v_sync_pm := case when v_pay_method in ('cash','transfer','credit_card')
                          then v_pay_method::public.payment_method_type else null end;
        insert into public.transfer_transactions
          (transfer_id, reservation_id, guest_profile_id, tx_type, amount, selling_price, cost_price, margin, payment_method, cashier_name, note)
        values
          (p_transfer_id, v_reservation_id, v_guest_profile_id, v_tx_type, v_tx_sell, v_tx_sell, v_tx_cost, v_tx_margin,
           v_sync_pm, null, 'Auto-sync ' || v_tx_type || ' (transfer patch update)');
      end if;

      v_desired_cost := case
        when v_desired = 0 then 0
        when v_desired = round(coalesce(v_selling,0), 2) then round(coalesce(v_cost,0), 2)
        else round(v_desired * v_cost_ratio, 2)
      end;
      select
        coalesce(sum((case when tx_type = 'refund' then -1 else 1 end) * coalesce(cost_price, 0)), 0),
        coalesce(sum((case when tx_type = 'refund' then -1 else 1 end) * coalesce(margin, 0)), 0)
      into v_net_cost, v_net_margin from public.transfer_transactions where transfer_id = p_transfer_id;

      v_desired_margin := case when v_desired = 0 or v_cost is null then 0
        else round(v_desired - v_desired_cost, 2) end;
      v_margin_delta := round(v_desired_margin - v_net_margin, 2);

      v_cost_delta := round(v_desired_cost - v_net_cost, 2);
      if abs(v_cost_delta) >= 0.01 or abs(v_margin_delta) >= 0.01 then
        insert into public.transfer_transactions
          (transfer_id, reservation_id, guest_profile_id, tx_type, amount, selling_price, cost_price, margin, payment_method, cashier_name, note)
        values
          (p_transfer_id, v_reservation_id, v_guest_profile_id, 'adjustment', 0, 0, v_cost_delta, v_margin_delta,
           null, null, 'Auto-sync cost adjustment (transfer patch update)');
      end if;
    end if;
  end if;

  return jsonb_build_object('found', true, 'transfer', to_jsonb(v_updated));
end;
$$;

revoke all on function public.transfer_write_atomic(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.transfer_write_atomic(uuid, jsonb, text, text) to service_role;

-- Repair open financial records without rewriting paid or reversed history.
UPDATE public.transfers
SET net_commission = round(coalesce(selling_price, 0) - coalesce(cost_price, 0) - coalesce(driver_fee, 0), 2)
WHERE net_commission IS DISTINCT FROM round(coalesce(selling_price, 0) - coalesce(cost_price, 0) - coalesce(driver_fee, 0), 2);

UPDATE public.commission_ledger ledger
SET commission_amount = transfer.net_commission,
    rule_value = CASE WHEN coalesce(transfer.selling_price, 0) > 0
      THEN round(transfer.net_commission / transfer.selling_price * 100, 2) ELSE 0 END
FROM public.transfers transfer
WHERE ledger.transfer_id = transfer.id AND ledger.status IN ('pending', 'approved');

COMMIT;
