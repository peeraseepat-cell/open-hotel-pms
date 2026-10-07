begin;

-- ============================================================
-- Phase 10.x: FO Daily Prepare Flow (Water/Coffee style)
-- ============================================================

alter table public.products
  add column if not exists fulfillment_mode text not null default 'standard'
    check (fulfillment_mode in ('standard', 'daily_prepare'));

create index if not exists idx_products_fulfillment_mode
  on public.products (fulfillment_mode);

create table if not exists public.fo_prepare_batches (
  id uuid primary key default gen_random_uuid(),
  business_date date not null unique,
  status text not null default 'prepared'
    check (status in ('prepared', 'returned', 'cancelled')),
  prepared_at timestamptz not null default timezone('utc', now()),
  prepared_by text,
  prepare_note text,
  insufficient_warning boolean not null default false,
  returned_at timestamptz,
  returned_by text,
  return_note text,
  return_override_note text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_fo_prepare_batches_date
  on public.fo_prepare_batches (business_date desc);

create index if not exists idx_fo_prepare_batches_status
  on public.fo_prepare_batches (status);

create table if not exists public.fo_prepare_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.fo_prepare_batches(id) on delete cascade,
  floor_number int not null check (floor_number > 0),
  product_id uuid not null references public.products(id) on delete restrict,
  suggested_qty int not null default 0 check (suggested_qty >= 0),
  requested_qty int not null default 0 check (requested_qty >= 0),
  prepared_qty int not null default 0 check (prepared_qty >= 0),
  shortage_qty int not null default 0 check (shortage_qty >= 0),
  used_qty int not null default 0 check (used_qty >= 0),
  remaining_qty int not null default 0 check (remaining_qty >= 0),
  returned_qty int not null default 0 check (returned_qty >= 0),
  return_note text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (batch_id, floor_number, product_id)
);

create index if not exists idx_fo_prepare_items_batch
  on public.fo_prepare_batch_items (batch_id);

create index if not exists idx_fo_prepare_items_floor
  on public.fo_prepare_batch_items (floor_number);

create index if not exists idx_fo_prepare_items_product
  on public.fo_prepare_batch_items (product_id);

