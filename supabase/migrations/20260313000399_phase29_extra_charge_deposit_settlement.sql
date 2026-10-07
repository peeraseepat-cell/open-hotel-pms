begin;

create or replace function public.post_extra_charge_with_deposit_v1(
  p_reservation_id uuid,
  p_fee_template_code text,
  p_amount numeric,
  p_note text default null,
  p_cashier_name text default 'FO',
  p_paid_at timestamptz default timezone('utc', now())
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations%rowtype;
  v_template public.extra_fee_templates%rowtype;
  v_amount numeric(10,2) := round(coalesce(p_amount, 0)::numeric, 2);
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_cashier text := nullif(trim(coalesce(p_cashier_name, '')), '');
  v_paid_at timestamptz := coalesce(p_paid_at, timezone('utc', now()));
  v_paid_date date := (v_paid_at at time zone 'Asia/Bangkok')::date;
  v_held_before numeric(10,2) := 0;
  v_deposit_applied numeric(10,2) := 0;
  v_remaining_outstanding numeric(10,2) := 0;
  v_held_after numeric(10,2) := 0;
  v_room_number text := null;
  v_charge_row_id uuid;
  v_apply_row_id uuid;
  v_deposit_row_id uuid;
begin
  if p_reservation_id is null then
    raise exception 'reservation_id is required';
  end if;

  if v_amount <= 0 then
    raise exception 'amount must be greater than 0';
  end if;

  select *
  into v_reservation
  from public.reservations r
  where r.id = p_reservation_id
  for update;

  if v_reservation.id is null then
    raise exception 'reservation not found';
  end if;

  if v_reservation.status <> 'active' then
    raise exception 'reservation is not active';
  end if;

  select *
  into v_template
  from public.extra_fee_templates eft
  where upper(trim(coalesce(eft.code, ''))) = upper(trim(coalesce(p_fee_template_code, '')))
  limit 1;

  if v_template.code is null then
    raise exception 'fee template not found';
  end if;

  if coalesce(v_template.is_active, false) = false then
    raise exception 'fee template is inactive';
  end if;

  select rooms.room_number
  into v_room_number
  from public.reservation_nights rn
  join public.rooms on rooms.id = rn.room_id
  where rn.reservation_id = p_reservation_id
    and rn.cancelled_at is null
    and rn.stay_date = v_paid_date
  order by rooms.room_number
  limit 1;

  if v_room_number is null then
    select rooms.room_number
    into v_room_number
    from public.reservation_nights rn
    join public.rooms on rooms.id = rn.room_id
    where rn.reservation_id = p_reservation_id
      and rn.cancelled_at is null
      and rn.room_id is not null
    order by rn.stay_date asc
    limit 1;
  end if;

  select round(
    coalesce(
      sum(
        case
          when fp.tx_type = 'deposit' then fp.amount
          when fp.tx_type = 'refund' and coalesce(fp.revenue_category, '') = 'deposit' then -fp.amount
          else 0
        end
      ),
      0
    )::numeric,
    2
  )
  into v_held_before
  from public.folio_payments fp
  where fp.reservation_id = p_reservation_id
    and coalesce(fp.revenue_category, '') = 'deposit'
    and coalesce(fp.is_record_only, false) = false;

  v_deposit_applied := round(least(v_amount, greatest(v_held_before, 0))::numeric, 2);
  v_remaining_outstanding := round(greatest(v_amount - v_deposit_applied, 0)::numeric, 2);

  if v_deposit_applied <= 0 then
    raise exception 'deposit held is required';
  end if;

  -- Charge row: visible as extra charge, excluded from credit math.
  insert into public.folio_payments (
    reservation_id,
    tx_type,
    method,
    amount,
    note,
    paid_at,
    paid_date,
    revenue_category,
    fee_template_code,
    cashier_name,
    is_record_only
  )
  values (
    p_reservation_id,
    'payment',
    'cash'::public.payment_method_type,
    v_amount,
    coalesce(v_note, v_template.name),
    v_paid_at,
    v_paid_date,
    'extra_charge',
    v_template.code,
    coalesce(v_cashier, 'FO'),
    true
  )
  returning id into v_charge_row_id;

  -- Settlement trace row: counted in cash + credits and shown in folio/payment daily.
  insert into public.folio_payments (
    reservation_id,
    tx_type,
    method,
    amount,
    note,
    paid_at,
    paid_date,
    revenue_category,
    fee_template_code,
    cashier_name,
    is_record_only
  )
  values (
    p_reservation_id,
    'payment',
    'cash'::public.payment_method_type,
    v_deposit_applied,
    format(
      'Paid by Deposit%s for %s',
      case when v_room_number is null then '' else format(' from room %s', v_room_number) end,
      coalesce(v_template.name, v_template.code)
    ),
    v_paid_at,
    v_paid_date,
    'room_revenue',
    v_template.code,
    coalesce(v_cashier, 'FO'),
    false
  )
  returning id into v_apply_row_id;

  -- Consume held deposit.
  insert into public.folio_payments (
    reservation_id,
    tx_type,
    method,
    amount,
    note,
    paid_at,
    paid_date,
    revenue_category,
    fee_template_code,
    cashier_name,
    is_record_only
  )
  values (
    p_reservation_id,
    'refund',
    'cash'::public.payment_method_type,
    v_deposit_applied,
    format('Paid by Deposit for extra charge %s', coalesce(v_template.code, 'EXTRA')),
    v_paid_at,
    v_paid_date,
    'deposit',
    v_template.code,
    coalesce(v_cashier, 'FO'),
    false
  )
  returning id into v_deposit_row_id;

  select round(
    coalesce(
      sum(
        case
          when fp.tx_type = 'deposit' then fp.amount
          when fp.tx_type = 'refund' and coalesce(fp.revenue_category, '') = 'deposit' then -fp.amount
          else 0
        end
      ),
      0
    )::numeric,
    2
  )
  into v_held_after
  from public.folio_payments fp
  where fp.reservation_id = p_reservation_id
    and coalesce(fp.revenue_category, '') = 'deposit'
    and coalesce(fp.is_record_only, false) = false;

  update public.reservations
  set
    deposit_amount = greatest(v_held_after, 0),
    updated_at = timezone('utc', now())
  where id = p_reservation_id;

  return jsonb_build_object(
    'charge_row_id', v_charge_row_id,
    'deposit_apply_row_id', v_apply_row_id,
    'deposit_refund_row_id', v_deposit_row_id,
    'charge_amount', v_amount,
    'deposit_applied', v_deposit_applied,
    'remaining_outstanding', v_remaining_outstanding,
    'held_before', v_held_before,
    'held_after', v_held_after,
    'room_number', v_room_number
  );
end;
$$;

grant execute on function public.post_extra_charge_with_deposit_v1(
  uuid,
  text,
  numeric,
  text,
  text,
  timestamptz
) to authenticated, service_role;

commit;
