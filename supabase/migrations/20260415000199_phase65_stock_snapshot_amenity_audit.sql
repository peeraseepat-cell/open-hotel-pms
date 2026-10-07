begin;

create extension if not exists "pgcrypto";

-- ============================================================
-- Phase 65: Stock Snapshot + FO Amenity Audit
-- ============================================================

create table if not exists public.stock_daily_snapshots (
  id uuid primary key default gen_random_uuid(),
  business_date date not null,
  product_id uuid not null references public.products(id),
  product_name text not null,
  category text not null,
  tracking_mode text not null,
  opening_main int not null default 0,
  opening_floor int not null default 0,
  sold_qty int not null default 0,
  voided_qty int not null default 0,
  used_qty int not null default 0,
  hk_returned_qty int not null default 0,
  transferred_main_to_floor int not null default 0,
  transferred_floor_to_main int not null default 0,
  received_qty int not null default 0,
  adjusted_qty int not null default 0,
  audit_correction_qty int not null default 0,
  audit_refill_qty int not null default 0,
  expected_closing_main int not null,
  expected_closing_floor int not null,
  actual_closing_main int not null,
  actual_closing_floor int not null,
  variance_main int not null,
  variance_floor int not null,
  floor_breakdown jsonb not null default '[]'::jsonb,
  computed_at timestamptz not null default timezone('utc', now()),
  computed_by uuid references public.profiles(user_id),
  recomputed_count int not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (business_date, product_id)
);

create index if not exists idx_stock_snapshots_date
  on public.stock_daily_snapshots (business_date desc);

create index if not exists idx_stock_snapshots_variance
  on public.stock_daily_snapshots (business_date)
  where variance_main <> 0 or variance_floor <> 0;

create index if not exists idx_stock_snapshots_mode
  on public.stock_daily_snapshots (tracking_mode, business_date);

create table if not exists public.fo_amenity_audit_sessions (
  id uuid primary key default gen_random_uuid(),
  business_date date not null,
  floor_number int not null check (floor_number > 0),
  audited_by text not null,
  audited_by_user_id uuid references public.profiles(user_id),
  session_note text,
  total_items int not null default 0,
  total_overclick_units int not null default 0,
  total_underclick_units int not null default 0,
  total_refill_units int not null default 0,
  submitted_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_fo_audit_sessions_date
  on public.fo_amenity_audit_sessions (business_date desc);

create index if not exists idx_fo_audit_sessions_floor
  on public.fo_amenity_audit_sessions (floor_number, business_date desc);

create table if not exists public.fo_amenity_audit_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.fo_amenity_audit_sessions(id) on delete cascade,
  product_id uuid not null references public.products(id),
  product_name text not null,
  system_qty_before int not null,
  physical_qty int not null,
  overclick_delta int not null,
  refill_to int not null,
  refill_delta int not null,
  item_note text,
  correction_tx_id uuid references public.stock_transactions_v2(id),
  refill_out_tx_id uuid references public.stock_transactions_v2(id),
  refill_in_tx_id uuid references public.stock_transactions_v2(id),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_fo_audit_items_session
  on public.fo_amenity_audit_items (session_id);

create index if not exists idx_fo_audit_items_product
  on public.fo_amenity_audit_items (product_id);

create index if not exists idx_fo_audit_items_overclick
  on public.fo_amenity_audit_items (overclick_delta)
  where overclick_delta <> 0;

alter table public.products
  add column if not exists stock_tracking_mode text;

alter table public.products
  alter column stock_tracking_mode set default 'amenity_direct';

update public.products
set stock_tracking_mode = 'amenity_direct'
where stock_tracking_mode is null
   or trim(stock_tracking_mode) = ''
   or stock_tracking_mode not in ('pos_main_only', 'amenity_prepare', 'amenity_direct');

update public.products
set stock_tracking_mode = 'amenity_prepare'
where lower(trim(name)) in ('water bottle', 'water for room', 'coffee');

update public.products
set stock_tracking_mode = 'amenity_direct'
where lower(trim(name)) in ('soap', 'shampoo', 'toothbrush set', 'sewing kit', 'shower cap', 'razor');

update public.products
set stock_tracking_mode = 'pos_main_only'
where category = 'pos';

alter table public.products
  alter column stock_tracking_mode set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'products_stock_tracking_mode_check'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_stock_tracking_mode_check
      check (stock_tracking_mode in ('pos_main_only', 'amenity_prepare', 'amenity_direct'));
  end if;
end $$;

create index if not exists idx_products_tracking_mode
  on public.products (stock_tracking_mode)
  where is_active = true;

alter table public.hotel_settings
  add column if not exists amenity_audit_warn_days int;

update public.hotel_settings
set amenity_audit_warn_days = 3
where amenity_audit_warn_days is null;

alter table public.hotel_settings
  alter column amenity_audit_warn_days set default 3,
  alter column amenity_audit_warn_days set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'hotel_settings_amenity_audit_warn_days_check'
      and conrelid = 'public.hotel_settings'::regclass
  ) then
    alter table public.hotel_settings
      add constraint hotel_settings_amenity_audit_warn_days_check
      check (amenity_audit_warn_days between 1 and 30);
  end if;