create or replace function public.fo_prepare_daily_stock(
  p_business_date date,
  p_prepared_by text default null,
  p_prepare_note text default null,
  p_items jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_actor text := nullif(trim(coalesce(p_prepared_by, '')), '');
  v_note text := nullif(trim(coalesce(p_prepare_note, '')), '');
  v_batch_id uuid;
  v_existing_id uuid;
  v_existing_status text;
  v_item jsonb;
  v_floor_number int;
  v_product_id uuid;
  v_suggested int;
  v_requested int;
  v_main_current int;
  v_moved int;
  v_shortage int;
  v_floor_after int;
  v_item_count int := 0;
  v_total_requested int := 0;
  v_total_prepared int := 0;
  v_total_shortage int := 0;
  v_has_shortage boolean := false;
begin
  if p_business_date is null then
    raise exception 'p_business_date is required';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'p_items must be non-empty array';
  end if;

  select b.id, b.status
  into v_existing_id, v_existing_status
  from public.fo_prepare_batches b
  where b.business_date = p_business_date
  limit 1
  for update;

  if found then
    raise exception 'FO prepare batch already exists for % (status: %)', p_business_date, v_existing_status;
  end if;

  insert into public.fo_prepare_batches (
    business_date,
    status,
    prepared_at,
    prepared_by,
    prepare_note,
    insufficient_warning,
    created_at,
    updated_at
  )
  values (
    p_business_date,
    'prepared',
    v_now,
    v_actor,
    v_note,
    false,
    v_now,
    v_now
  )
  returning id into v_batch_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_floor_number := null;
    v_product_id := null;
    v_suggested := 0;
    v_requested := 0;

    begin
      v_floor_number := (v_item ->> 'floor_number')::int;
    exception when others then
      v_floor_number := null;
    end;

    begin
      v_product_id := (v_item ->> 'product_id')::uuid;
    exception when others then
      v_product_id := null;
    end;

    begin
      v_suggested := greatest(coalesce((v_item ->> 'suggested_qty')::int, 0), 0);
    exception when others then
      v_suggested := 0;
    end;

    begin
      v_requested := greatest(coalesce((v_item ->> 'requested_qty')::int, 0), 0);
    exception when others then
      v_requested := 0;
    end;

    if v_floor_number is null or v_floor_number <= 0 or v_product_id is null or v_requested <= 0 then
      continue;
    end if;

    insert into public.main_stock (product_id, quantity, reorder_level, updated_at)
    values (v_product_id, 0, 10, v_now)
    on conflict (product_id) do nothing;

    select quantity
    into v_main_current
    from public.main_stock
    where product_id = v_product_id
    for update;

    v_moved := least(coalesce(v_main_current, 0), v_requested);
    v_shortage := greatest(v_requested - v_moved, 0);

    if v_moved > 0 then
      update public.main_stock
      set quantity = greatest(coalesce(v_main_current, 0) - v_moved, 0),
          updated_at = v_now
      where product_id = v_product_id;

      insert into public.floor_stock (floor_number, product_id, quantity, updated_at)
      values (v_floor_number, v_product_id, v_moved, v_now)
      on conflict (floor_number, product_id)
      do update set
        quantity = public.floor_stock.quantity + excluded.quantity,
        updated_at = v_now;

      select quantity
      into v_floor_after
      from public.floor_stock
      where floor_number = v_floor_number
        and product_id = v_product_id;

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
      values
      (
        p_business_date,
        v_product_id,
        'transfer_out',
        -v_moved,
        'main',
        'floor_' || v_floor_number::text,
        'fo_prepare',
        v_batch_id,
        v_floor_number,
        v_actor,
        coalesce(v_note, 'FO prepare daily stock'),
        v_now
      ),
      (
        p_business_date,
        v_product_id,
        'transfer_in',
        v_moved,
        'main',
        'floor_' || v_floor_number::text,
        'fo_prepare',
        v_batch_id,
        v_floor_number,
        v_actor,
        coalesce(v_note, 'FO prepare daily stock'),
        v_now
      );
    else
      v_floor_after := coalesce((
        select fs.quantity
        from public.floor_stock fs
        where fs.floor_number = v_floor_number
          and fs.product_id = v_product_id
        limit 1
      ), 0);
    end if;

    insert into public.fo_prepare_batch_items (
      batch_id,
      floor_number,
      product_id,
      suggested_qty,
      requested_qty,
      prepared_qty,
      shortage_qty,
      used_qty,
      remaining_qty,
      returned_qty,
      created_at,
      updated_at
    )
    values (
      v_batch_id,
      v_floor_number,
      v_product_id,
      v_suggested,
      v_requested,
      v_moved,
      v_shortage,
      0,
      v_moved,
      0,
      v_now,
      v_now
    );

    v_item_count := v_item_count + 1;
    v_total_requested := v_total_requested + v_requested;
    v_total_prepared := v_total_prepared + v_moved;
    v_total_shortage := v_total_shortage + v_shortage;
    if v_shortage > 0 then
      v_has_shortage := true;
    end if;
  end loop;

  if v_item_count = 0 then
    raise exception 'No valid items for FO prepare';
  end if;

  update public.fo_prepare_batches
  set
    insufficient_warning = v_has_shortage,
    updated_at = v_now
  where id = v_batch_id;

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'item_count', v_item_count,
    'total_requested', v_total_requested,
    'total_prepared', v_total_prepared,
    'total_shortage', v_total_shortage,
    'has_shortage', v_has_shortage
  );
end;
$$;

