begin;

-- Phase 68.2a: FO Prepare/Return reconciliation for amenity analytics.

create table if not exists public.fo_prepare_batch_returns (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.fo_prepare_batches(id) on delete cascade,
  product_id uuid not null references public.products(id),
  prepared_qty numeric not null check (prepared_qty >= 0),
  returned_qty numeric not null default 0 check (returned_qty >= 0),
  damaged_qty numeric not null default 0 check (damaged_qty >= 0),
  consumed_qty numeric generated always as (prepared_qty - returned_qty - damaged_qty) stored,
  note text,
  recorded_by uuid references auth.users(id),
  recorded_at timestamptz not null default timezone('utc', now()),
  unique (batch_id, product_id),
  check (returned_qty + damaged_qty <= prepared_qty)
);

create index if not exists ix_fo_prepare_batch_returns_batch
  on public.fo_prepare_batch_returns(batch_id);
create index if not exists ix_fo_prepare_batch_returns_recorded
  on public.fo_prepare_batch_returns(recorded_at);
create index if not exists ix_fo_prepare_batch_returns_product_recorded
  on public.fo_prepare_batch_returns(product_id, recorded_at);

alter table public.fo_prepare_batch_returns enable row level security;

drop policy if exists fo_prepare_batch_returns_auth_all on public.fo_prepare_batch_returns;
create policy fo_prepare_batch_returns_auth_all
  on public.fo_prepare_batch_returns
  for all to authenticated
  using (true)
  with check (true);

alter table public.fo_prepare_batches
  add column if not exists return_status text not null default 'pending'
  check (return_status in ('pending', 'reconciled', 'legacy'));

update public.fo_prepare_batches
set return_status = 'legacy'
where return_status = 'pending';

create index if not exists idx_fo_prepare_batches_return_status
  on public.fo_prepare_batches(return_status);

create or replace view public.v_amenity_consumption_daily as
select
  b.business_date::date as business_date,
  r.product_id,
  p.name as product_name,
  sum(r.consumed_qty)::numeric as consumed_qty,
  sum(r.prepared_qty)::numeric as prepared_qty,
  sum(r.returned_qty)::numeric as returned_qty,
  sum(r.damaged_qty)::numeric as damaged_qty,
  count(distinct b.id)::int as batch_count
from public.fo_prepare_batch_returns r
join public.fo_prepare_batches b on b.id = r.batch_id
join public.products p on p.id = r.product_id
where b.return_status = 'reconciled'
  and p.stock_tracking_mode = 'amenity_prepare'
group by b.business_date, r.product_id, p.name;

