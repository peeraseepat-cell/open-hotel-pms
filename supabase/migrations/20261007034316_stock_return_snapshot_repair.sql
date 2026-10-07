BEGIN;

create or replace function public.compute_stock_snapshot(p_business_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_product record;
  v_tx record;
  v_prev_main int;
  v_prev_floor int;
  v_actual_main int;
  v_actual_floor int;
  v_opening_main int;
  v_opening_floor int;
  v_expected_main int;
  v_expected_floor int;
  v_floor_breakdown jsonb;
  v_products_computed int := 0;
  v_variance_count int := 0;
begin
  if p_business_date is null then
    raise exception 'business_date is required';
  end if;

  insert into public.daily_snapshots (business_date)
  values (p_business_date)
  on conflict (business_date) do nothing;

  for v_product in
    select
      p.id,
      p.name,
      p.category,
      p.stock_tracking_mode
    from public.products p
    where p.is_active = true
    order by p.name
  loop
    select
      coalesce(sum(st.quantity_change) filter (where st.action = 'sale'), 0) as sale_delta,
      coalesce(sum(st.quantity_change) filter (where st.action = 'return' and st.reference_type = 'pos_order'), 0) as pos_return_delta,
      coalesce(sum(st.quantity_change) filter (where st.action = 'use'), 0) as use_delta,
      coalesce(sum(st.quantity_change) filter (where st.action = 'return' and st.reference_type = 'housekeeping_return'), 0) as hk_return_delta,
      coalesce(sum(st.quantity_change) filter (where st.action = 'return' and st.reference_type in ('fo_return', 'fo_prepare_return')), 0) as fo_return_delta,
      coalesce(sum(st.quantity_change) filter (where st.action = 'receive'), 0) as receive_delta,
      coalesce(sum(st.quantity_change) filter (where st.action = 'adjust' and coalesce(st.reference_type, '') <> 'fo_amenity_audit_correction'), 0) as adjust_delta,
      coalesce(sum(st.quantity_change) filter (where st.action = 'adjust' and st.reference_type = 'fo_amenity_audit_correction'), 0) as audit_correction_delta,
      coalesce(sum(st.quantity_change) filter (where st.action = 'transfer_out' and st.from_location = 'main'), 0) as transfer_main_out_delta,
      coalesce(sum(st.quantity_change) filter (where st.action = 'transfer_in' and st.to_location = 'main'), 0) as transfer_main_in_delta,
      coalesce(sum(st.quantity_change) filter (where st.action = 'transfer_in' and st.to_location like 'floor_%'), 0) as transfer_floor_in_delta,
      coalesce(sum(st.quantity_change) filter (where st.action = 'transfer_out' and st.from_location like 'floor_%'), 0) as transfer_floor_out_delta,
      coalesce(sum(st.quantity_change) filter (where st.action = 'transfer_in' and st.reference_type = 'fo_amenity_audit_refill'), 0) as audit_refill_delta,
      coalesce(sum(
        case
          when st.action = 'sale' then st.quantity_change
          when st.action = 'return' and st.reference_type = 'pos_order' then st.quantity_change
          when st.action = 'return' and st.reference_type in ('fo_return', 'fo_prepare_return') then st.quantity_change
          when st.action = 'receive' then st.quantity_change
          when st.action = 'adjust' and (st.floor_number is null or st.from_location = 'main' or st.to_location = 'main') then st.quantity_change
          when st.action = 'transfer_out' and st.from_location = 'main' then st.quantity_change
          when st.action = 'transfer_in' and st.to_location = 'main' then st.quantity_change
          else 0
        end
      ), 0) as net_main_delta,
      coalesce(sum(
        case
          when st.action = 'use' then st.quantity_change
          when st.action = 'return' and st.reference_type = 'housekeeping_return' then st.quantity_change
          when st.action = 'return' and st.reference_type in ('fo_return', 'fo_prepare_return') then -st.quantity_change
          when st.action = 'adjust' and st.floor_number is not null then st.quantity_change
          when st.action = 'transfer_in' and st.to_location like 'floor_%' then st.quantity_change
          when st.action = 'transfer_out' and st.from_location like 'floor_%' then st.quantity_change
          else 0
        end
      ), 0) as net_floor_delta
    into v_tx
    from public.stock_transactions_v2 st
    where st.transaction_date = p_business_date
      and st.product_id = v_product.id;

    select s.actual_closing_main, s.actual_closing_floor
    into v_prev_main, v_prev_floor
    from public.stock_daily_snapshots s
    where s.business_date = p_business_date - 1
      and s.product_id = v_product.id
    limit 1;

    select coalesce(ms.quantity, 0)
    into v_actual_main
    from public.main_stock ms
    where ms.product_id = v_product.id;

    v_actual_main := coalesce(v_actual_main, 0);

    select coalesce(sum(fs.quantity), 0)
    into v_actual_floor
    from public.floor_stock fs
    where fs.product_id = v_product.id;

    v_actual_floor := coalesce(v_actual_floor, 0);
    v_opening_main := coalesce(v_prev_main, v_actual_main - coalesce(v_tx.net_main_delta, 0));
    v_opening_floor := coalesce(v_prev_floor, v_actual_floor - coalesce(v_tx.net_floor_delta, 0));
    v_expected_main := v_opening_main + coalesce(v_tx.net_main_delta, 0);
    v_expected_floor := v_opening_floor + coalesce(v_tx.net_floor_delta, 0);

    select coalesce(jsonb_agg(row_to_json(floor_row)::jsonb order by floor), '[]'::jsonb)
    into v_floor_breakdown
    from (
      select
        fs.floor_number as floor,
        greatest(coalesce(fs.quantity, 0) - coalesce(sum(
          case
            when st.action = 'use' then st.quantity_change
            when st.action = 'return' and st.reference_type = 'housekeeping_return' then st.quantity_change
            when st.action = 'return' and st.reference_type in ('fo_return', 'fo_prepare_return') then -st.quantity_change
            when st.action = 'adjust' and st.floor_number is not null then st.quantity_change
            when st.action = 'transfer_in' and st.to_location like 'floor_%' then st.quantity_change
            when st.action = 'transfer_out' and st.from_location like 'floor_%' then st.quantity_change
            else 0
          end
        ), 0), 0) as opening,
        abs(coalesce(sum(st.quantity_change) filter (where st.action = 'use'), 0)) as used,
        coalesce(sum(st.quantity_change) filter (where st.action = 'adjust' and st.reference_type = 'fo_amenity_audit_correction'), 0) as audit_correction,
        coalesce(sum(st.quantity_change) filter (where st.action = 'transfer_in' and st.reference_type = 'fo_amenity_audit_refill'), 0) as refill,
        coalesce(fs.quantity, 0) as closing,
        0 as variance
      from public.floor_stock fs
      left join public.stock_transactions_v2 st
        on st.product_id = fs.product_id
       and st.floor_number = fs.floor_number
       and st.transaction_date = p_business_date
      where fs.product_id = v_product.id
      group by fs.floor_number, fs.quantity
    ) floor_row;

    insert into public.stock_daily_snapshots (
      business_date,
      product_id,
      product_name,
      category,
      tracking_mode,
      opening_main,
      opening_floor,
      sold_qty,
      voided_qty,
      used_qty,
      hk_returned_qty,
      transferred_main_to_floor,
      transferred_floor_to_main,
      received_qty,
      adjusted_qty,
      audit_correction_qty,
      audit_refill_qty,
      expected_closing_main,
      expected_closing_floor,
      actual_closing_main,
      actual_closing_floor,
      variance_main,
      variance_floor,
      floor_breakdown,
      computed_at,
      updated_at
    )
    values (
      p_business_date,
      v_product.id,
      v_product.name,
      v_product.category,
      v_product.stock_tracking_mode,
      v_opening_main,
      v_opening_floor,
      abs(coalesce(v_tx.sale_delta, 0)),
      coalesce(v_tx.pos_return_delta, 0),
      abs(coalesce(v_tx.use_delta, 0)),
      coalesce(v_tx.hk_return_delta, 0),
      abs(coalesce(v_tx.transfer_main_out_delta, 0)),
      coalesce(v_tx.fo_return_delta, 0) + abs(coalesce(v_tx.transfer_floor_out_delta, 0)),
      coalesce(v_tx.receive_delta, 0),
      coalesce(v_tx.adjust_delta, 0),
      coalesce(v_tx.audit_correction_delta, 0),
      coalesce(v_tx.audit_refill_delta, 0),
      v_expected_main,
      v_expected_floor,
      v_actual_main,
      v_actual_floor,
      v_actual_main - v_expected_main,
      v_actual_floor - v_expected_floor,
      case when v_product.stock_tracking_mode = 'pos_main_only' then '[]'::jsonb else coalesce(v_floor_breakdown, '[]'::jsonb) end,
      v_now,
      v_now
    )
    on conflict (business_date, product_id) do update
    set
      product_name = excluded.product_name,
      category = excluded.category,
      tracking_mode = excluded.tracking_mode,
      opening_main = excluded.opening_main,
      opening_floor = excluded.opening_floor,
      sold_qty = excluded.sold_qty,
      voided_qty = excluded.voided_qty,
      used_qty = excluded.used_qty,
      hk_returned_qty = excluded.hk_returned_qty,
      transferred_main_to_floor = excluded.transferred_main_to_floor,
      transferred_floor_to_main = excluded.transferred_floor_to_main,
      received_qty = excluded.received_qty,
      adjusted_qty = excluded.adjusted_qty,
      audit_correction_qty = excluded.audit_correction_qty,
      audit_refill_qty = excluded.audit_refill_qty,
      expected_closing_main = excluded.expected_closing_main,
      expected_closing_floor = excluded.expected_closing_floor,
      actual_closing_main = excluded.actual_closing_main,
      actual_closing_floor = excluded.actual_closing_floor,
      variance_main = excluded.variance_main,
      variance_floor = excluded.variance_floor,
      floor_breakdown = excluded.floor_breakdown,
      computed_at = excluded.computed_at,
      updated_at = excluded.updated_at,
      recomputed_count = public.stock_daily_snapshots.recomputed_count + 1;

    v_products_computed := v_products_computed + 1;
    if (v_actual_main - v_expected_main) <> 0 or (v_actual_floor - v_expected_floor) <> 0 then
      v_variance_count := v_variance_count + 1;
    end if;
  end loop;

  update public.daily_snapshots ds
  set
    stock_variance_count = v_variance_count,
    stock_total_products = v_products_computed,
    stock_reconcile_status = case when v_variance_count = 0 then 'clean' else 'pending' end,
    stock_computed_at = v_now
  where ds.business_date = p_business_date;

  return jsonb_build_object(
    'products_computed', v_products_computed,
    'variance_count', v_variance_count,
    'clean_count', greatest(v_products_computed - v_variance_count, 0)
  );
end;
$$;

REVOKE EXECUTE ON FUNCTION public.compute_stock_snapshot(date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_stock_snapshot(date)
  TO service_role;

COMMIT;