end $$;

alter table public.daily_snapshots
  add column if not exists stock_variance_count int not null default 0,
  add column if not exists stock_total_products int not null default 0,
  add column if not exists stock_reconcile_status text not null default 'pending',
  add column if not exists stock_reconcile_note text,
  add column if not exists stock_reconcile_ack jsonb not null default '{}'::jsonb,
  add column if not exists stock_computed_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'daily_snapshots_stock_reconcile_status_check'
      and conrelid = 'public.daily_snapshots'::regclass
  ) then
    alter table public.daily_snapshots
      add constraint daily_snapshots_stock_reconcile_status_check
      check (stock_reconcile_status in ('pending', 'clean', 'acknowledged'));
  end if;
end $$;

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
      coalesce(sum(st.quantity_change) filter (where st.action = 'return' and st.reference_type = 'fo_return'), 0) as fo_return_delta,
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
          when st.action = 'return' and st.reference_type in ('housekeeping_return', 'fo_return') then st.quantity_change
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
            when st.action = 'return' and st.reference_type in ('housekeeping_return', 'fo_return') then st.quantity_change
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

create or replace function public.fo_amenity_audit_submit(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_business_date date;
  v_floor_number int;
  v_audited_by text;
  v_audited_by_user_id uuid;
  v_session_note text;
  v_items jsonb;
  v_item jsonb;
  v_session_id uuid;
  v_product_id uuid;
  v_product_name text;
  v_product_mode text;
  v_product_active boolean;
  v_system_qty_before int;
  v_physical_qty int;
  v_refill_to int;
  v_overclick_delta int;
  v_refill_delta int;
  v_item_note text;
  v_floor_current int;
  v_main_current int;
  v_correction_tx_id uuid;
  v_refill_out_tx_id uuid;
  v_refill_in_tx_id uuid;
  v_total_items int := 0;
  v_total_overclick int := 0;
  v_total_underclick int := 0;
  v_total_refill int := 0;
begin
  v_business_date := nullif(p_payload ->> 'business_date', '')::date;
  v_floor_number := (p_payload ->> 'floor_number')::int;
  v_audited_by := nullif(trim(coalesce(p_payload ->> 'audited_by', '')), '');
  v_audited_by_user_id := nullif(p_payload ->> 'audited_by_user_id', '')::uuid;
  v_session_note := nullif(trim(coalesce(p_payload ->> 'session_note', '')), '');
  v_items := coalesce(p_payload -> 'items', '[]'::jsonb);

  if v_business_date is null then
    select hs.business_date into v_business_date
    from public.hotel_settings hs
    where hs.id = 1;
  end if;

  if v_business_date is null then
    raise exception 'business_date is required';
  end if;

  if v_floor_number is null or v_floor_number <= 0 then
    raise exception 'floor_number is required';
  end if;

  if v_audited_by is null then
    raise exception 'audited_by is required';
  end if;

  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'items is required';
  end if;

  insert into public.fo_amenity_audit_sessions (
    business_date,
    floor_number,
    audited_by,
    audited_by_user_id,
    session_note,
    submitted_at,
    created_at
  )
  values (
    v_business_date,
    v_floor_number,
    v_audited_by,
    v_audited_by_user_id,
    v_session_note,
    v_now,
    v_now
  )
  returning id into v_session_id;

  for v_item in select value from jsonb_array_elements(v_items)
  loop
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_system_qty_before := (v_item ->> 'system_qty_before')::int;
    v_physical_qty := (v_item ->> 'physical_qty')::int;
    v_refill_to := coalesce(nullif(v_item ->> 'refill_to', '')::int, v_physical_qty);
    v_item_note := nullif(trim(coalesce(v_item ->> 'item_note', '')), '');

    if v_product_id is null then
      raise exception 'product_id is required';
    end if;

    if v_system_qty_before is null or v_system_qty_before < 0 then
      raise exception 'system_qty_before must be >= 0';
    end if;

    if v_physical_qty is null or v_physical_qty < 0 then
      raise exception 'physical_qty must be >= 0';
    end if;

    if v_refill_to < v_physical_qty then
      raise exception 'refill_to must be >= physical_qty';
    end if;

    select p.name, p.stock_tracking_mode, p.is_active
    into v_product_name, v_product_mode, v_product_active
    from public.products p
    where p.id = v_product_id;

    if v_product_name is null or v_product_active is not true or v_product_mode <> 'amenity_direct' then
      raise exception 'Product % is not an active amenity_direct product', v_product_id;
    end if;

    select fs.quantity
    into v_floor_current
    from public.floor_stock fs
    where fs.floor_number = v_floor_number
      and fs.product_id = v_product_id
    for update;

    if v_floor_current is null then
      raise exception 'Floor stock row missing for product % on floor %', v_product_id, v_floor_number;
    end if;

    if v_floor_current <> v_system_qty_before then
      raise exception 'STOCK_CONFLICT product_id=% system_qty_submitted=% system_qty_now=%',
        v_product_id,
        v_system_qty_before,
        v_floor_current;
    end if;

    v_overclick_delta := v_physical_qty - v_system_qty_before;
    v_refill_delta := v_refill_to - v_physical_qty;

    if v_overclick_delta <> 0 and v_item_note is null then
      raise exception 'item_note is required when physical_qty differs from system_qty_before';
    end if;

    v_correction_tx_id := null;
    v_refill_out_tx_id := null;
    v_refill_in_tx_id := null;

    if v_overclick_delta <> 0 then
      insert into public.stock_transactions_v2 (
        transaction_date,
        product_id,
        action,
        quantity_change,
        from_location,
        to_location,
        reference_type,
        reference_id,
        floor_number,
        performed_by,
        note,
        created_at
      )
      values (
        v_business_date,
        v_product_id,
        'adjust',
        v_overclick_delta,
        'floor_' || v_floor_number::text,
        'floor_' || v_floor_number::text,
        'fo_amenity_audit_correction',
        v_session_id,
        v_floor_number,
        v_audited_by,
        v_item_note,
        v_now
      )
      returning id into v_correction_tx_id;

      update public.floor_stock
      set quantity = quantity + v_overclick_delta,
          updated_at = v_now
      where floor_number = v_floor_number
        and product_id = v_product_id;
    end if;

    if v_refill_delta > 0 then
      insert into public.main_stock (product_id, quantity, reorder_level, updated_at)
      values (v_product_id, 0, 10, v_now)
      on conflict (product_id) do nothing;

      select ms.quantity
      into v_main_current
      from public.main_stock ms
      where ms.product_id = v_product_id
      for update;

      if coalesce(v_main_current, 0) < v_refill_delta then
        raise exception 'Insufficient main stock for %, required %, available %',
          v_product_name,
          v_refill_delta,
          coalesce(v_main_current, 0);
      end if;

      insert into public.stock_transactions_v2 (
        transaction_date,
        product_id,
        action,
        quantity_change,
        from_location,
        to_location,
        reference_type,
        reference_id,
        floor_number,
        performed_by,
        note,
        created_at
      )
      values (
        v_business_date,
        v_product_id,
        'transfer_out',
        -v_refill_delta,
        'main',
        'floor_' || v_floor_number::text,
        'fo_amenity_audit_refill',
        v_session_id,
        v_floor_number,
        v_audited_by,
        coalesce(v_item_note, v_session_note, 'FO amenity audit refill'),
        v_now
      )
      returning id into v_refill_out_tx_id;

      insert into public.stock_transactions_v2 (
        transaction_date,
        product_id,
        action,
        quantity_change,
        from_location,
        to_location,
        reference_type,
        reference_id,
        floor_number,
        performed_by,
        note,
        created_at
      )
      values (
        v_business_date,
        v_product_id,
        'transfer_in',
        v_refill_delta,
        'main',
        'floor_' || v_floor_number::text,
        'fo_amenity_audit_refill',
        v_session_id,
        v_floor_number,
        v_audited_by,
        coalesce(v_item_note, v_session_note, 'FO amenity audit refill'),
        v_now
      )
      returning id into v_refill_in_tx_id;

      update public.main_stock
      set quantity = quantity - v_refill_delta,
          updated_at = v_now
      where product_id = v_product_id;

      update public.floor_stock
      set quantity = quantity + v_refill_delta,
          updated_at = v_now
      where floor_number = v_floor_number
        and product_id = v_product_id;
    end if;

    insert into public.fo_amenity_audit_items (
      session_id,
      product_id,
      product_name,
      system_qty_before,
      physical_qty,
      overclick_delta,
      refill_to,
      refill_delta,
      item_note,
      correction_tx_id,
      refill_out_tx_id,
      refill_in_tx_id,
      created_at
    )
    values (
      v_session_id,
      v_product_id,
      v_product_name,
      v_system_qty_before,
      v_physical_qty,
      v_overclick_delta,
      v_refill_to,
      v_refill_delta,
      v_item_note,
      v_correction_tx_id,
      v_refill_out_tx_id,
      v_refill_in_tx_id,
      v_now
    );

    v_total_items := v_total_items + 1;
    v_total_overclick := v_total_overclick + greatest(v_overclick_delta, 0);
    v_total_underclick := v_total_underclick + abs(least(v_overclick_delta, 0));
    v_total_refill := v_total_refill + v_refill_delta;
  end loop;

  update public.fo_amenity_audit_sessions
  set
    total_items = v_total_items,
    total_overclick_units = v_total_overclick,
    total_underclick_units = v_total_underclick,
    total_refill_units = v_total_refill
  where id = v_session_id;

  return jsonb_build_object(
    'session_id', v_session_id,
    'items_count', v_total_items,
    'total_overclick', v_total_overclick,
    'total_underclick', v_total_underclick,
    'total_refill', v_total_refill
  );
end;
$$;

create or replace function public.acknowledge_stock_reconcile_section(
  p_business_date date,
  p_section text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ack jsonb;
  v_all_sections_acked boolean;
  v_summary text;
begin
  if p_business_date is null then
    raise exception 'business_date is required';
  end if;

  if p_section not in ('pos', 'amenity_prepare', 'amenity_direct') then
    raise exception 'Invalid stock reconcile section: %', p_section;
  end if;

  insert into public.daily_snapshots (business_date)
  values (p_business_date)
  on conflict (business_date) do nothing;

  update public.daily_snapshots
  set stock_reconcile_ack = jsonb_set(
        coalesce(stock_reconcile_ack, '{}'::jsonb),
        array[p_section],
        coalesce(p_payload, '{}'::jsonb),
        true
      )
  where business_date = p_business_date
  returning stock_reconcile_ack into v_ack;

  v_all_sections_acked :=
    (v_ack ? 'pos') and
    (v_ack ? 'amenity_prepare') and
    (v_ack ? 'amenity_direct');

  select string_agg(
    key || ': ' || coalesce(nullif(value ->> 'note', ''), value ->> 'status', 'acknowledged'),
    '; ' order by key
  )
  into v_summary
  from jsonb_each(coalesce(v_ack, '{}'::jsonb));

  update public.daily_snapshots
  set
    stock_reconcile_status = case when v_all_sections_acked then 'acknowledged' else 'pending' end,
    stock_reconcile_note = nullif(v_summary, '')
  where business_date = p_business_date;

  return jsonb_build_object(
    'acknowledged_at', p_payload ->> 'acknowledged_at',
    'acknowledged_by', p_payload ->> 'acknowledged_by',
    'all_sections_acked', v_all_sections_acked,
    'acknowledgment', p_payload
  );
end;
$$;

alter table public.stock_daily_snapshots enable row level security;
alter table public.fo_amenity_audit_sessions enable row level security;
alter table public.fo_amenity_audit_items enable row level security;

drop policy if exists stock_daily_snapshots_allow_all on public.stock_daily_snapshots;
create policy stock_daily_snapshots_allow_all
  on public.stock_daily_snapshots
  for all
  using (true)
  with check (true);

drop policy if exists fo_amenity_audit_sessions_allow_all on public.fo_amenity_audit_sessions;
create policy fo_amenity_audit_sessions_allow_all
  on public.fo_amenity_audit_sessions
  for all
  using (true)
  with check (true);

drop policy if exists fo_amenity_audit_items_allow_all on public.fo_amenity_audit_items;
create policy fo_amenity_audit_items_allow_all
  on public.fo_amenity_audit_items
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on table public.stock_daily_snapshots to anon, authenticated;
grant select, insert, update, delete on table public.fo_amenity_audit_sessions to anon, authenticated;
grant select, insert, update, delete on table public.fo_amenity_audit_items to anon, authenticated;
grant execute on function public.compute_stock_snapshot(date) to anon, authenticated;
grant execute on function public.fo_amenity_audit_submit(jsonb) to anon, authenticated;
grant execute on function public.acknowledge_stock_reconcile_section(date, text, jsonb) to anon, authenticated;

commit;