create or replace function public.fn_fo_prepare_return_submit(
  p_batch_id uuid,
  p_returned_by text default null,
  p_return_note text default null,
  p_items jsonb default '[]'::jsonb,
  p_force boolean default false,
  p_override_note text default null,
  p_recorded_by uuid default auth.uid()
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
  v_damaged_qty int;
  v_item_note text;
  v_line public.fo_prepare_batch_items%rowtype;
  v_used_qty int;
  v_system_remaining int;
  v_floor_current int;
  v_main_current int;
  v_processed_count int := 0;
  v_expected_count int := 0;
  v_total_returned int := 0;
  v_total_damaged int := 0;
  v_total_consumed int := 0;
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

  delete from public.fo_prepare_batch_returns
  where batch_id = p_batch_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_item_id := null;
    v_return_qty := 0;
    v_damaged_qty := 0;
    v_item_note := null;

    begin
      v_item_id := (v_item ->> 'item_id')::uuid;
    exception when others then
      v_item_id := null;
    end;

    begin
      v_return_qty := greatest(coalesce((coalesce(v_item ->> 'return_qty', v_item ->> 'returned_qty'))::int, 0), 0);
    exception when others then
      v_return_qty := 0;
    end;

    begin
      v_damaged_qty := greatest(coalesce((v_item ->> 'damaged_qty')::int, 0), 0);
    exception when others then
      v_damaged_qty := 0;
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

    if v_return_qty + v_damaged_qty > v_line.prepared_qty then
      raise exception 'returned_qty + damaged_qty exceeds prepared_qty for item % (prepared %, return %, damaged %)',
        v_item_id, v_line.prepared_qty, v_return_qty, v_damaged_qty;
    end if;

    if v_damaged_qty > 0 and v_item_note is null then
      raise exception 'Damage note is required for item %', v_item_id;
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

    if (v_return_qty + v_damaged_qty) <> v_system_remaining and v_item_note is null then
      raise exception
        'Return note is required when return/damage differs from system remaining (item %: return %, damaged %, system %)',
        v_item_id, v_return_qty, v_damaged_qty, v_system_remaining;
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

    if v_return_qty + v_damaged_qty > v_floor_current then
      raise exception
        'insufficient floor stock for return/damage (item %, floor %, have %, return %, damaged %)',
        v_item_id, v_line.floor_number, v_floor_current, v_return_qty, v_damaged_qty;
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
      set quantity = greatest(quantity - v_return_qty, 0),
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
        'fo_prepare_return',
        p_batch_id,
        v_line.floor_number,
        v_actor,
        coalesce(v_item_note, v_note, 'FO prepare return remaining stock'),
        v_now
      );
    end if;

    if v_damaged_qty > 0 then
      update public.floor_stock
      set quantity = greatest(quantity - v_damaged_qty, 0),
          updated_at = v_now
      where floor_number = v_line.floor_number
        and product_id = v_line.product_id;

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
        'adjust',
        -v_damaged_qty,
        'floor_' || v_line.floor_number::text,
        'write_off',
        'fo_prepare_damaged',
        p_batch_id,
        v_line.floor_number,
        v_actor,
        v_item_note,
        v_now
      );
    end if;

    insert into public.fo_prepare_batch_returns (
      batch_id,
      product_id,
      prepared_qty,
      returned_qty,
      damaged_qty,
      note,
      recorded_by,
      recorded_at
    )
    values (
      p_batch_id,
      v_line.product_id,
      v_line.prepared_qty,
      v_return_qty,
      v_damaged_qty,
      coalesce(v_item_note, v_note),
      p_recorded_by,
      v_now
    )
    on conflict (batch_id, product_id) do update set
      prepared_qty = public.fo_prepare_batch_returns.prepared_qty + excluded.prepared_qty,
      returned_qty = public.fo_prepare_batch_returns.returned_qty + excluded.returned_qty,
      damaged_qty = public.fo_prepare_batch_returns.damaged_qty + excluded.damaged_qty,
      note = nullif(concat_ws(' | ', public.fo_prepare_batch_returns.note, excluded.note), ''),
      recorded_by = excluded.recorded_by,
      recorded_at = excluded.recorded_at;

    update public.fo_prepare_batch_items
    set
      used_qty = v_used_qty,
      remaining_qty = greatest(v_system_remaining - v_return_qty - v_damaged_qty, 0),
      returned_qty = v_return_qty,
      return_note = coalesce(v_item_note, return_note),
      updated_at = v_now
    where id = v_item_id;

    v_total_returned := v_total_returned + v_return_qty;
    v_total_damaged := v_total_damaged + v_damaged_qty;
    v_total_consumed := v_total_consumed + greatest(v_line.prepared_qty - v_return_qty - v_damaged_qty, 0);
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
    return_status = 'reconciled',
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
    'total_damaged', v_total_damaged,
    'total_consumed', v_total_consumed,
    'return_status', 'reconciled',
    'force_return', coalesce(p_force, false)
  );
end;
$$;

grant select, insert, update, delete on table public.fo_prepare_batch_returns to authenticated;
grant select on public.v_amenity_consumption_daily to authenticated;
grant execute on function public.fn_fo_prepare_return_submit(uuid, text, text, jsonb, boolean, text, uuid) to authenticated;

commit;
