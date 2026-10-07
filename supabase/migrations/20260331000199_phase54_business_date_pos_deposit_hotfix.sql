begin;

-- Align POS + mobile deposit flows with hotel_settings.business_date
-- so transactions stay on the open business day until Night Audit closes it.

create or replace function public.apply_deposit_snapshot_lines(
  p_reservation_id uuid,
  p_lines jsonb default '[]'::jsonb,
  p_general_note text default null,
  p_cashier_name text default 'FO',
  p_paid_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations%rowtype;
  v_lines jsonb := coalesce(p_lines, '[]'::jsonb);
  v_general_note text := nullif(trim(coalesce(p_general_note, '')), '');
  v_cashier_name text := nullif(trim(coalesce(p_cashier_name, '')), '');
  v_now timestamptz := timezone('utc', now());
  v_paid_date date := coalesce(p_paid_date, (v_now at time zone 'Asia/Bangkok')::date);
  v_method public.payment_method_type;
  v_current_amount numeric(10,2);
  v_target_amount numeric(10,2);
  v_diff numeric(10,2);
  v_note text;
  v_total numeric(10,2);
  v_snapshot_note text;
  v_last_paid_at timestamptz;
begin
  if p_reservation_id is null then
    raise exception 'reservation_id is required';
  end if;

  if jsonb_typeof(v_lines) is distinct from 'array' then
    raise exception 'deposit lines must be a JSON array';
  end if;

  select *
  into v_reservation
  from public.reservations
  where id = p_reservation_id
  for update;

  if v_reservation.id is null then
    raise exception 'Reservation not found';
  end if;

  for v_method, v_target_amount, v_note in
    select
      public.normalize_deposit_method_text(item ->> 'method') as method,
      round(coalesce((item ->> 'amount')::numeric, 0), 2) as amount,
      nullif(trim(coalesce(item ->> 'note', '')), '') as note
    from jsonb_array_elements(v_lines) as item
  loop
    if v_target_amount <= 0 then
      raise exception 'deposit line amount must be greater than 0';
    end if;
  end loop;

  for v_method in
    select unnest(enum_range(null::public.payment_method_type))
  loop
    select round(
      coalesce(
        sum(
          case
            when fp.tx_type = 'deposit' then fp.amount
            when fp.tx_type = 'refund' then -fp.amount
            else 0
          end
        ),
        0
      ),
      2
    )
    into v_current_amount
    from public.folio_payments fp
    where fp.reservation_id = p_reservation_id
      and fp.revenue_category = 'deposit'
      and coalesce(fp.is_record_only, false) = false
      and fp.method = v_method;

    select round(
      coalesce(sum((item ->> 'amount')::numeric), 0),
      2
    )
    into v_target_amount
    from jsonb_array_elements(v_lines) item
    where public.normalize_deposit_method_text(item ->> 'method') = v_method;

    select nullif(trim(coalesce(item ->> 'note', '')), '')
    into v_note
    from jsonb_array_elements(v_lines) item
    where public.normalize_deposit_method_text(item ->> 'method') = v_method
    order by (item ->> 'amount')::numeric desc
    limit 1;

    v_current_amount := coalesce(v_current_amount, 0);
    v_target_amount := coalesce(v_target_amount, 0);
    v_diff := round(v_target_amount - v_current_amount, 2);

    if v_diff > 0 then
      insert into public.folio_payments (
        reservation_id,
        tx_type,
        method,
        amount,
        note,
        paid_at,
        paid_date,
        revenue_category,
        cashier_name,
        is_record_only
      )
      values (
        p_reservation_id,
        'deposit',
        v_method,
        v_diff,
        coalesce(v_note, 'Deposit collected'),
        v_now,
        v_paid_date,
        'deposit',
        coalesce(v_cashier_name, 'FO'),
        false
      );
    elsif v_diff < 0 then
      insert into public.folio_payments (
        reservation_id,
        tx_type,
        method,
        amount,
        note,
        paid_at,
        paid_date,
        revenue_category,
        cashier_name,
        is_record_only
      )
      values (
        p_reservation_id,
        'refund',
        v_method,
        abs(v_diff),
        coalesce(v_note, 'Deposit refund'),
        v_now,
        v_paid_date,
        'deposit',
        coalesce(v_cashier_name, 'FO'),
        false
      );
    end if;
  end loop;

  select round(
    coalesce(
      sum(
        case
          when fp.tx_type = 'deposit' then fp.amount
          when fp.tx_type = 'refund' then -fp.amount
          else 0
        end
      ),
      0
    ),
    2
  )
  into v_total
  from public.folio_payments fp
  where fp.reservation_id = p_reservation_id
    and fp.revenue_category = 'deposit'
    and coalesce(fp.is_record_only, false) = false;

  select max(fp.paid_at)
  into v_last_paid_at
  from public.folio_payments fp
  where fp.reservation_id = p_reservation_id
    and fp.revenue_category = 'deposit'
    and fp.tx_type = 'deposit'
    and coalesce(fp.is_record_only, false) = false;

  select case
      when jsonb_array_length(v_lines) = 0 and v_general_note is null then null
      else jsonb_strip_nulls(
        jsonb_build_object(
          'lines',
          coalesce(
            (
              select jsonb_agg(
                jsonb_strip_nulls(
                  jsonb_build_object(
                    'method', public.normalize_deposit_method_text(item ->> 'method'),
                    'amount', round((item ->> 'amount')::numeric, 2),
                    'note', nullif(trim(coalesce(item ->> 'note', '')), '')
                  )
                )
              )
              from jsonb_array_elements(v_lines) item
            ),
            '[]'::jsonb
          ),
          'note',
          v_general_note
        )
      )::text
    end
  into v_snapshot_note;

  update public.reservations
  set deposit_amount = coalesce(v_total, 0),
      deposit_paid_at = case when coalesce(v_total, 0) > 0 then coalesce(v_last_paid_at, v_now) else null end,
      deposit_note = v_snapshot_note,
      updated_at = v_now
  where id = p_reservation_id;

  return jsonb_build_object(
    'success', true,
    'reservation_id', p_reservation_id,
    'deposit_amount', coalesce(v_total, 0),
    'deposit_paid_at', case when coalesce(v_total, 0) > 0 then coalesce(v_last_paid_at, v_now) else null end,
    'deposit_note', v_snapshot_note
  );
end;
$$;

create or replace function public.pos_create_order_v2(
  p_order_type text,
  p_items jsonb,
  p_payment_method text default null,
  p_reservation_id uuid default null,
  p_created_by text default null,
  p_note text default null,
  p_deposit_amount numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_type text := coalesce(trim(p_order_type), '');
  v_payment_method text := nullif(trim(coalesce(p_payment_method, '')), '');
  v_created_by text := nullif(trim(coalesce(p_created_by, '')), '');
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_now timestamptz := timezone('utc', now());
  v_calendar_date date := (v_now at time zone 'Asia/Bangkok')::date;
  v_order_id uuid;
  v_order_number text;
  v_guest_name text;
  v_room_number text;
  v_subtotal numeric(10,2) := 0;
  v_total numeric(10,2) := 0;
  v_item jsonb;
  v_product record;
  v_product_id uuid;
  v_qty int;
  v_line_total numeric(10,2);
  v_main_current int;
  v_deduct int;
  v_oversell int;
  v_order_date date := v_calendar_date;
  v_held numeric(10,2) := 0;
  v_deposit_amount numeric(10,2) := greatest(coalesce(p_deposit_amount, 0), 0);
  v_deposit_apply numeric(10,2) := 0;
  v_remaining numeric(10,2) := 0;
begin
  select coalesce(business_date, v_calendar_date)
  into v_order_date
  from public.hotel_settings
  where id = 1;

  v_order_date := coalesce(v_order_date, v_calendar_date);

  if v_order_type not in ('walkin', 'guest_charge') then
    raise exception 'invalid p_order_type: %', p_order_type;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'p_items must be non-empty array';
  end if;

  if v_order_type = 'walkin' then
    if v_payment_method not in ('cash', 'transfer', 'credit_card') then
      raise exception 'walkin payment method must be cash|transfer|credit_card';
    end if;
    v_deposit_amount := 0;
  else
    if p_reservation_id is null then
      raise exception 'p_reservation_id is required for guest_charge';
    end if;

    select
      r.guest_name,
      rm.room_number
    into
      v_guest_name,
      v_room_number
    from public.reservations r
    left join lateral (
      select rooms.room_number
      from public.reservation_nights rn
      join public.rooms on rooms.id = rn.room_id
      where rn.reservation_id = r.id
        and rn.stay_date = v_order_date
        and rn.cancelled_at is null
      order by rooms.room_number
      limit 1
    ) rm on true
    where r.id = p_reservation_id
      and r.status = 'active'
    for update of r;

    if v_guest_name is null then
      raise exception 'reservation is not eligible for room deposit settlement';
    end if;

    if v_room_number is null then
      raise exception 'reservation has no active room night today';
    end if;

    select coalesce(
      sum(
        case
          when fp.tx_type = 'deposit' then fp.amount
          when fp.tx_type = 'refund'
            and (
              coalesce(fp.revenue_category, '') = 'deposit'
              or lower(coalesce(fp.note, '')) like '%deposit refund%'
              or lower(coalesce(fp.note, '')) like '%paid by deposit%'
            )
          then -fp.amount
          else 0
        end
      ),
      0
    )
    into v_held
    from public.folio_payments fp
    where fp.reservation_id = p_reservation_id;

    v_held := round(v_held::numeric, 2);
    v_deposit_apply := round(least(v_deposit_amount, v_held)::numeric, 2);
    v_remaining := round(greatest(v_total - v_deposit_apply, 0)::numeric, 2);
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    begin
      v_product_id := (v_item ->> 'product_id')::uuid;
    exception when others then
      v_product_id := null;
    end;

    v_qty := greatest(coalesce((v_item ->> 'quantity')::int, 0), 0);
    if v_product_id is null or v_qty <= 0 then
      raise exception 'invalid item payload, each row must include product_id + quantity > 0';
    end if;

    select p.id, p.name, p.category, p.sale_price, p.is_active
    into v_product
    from public.products p
    where p.id = v_product_id
    limit 1;

    if not found then
      raise exception 'product not found: %', v_product_id;
    end if;

    if not coalesce(v_product.is_active, false) then
      raise exception 'product inactive: %', v_product.name;
    end if;

    if v_product.category not in ('pos', 'both') then
      raise exception 'product is not POS sale item: %', v_product.name;
    end if;

    if v_product.sale_price is null then
      raise exception 'product sale_price is required for POS item: %', v_product.name;
    end if;

    v_line_total := round((v_product.sale_price * v_qty)::numeric, 2);
    v_subtotal := round((v_subtotal + v_line_total)::numeric, 2);
  end loop;

  v_total := v_subtotal;

  if v_order_type = 'guest_charge' then
    v_deposit_apply := round(least(v_deposit_amount, v_held, v_total)::numeric, 2);
    v_remaining := round(greatest(v_total - v_deposit_apply, 0)::numeric, 2);

    if v_deposit_apply <= 0 then
      raise exception 'deposit held is required for room settlement';
    end if;

    if v_remaining > 0 and v_payment_method not in ('cash', 'transfer', 'credit_card') then
      raise exception 'remaining payment method must be cash|transfer|credit_card';
    end if;

    if v_remaining = 0 then
      v_payment_method := null;
    end if;
  end if;

  insert into public.pos_orders (
    order_number,
    order_type,
    reservation_id,
    guest_name,
    status,
    subtotal,
    total,
    payment_method,
    note,
    created_by,
    order_date,
    created_at,
    updated_at
  )
  values (
    public.generate_pos_order_number(),
    v_order_type,
    case when v_order_type = 'guest_charge' then p_reservation_id else null end,
    case when v_order_type = 'guest_charge' then v_guest_name else null end,
    'completed',
    v_subtotal,
    v_total,
    case when v_order_type = 'walkin' then v_payment_method else null end,
    v_note,
    v_created_by,
    v_order_date,
    v_now,
    v_now
  )
  returning id, order_number into v_order_id, v_order_number;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_qty := greatest(coalesce((v_item ->> 'quantity')::int, 0), 0);

    select p.id, p.name, p.category, p.sale_price, p.is_active
    into v_product
    from public.products p
    where p.id = v_product_id
    limit 1;

    v_line_total := round((v_product.sale_price * v_qty)::numeric, 2);

    insert into public.pos_order_items (
      order_id,
      product_id,
      product_name,
      quantity,
      unit_price,
      line_total,
      created_at
    )
    values (
      v_order_id,
      v_product_id,
      v_product.name,
      v_qty,
      v_product.sale_price,
      v_line_total,
      v_now
    );

    insert into public.main_stock (product_id, quantity, reorder_level, updated_at)
    values (v_product_id, 0, 10, v_now)
    on conflict (product_id) do nothing;

    select quantity
    into v_main_current
    from public.main_stock
    where product_id = v_product_id
    for update;

    v_deduct := least(v_main_current, v_qty);
    v_oversell := greatest(v_qty - v_main_current, 0);

    update public.main_stock
    set quantity = greatest(v_main_current - v_qty, 0),
        updated_at = v_now
    where product_id = v_product_id;

    insert into public.stock_transactions_v2 (
      transaction_date,
      product_id,
      action,
      quantity_change,
      from_location,
      to_location,
      reference_type,
      reference_id,
      performed_by,
      note,
      created_at
    )
    values (
      v_order_date,
      v_product_id,
      'sale',
      -v_deduct,
      'main',
      null,
      'pos_order',
      v_order_id,
      v_created_by,
      case
        when v_oversell > 0 then format('oversell warning: sold %s, deducted %s, missing %s', v_qty, v_deduct, v_oversell)
        else format('sold %s', v_qty)
      end,
      v_now
    );
  end loop;

  if v_order_type = 'walkin' then
    return jsonb_build_object(
      'order_id', v_order_id,
      'order_number', v_order_number,
      'subtotal', v_subtotal,
      'total', v_total,
      'deposit_used_amount', 0,
      'remaining_paid_amount', v_total,
      'payment_method', v_payment_method
    );
  end if;

  insert into public.folio_payments (
    reservation_id,
    tx_type,
    method,
    amount,
    note,
    paid_at,
    paid_date,
    revenue_category,
    cashier_name,
    pos_order_id
  )
  values (
    p_reservation_id,
    'refund',
    'cash',
    v_deposit_apply,
    format('Paid by Deposit for POS order %s (%s)', v_order_number, coalesce(v_room_number, 'no room')),
    v_now,
    v_order_date,
    'deposit',
    coalesce(v_created_by, 'FO'),
    v_order_id
  );

  insert into public.folio_payments (
    reservation_id,
    tx_type,
    method,
    amount,
    note,
    paid_at,
    paid_date,
    revenue_category,
    cashier_name,
    pos_order_id,
    is_record_only
  )
  values (
    p_reservation_id,
    'payment',
    'cash',
    v_deposit_apply,
    format('Paid by Deposit from room %s for POS order %s', coalesce(v_room_number, 'N/A'), v_order_number),
    v_now,
    v_order_date,
    'pos_revenue',
    coalesce(v_created_by, 'FO'),
    v_order_id,
    true
  );

  if v_remaining > 0 then
    insert into public.folio_payments (
      reservation_id,
      tx_type,
      method,
      amount,
      note,
      paid_at,
      paid_date,
      revenue_category,
      cashier_name,
      pos_order_id,
      is_record_only
    )
    values (
      p_reservation_id,
      'payment',
      v_payment_method::public.payment_method_type,
      v_remaining,
      format('POS remainder for room %s on order %s', coalesce(v_room_number, 'N/A'), v_order_number),
      v_now,
      v_order_date,
      'pos_revenue',
      coalesce(v_created_by, 'FO'),
      v_order_id,
      true
    );
  end if;

  update public.reservations
  set deposit_amount = greatest(
        0,
        coalesce((
          select round(sum(
            case
              when fp.tx_type = 'deposit' then fp.amount
              when fp.tx_type = 'refund'
                and (
                  coalesce(fp.revenue_category, '') = 'deposit'
                  or lower(coalesce(fp.note, '')) like '%deposit refund%'
                  or lower(coalesce(fp.note, '')) like '%paid by deposit%'
                )
              then -fp.amount
              else 0
            end
          )::numeric, 2)
          from public.folio_payments fp
          where fp.reservation_id = p_reservation_id
        ), 0)
      )
  where id = p_reservation_id;

  return jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number,
    'subtotal', v_subtotal,
    'total', v_total,
    'deposit_used_amount', v_deposit_apply,
    'remaining_paid_amount', v_remaining,
    'payment_method', case when v_remaining > 0 then v_payment_method else null end,
    'room_number', v_room_number
  );
end;
$$;

create or replace function public.pos_void_order_v2(
  p_order_id uuid,
  p_note text default null,
  p_voided_by text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.pos_orders%rowtype;
  v_item record;
  v_now timestamptz := timezone('utc', now());
  v_calendar_date date := (v_now at time zone 'Asia/Bangkok')::date;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_voided_by text := nullif(trim(coalesce(p_voided_by, '')), '');
  v_order_date date := v_calendar_date;
  v_room_number text;
  v_record record;
begin
  select coalesce(business_date, v_calendar_date)
  into v_order_date
  from public.hotel_settings
  where id = 1;

  v_order_date := coalesce(v_order_date, v_calendar_date);

  if p_order_id is null then
    raise exception 'p_order_id is required';
  end if;

  select *
  into v_order
  from public.pos_orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'order not found';
  end if;

  if v_order.status = 'voided' then
    raise exception 'order already voided';
  end if;

  if v_order.status <> 'completed' then
    raise exception 'only completed order can be voided';
  end if;

  if v_order.reservation_id is not null then
    perform 1
    from public.reservations
    where id = v_order.reservation_id
      and status = 'active'
    for update;

    if not found then
      raise exception 'Cannot return to deposit: reservation already checked out. Use manual adjustment.';
    end if;

    select rooms.room_number
    into v_room_number
    from public.reservation_nights rn
    join public.rooms on rooms.id = rn.room_id
    where rn.reservation_id = v_order.reservation_id
      and rn.stay_date = v_order_date
      and rn.cancelled_at is null
    order by rooms.room_number
    limit 1;
  end if;

  update public.pos_orders
  set status = 'voided',
      note = coalesce(v_order.note, '') || case when v_note is null then '' else ('\nVOID: ' || v_note) end,
      updated_at = v_now
  where id = p_order_id;

  for v_item in
    select poi.product_id, poi.quantity
    from public.pos_order_items poi
    where poi.order_id = p_order_id
  loop
    insert into public.main_stock (product_id, quantity, reorder_level, updated_at)
    values (v_item.product_id, 0, 10, v_now)
    on conflict (product_id) do nothing;

    update public.main_stock
    set quantity = quantity + v_item.quantity,
        updated_at = v_now
    where product_id = v_item.product_id;

    insert into public.stock_transactions_v2 (
      transaction_date,
      product_id,
      action,
      quantity_change,
      from_location,
      to_location,
      reference_type,
      reference_id,
      performed_by,
      note,
      created_at
    )
    values (
      v_order_date,
      v_item.product_id,
      'return',
      v_item.quantity,
      null,
      'main',
      'pos_order',
      p_order_id,
      v_voided_by,
      coalesce(v_note, 'pos order void return'),
      v_now
    );
  end loop;

  if v_order.order_type = 'guest_charge' and v_order.reservation_id is not null then
    if exists (
      select 1
      from public.reservations r
      where r.id = v_order.reservation_id
        and r.status = 'checked_out'
    ) then
      raise exception 'Cannot return to deposit: reservation already checked out. Use manual adjustment.';
    end if;

    for v_record in
      select
        id,
        tx_type,
        method,
        amount,
        note,
        revenue_category,
        is_record_only
      from public.folio_payments
      where pos_order_id = p_order_id
      order by paid_at asc, created_at asc, id asc
    loop
      if v_record.tx_type = 'refund' and coalesce(v_record.revenue_category, '') = 'deposit' then
        insert into public.folio_payments (
          reservation_id,
          tx_type,
          method,
          amount,
          note,
          paid_at,
          paid_date,
          revenue_category,
          cashier_name,
          pos_order_id
        )
        values (
          v_order.reservation_id,
          'deposit',
          'cash',
          v_record.amount,
          coalesce(v_note, format('Void return to deposit for POS order %s', v_order.order_number)),
          v_now,
          v_order_date,
          'deposit',
          coalesce(v_voided_by, 'FO'),
          p_order_id
        );
      elsif coalesce(v_record.is_record_only, false) then
        insert into public.folio_payments (
          reservation_id,
          tx_type,
          method,
          amount,
          note,
          paid_at,
          paid_date,
          revenue_category,
          cashier_name,
          pos_order_id,
          is_record_only
        )
        values (
          v_order.reservation_id,
          'refund',
          coalesce(v_record.method::text, 'cash')::public.payment_method_type,
          v_record.amount,
          coalesce(v_note, format('Void return to deposit for POS order %s', v_order.order_number)),
          v_now,
          v_order_date,
          coalesce(v_record.revenue_category, 'pos_revenue'),
          coalesce(v_voided_by, 'FO'),
          p_order_id,
          true
        );
      end if;
    end loop;

    update public.reservations
    set deposit_amount = greatest(
          0,
          coalesce((
            select round(sum(
              case
                when fp.tx_type = 'deposit' then fp.amount
                when fp.tx_type = 'refund'
                  and (
                    coalesce(fp.revenue_category, '') = 'deposit'
                    or lower(coalesce(fp.note, '')) like '%deposit refund%'
                    or lower(coalesce(fp.note, '')) like '%paid by deposit%'
                  )
                then -fp.amount
                else 0
              end
            )::numeric, 2)
            from public.folio_payments fp
            where fp.reservation_id = v_order.reservation_id
          ), 0)
        )
    where id = v_order.reservation_id;
  end if;

  return jsonb_build_object(
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'status', 'voided'
  );
end;
$$;

grant execute on function public.apply_deposit_snapshot_lines(uuid, jsonb, text, text, date) to authenticated, service_role;
grant execute on function public.pos_create_order_v2(text, jsonb, text, uuid, text, text, numeric) to anon, authenticated;
grant execute on function public.pos_void_order_v2(uuid, text, text) to anon, authenticated;

commit;