create or replace function public.fo_return_daily_stock(
  p_batch_id uuid,
  p_returned_by text default null,
  p_return_note text default null,
  p_items jsonb default '[]'::jsonb,
  p_force boolean default false,
  p_override_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_actor text := nullif(trim(coalesce(p_returned_by, '')), '');
  v_note text := nullif(trim(coalesce(p_return_note, '')), '');
  v_override_note text := nullif(trim(coalesce(p_override_note, '')), '');
  v_batch public.fo_prepare_batches%rowtype;
  v_item jsonb;
  v_item_id uuid;
  v_return_qty int;
  v_item_note text;
  v_line public.fo_prepare_batch_items%rowtype;
  v_used_qty int;
  v_system_remaining int;
  v_floor_current int;
  v_main_current int;
  v_processed_count int := 0;
  v_expected_count int := 0;
  v_total_returned int := 0;
  v_seen_ids uuid[] := '{}'::uuid[];
begin
  if p_batch_id is null then
    raise exception 'p_batch_id is required';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'p_items must be non-empty array';
  end if;

  select *
  into v_batch
  from public.fo_prepare_batches
  where id = p_batch_id
  for update;

  if not found then
    raise exception 'FO prepare batch not found';
  end if;

  if v_batch.status <> 'prepared' then
    raise exception 'Batch status must be prepared (current: %)', v_batch.status;
  end if;

  select count(*)
  into v_expected_count
  from public.fo_prepare_batch_items
  where batch_id = p_batch_id
    and prepared_qty > 0;

  if v_expected_count = 0 then
    raise exception 'No prepared items found in batch';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_item_id := null;
    v_return_qty := 0;
    v_item_note := null;

    begin
      v_item_id := (v_item ->> 'item_id')::uuid;
    exception when others then
      v_item_id := null;
    end;

    begin
      v_return_qty := greatest(coalesce((v_item ->> 'return_qty')::int, 0), 0);
    exception when others then
      v_return_qty := 0;
    end;

    v_item_note := nullif(trim(coalesce(v_item ->> 'note', '')), '');

    if v_item_id is null then
      raise exception 'Each return item must include valid item_id';
    end if;

    if v_item_id = any(v_seen_ids) then
      raise exception 'Duplicate return item_id in payload: %', v_item_id;
    end if;
    v_seen_ids := array_append(v_seen_ids, v_item_id);

    select *
    into v_line
    from public.fo_prepare_batch_items
    where id = v_item_id
      and batch_id = p_batch_id
    for update;

    if not found then
      raise exception 'Batch item not found: %', v_item_id;
    end if;

    if v_return_qty > v_line.prepared_qty then
      raise exception 'return_qty exceeds prepared_qty for item % (prepared %, return %)',
        v_item_id, v_line.prepared_qty, v_return_qty;
    end if;

    select coalesce(sum(abs(st.quantity_change)), 0)::int
    into v_used_qty
    from public.stock_transactions_v2 st
    where st.transaction_date = v_batch.business_date
      and st.action = 'use'
      and st.reference_type = 'housekeeping_task'
      and st.product_id = v_line.product_id
      and st.floor_number = v_line.floor_number;

    v_system_remaining := greatest(v_line.prepared_qty - v_used_qty, 0);

    if v_return_qty <> v_system_remaining and v_item_note is null then
      raise exception
        'Return note is required when return_qty differs from system remaining (item %: return %, system %)',
        v_item_id, v_return_qty, v_system_remaining;
    end if;

    select quantity
    into v_floor_current
    from public.floor_stock
    where floor_number = v_line.floor_number
      and product_id = v_line.product_id
    for update;

    if not found then
      v_floor_current := 0;
    end if;

    if v_return_qty > v_floor_current then
      raise exception
        'insufficient floor stock for return (item %, floor %, have %, return %)',
        v_item_id, v_line.floor_number, v_floor_current, v_return_qty;
    end if;

    insert into public.main_stock (product_id, quantity, reorder_level, updated_at)
    values (v_line.product_id, 0, 10, v_now)
    on conflict (product_id) do nothing;

    select quantity
    into v_main_current
    from public.main_stock
    where product_id = v_line.product_id
    for update;

    if v_return_qty > 0 then
      update public.floor_stock
      set quantity = greatest(v_floor_current - v_return_qty, 0),
          updated_at = v_now
      where floor_number = v_line.floor_number
        and product_id = v_line.product_id;

      update public.main_stock
      set quantity = coalesce(v_main_current, 0) + v_return_qty,
          updated_at = v_now
      where product_id = v_line.product_id;

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
        v_batch.business_date,
        v_line.product_id,
        'return',
        v_return_qty,
        'floor_' || v_line.floor_number::text,
        'main',
        'fo_return',
        p_batch_id,
        v_line.floor_number,
        v_actor,
        coalesce(v_item_note, v_note, 'FO return remaining stock'),
        v_now
      );
    end if;

    update public.fo_prepare_batch_items
    set
      used_qty = v_used_qty,
      remaining_qty = greatest(v_system_remaining - v_return_qty, 0),
      returned_qty = v_return_qty,
      return_note = coalesce(v_item_note, return_note),
      updated_at = v_now
    where id = v_item_id;

    v_total_returned := v_total_returned + v_return_qty;
    v_processed_count := v_processed_count + 1;
  end loop;

  if v_processed_count <> v_expected_count then
    raise exception
      'Return payload incomplete. Expected % items, received %',
      v_expected_count, v_processed_count;
  end if;

  if coalesce(p_force, false) and v_override_note is null then
    raise exception 'override note is required when force return is true';
  end if;

  update public.fo_prepare_batches
  set
    status = 'returned',
    returned_at = v_now,
    returned_by = v_actor,
    return_note = v_note,
    return_override_note = case when coalesce(p_force, false) then v_override_note else null end,
    updated_at = v_now
  where id = p_batch_id;

  return jsonb_build_object(
    'batch_id', p_batch_id,
    'processed_items', v_processed_count,
    'total_returned', v_total_returned,
    'force_return', coalesce(p_force, false)
  );
end;
$$;

alter table public.fo_prepare_batches enable row level security;
alter table public.fo_prepare_batch_items enable row level security;

drop policy if exists fo_prepare_batches_allow_all on public.fo_prepare_batches;
create policy fo_prepare_batches_allow_all
  on public.fo_prepare_batches
  for all
  using (true)
  with check (true);

drop policy if exists fo_prepare_batch_items_allow_all on public.fo_prepare_batch_items;
create policy fo_prepare_batch_items_allow_all
  on public.fo_prepare_batch_items
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on table public.fo_prepare_batches to anon, authenticated;
grant select, insert, update, delete on table public.fo_prepare_batch_items to anon, authenticated;
grant execute on function public.fo_prepare_daily_stock(date, text, text, jsonb) to anon, authenticated;
grant execute on function public.fo_return_daily_stock(uuid, text, text, jsonb, boolean, text) to anon, authenticated;

commit;
