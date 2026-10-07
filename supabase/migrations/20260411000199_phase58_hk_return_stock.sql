create table if not exists public.housekeeping_amenity_ledger (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  task_id uuid references public.housekeeping_tasks(id) on delete set null,
  stay_date date not null,
  room_number text not null,
  floor_number int not null,
  product_id uuid not null references public.products(id),
  item_name text not null,
  action text not null check (action in ('deliver', 'return')),
  quantity int not null check (quantity > 0),
  performed_by text,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_hk_amenity_ledger_res_room_product
  on public.housekeeping_amenity_ledger (reservation_id, room_id, product_id);

create index if not exists idx_hk_amenity_ledger_task
  on public.housekeeping_amenity_ledger (task_id);

create index if not exists idx_hk_amenity_ledger_created_at
  on public.housekeeping_amenity_ledger (created_at desc);

create or replace function public.hk_return_floor_stock(
  p_task_id uuid,
  p_reservation_id uuid,
  p_room_id uuid,
  p_room_number text,
  p_floor_number int,
  p_maid_name text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_item jsonb;
  v_product_id uuid;
  v_quantity int;
  v_available int;
  v_current_floor_qty int;
  v_item_name text;
  v_processed int := 0;
begin
  if p_reservation_id is null then
    raise exception 'p_reservation_id is required';
  end if;

  if p_room_id is null then
    raise exception 'p_room_id is required';
  end if;

  if p_room_number is null or length(trim(p_room_number)) = 0 then
    raise exception 'p_room_number is required';
  end if;

  if p_floor_number is null or p_floor_number <= 0 then
    raise exception 'p_floor_number must be > 0';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return jsonb_build_object('processed', 0);
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    begin
      v_product_id := (v_item ->> 'product_id')::uuid;
    exception when others then
      v_product_id := null;
    end;

    v_quantity := greatest(coalesce((v_item ->> 'quantity')::int, 0), 0);

    if v_product_id is null or v_quantity <= 0 then
      continue;
    end if;

    select
      greatest(
        coalesce(sum(case when action = 'deliver' then quantity else 0 end), 0) -
        coalesce(sum(case when action = 'return' then quantity else 0 end), 0),
        0
      )
    into v_available
    from public.housekeeping_amenity_ledger
    where reservation_id = p_reservation_id
      and room_id = p_room_id
      and product_id = v_product_id;

    if v_available < v_quantity then
      raise exception 'return quantity exceeds available delivered stock for product % (available %, requested %)',
        v_product_id, v_available, v_quantity;
    end if;

    insert into public.floor_stock (floor_number, product_id, quantity, updated_at)
    values (p_floor_number, v_product_id, 0, v_now)
    on conflict (floor_number, product_id) do nothing;

    select quantity
    into v_current_floor_qty
    from public.floor_stock
    where floor_number = p_floor_number
      and product_id = v_product_id
    for update;

    update public.floor_stock
    set quantity = coalesce(v_current_floor_qty, 0) + v_quantity,
        updated_at = v_now
    where floor_number = p_floor_number
      and product_id = v_product_id;

    select hal.item_name
    into v_item_name
    from public.housekeeping_amenity_ledger hal
    where hal.reservation_id = p_reservation_id
      and hal.room_id = p_room_id
      and hal.product_id = v_product_id
    order by hal.created_at desc
    limit 1;

    if v_item_name is null then
      select p.name
      into v_item_name
      from public.products p
      where p.id = v_product_id
      limit 1;
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
      room_number,
      floor_number,
      performed_by,
      note,
      created_at
    )
    values (
      (v_now at time zone 'Asia/Bangkok')::date,
      v_product_id,
      'return',
      v_quantity,
      'room_' || trim(p_room_number),
      'floor_' || p_floor_number::text,
      'housekeeping_return',
      p_task_id,
      trim(p_room_number),
      p_floor_number,
      nullif(trim(coalesce(p_maid_name, '')), ''),
      coalesce(v_item_name, 'HK return'),
      v_now
    );

    insert into public.housekeeping_amenity_ledger (
      reservation_id,
      room_id,
      task_id,
      stay_date,
      room_number,
      floor_number,
      product_id,
      item_name,
      action,
      quantity,
      performed_by,
      created_at
    )
    values (
      p_reservation_id,
      p_room_id,
      p_task_id,
      (v_now at time zone 'Asia/Bangkok')::date,
      trim(p_room_number),
      p_floor_number,
      v_product_id,
      coalesce(v_item_name, 'Unknown'),
      'return',
      v_quantity,
      nullif(trim(coalesce(p_maid_name, '')), ''),
      v_now
    );

    v_processed := v_processed + 1;
  end loop;

  return jsonb_build_object('processed', v_processed);
end;
$$;

grant execute on function public.hk_return_floor_stock(uuid, uuid, uuid, text, int, text, jsonb) to anon, authenticated;
