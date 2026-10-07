begin;

create extension if not exists "pgcrypto";

-- ============================================================
-- Phase 10: POS + Inventory + Stock v2
-- ============================================================

create sequence if not exists public.pos_order_seq start with 1;

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sku text unique,
  category text not null default 'amenity'
    check (category in ('amenity', 'pos', 'both')),
  unit text not null default 'pieces',
  sale_price numeric(10,2),
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.main_stock (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  quantity int not null default 0 check (quantity >= 0),
  reorder_level int not null default 10,
  updated_at timestamptz not null default timezone('utc', now()),
  unique (product_id)
);

create table if not exists public.floor_stock (
  id uuid primary key default gen_random_uuid(),
  floor_number int not null,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity int not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (floor_number, product_id)
);

create table if not exists public.stock_transactions_v2 (
  id uuid primary key default gen_random_uuid(),
  transaction_date date not null default current_date,
  product_id uuid not null references public.products(id),
  action text not null check (action in ('use','transfer_out','transfer_in','sale','receive','adjust','return')),
  quantity_change int not null,
  from_location text,
  to_location text,
  reference_type text,
  reference_id uuid,
  room_number text,
  floor_number int,
  performed_by text,
  note text,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_stock_tx_v2_date on public.stock_transactions_v2 (transaction_date);
create index if not exists idx_stock_tx_v2_product on public.stock_transactions_v2 (product_id);
create index if not exists idx_stock_tx_v2_floor on public.stock_transactions_v2 (floor_number);
create index if not exists idx_stock_tx_v2_ref on public.stock_transactions_v2 (reference_type, reference_id);

create table if not exists public.pos_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  order_type text not null check (order_type in ('walkin', 'guest_charge')),
  reservation_id uuid references public.reservations(id),
  guest_name text,
  status text not null default 'completed' check (status in ('pending', 'completed', 'voided')),
  subtotal numeric(10,2) not null default 0,
  total numeric(10,2) not null default 0,
  payment_method text,
  note text,
  created_by text,
  order_date date not null default current_date,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_pos_orders_date on public.pos_orders(order_date);
create index if not exists idx_pos_orders_status on public.pos_orders(status);
create index if not exists idx_pos_orders_type on public.pos_orders(order_type);
create index if not exists idx_pos_orders_reservation on public.pos_orders(reservation_id);

create table if not exists public.pos_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.pos_orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  product_name text not null,
  quantity int not null default 1 check (quantity > 0),
  unit_price numeric(10,2) not null,
  line_total numeric(10,2) not null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_pos_order_items_order on public.pos_order_items(order_id);
create index if not exists idx_pos_order_items_product on public.pos_order_items(product_id);

alter table public.checklist_templates
  add column if not exists product_id uuid references public.products(id);

alter table public.folio_payments
  add column if not exists pos_order_id uuid references public.pos_orders(id);

create index if not exists idx_checklist_templates_product on public.checklist_templates(product_id);
create index if not exists idx_folio_payments_pos_order on public.folio_payments(pos_order_id);

create or replace function public.generate_pos_order_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq bigint;
  v_today text;
begin
  v_today := to_char(current_date, 'YYYYMMDD');
  v_seq := nextval('public.pos_order_seq');
  return 'POS-' || v_today || '-' || lpad(v_seq::text, 4, '0');
end;
$$;

create or replace function public.stock_transfer(
  p_product_id uuid,
  p_floor_number int,
  p_quantity int,
  p_note text default null,
  p_performed_by text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_main_qty int;
  v_main_after int;
  v_floor_after int;
  v_now timestamptz := timezone('utc', now());
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_actor text := nullif(trim(coalesce(p_performed_by, '')), '');
begin
  if p_product_id is null then
    raise exception 'p_product_id is required';
  end if;

  if p_floor_number is null or p_floor_number <= 0 then
    raise exception 'p_floor_number must be > 0';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'p_quantity must be > 0';
  end if;

  insert into public.main_stock (product_id, quantity, reorder_level, updated_at)
  values (p_product_id, 0, 10, v_now)
  on conflict (product_id) do nothing;

  select quantity
  into v_main_qty
  from public.main_stock
  where product_id = p_product_id
  for update;

  if v_main_qty < p_quantity then
    raise exception 'insufficient main stock for product % (have %, need %)', p_product_id, v_main_qty, p_quantity;
  end if;

  v_main_after := v_main_qty - p_quantity;

  update public.main_stock
  set quantity = v_main_after,
      updated_at = v_now
  where product_id = p_product_id;

  insert into public.floor_stock (floor_number, product_id, quantity, updated_at)
  values (p_floor_number, p_product_id, p_quantity, v_now)
  on conflict (floor_number, product_id)
  do update set
    quantity = public.floor_stock.quantity + excluded.quantity,
    updated_at = v_now;

  select quantity
  into v_floor_after
  from public.floor_stock
  where floor_number = p_floor_number
    and product_id = p_product_id;

  insert into public.stock_transactions_v2 (
    transaction_date,
    product_id,
    action,
    quantity_change,
    from_location,
    to_location,
    reference_type,
    floor_number,
    performed_by,
    note,
    created_at
  )
  values
  (
    (v_now at time zone 'Asia/Bangkok')::date,
    p_product_id,
    'transfer_out',
    -p_quantity,
    'main',
    'floor_' || p_floor_number::text,
    'transfer',
    p_floor_number,
    v_actor,
    coalesce(v_note, 'main to floor transfer'),
    v_now
  ),
  (
    (v_now at time zone 'Asia/Bangkok')::date,
    p_product_id,
    'transfer_in',
    p_quantity,
    'main',
    'floor_' || p_floor_number::text,
    'transfer',
    p_floor_number,
    v_actor,
    coalesce(v_note, 'main to floor transfer'),
    v_now
  );

  return jsonb_build_object(
    'main_remaining', v_main_after,
    'floor_new_quantity', v_floor_after,
    'moved_quantity', p_quantity,
    'floor_number', p_floor_number
  );
end;
$$;

create or replace function public.hk_deduct_floor_stock(
  p_task_id uuid,
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
  v_used int;
  v_current int;
  v_deduct int;
  v_after int;
  v_note text;
  v_processed int := 0;
  v_skipped int := 0;
  v_oversell int := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return jsonb_build_object('processed', 0, 'skipped', 0, 'oversell', 0);
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_product_id := null;
    begin
      v_product_id := (v_item ->> 'product_id')::uuid;
    exception when others then
      v_product_id := null;
    end;

    v_used := greatest(coalesce((v_item ->> 'used')::int, 0), 0);

    if v_product_id is null or v_used <= 0 then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    select quantity
    into v_current
    from public.floor_stock
    where floor_number = p_floor_number
      and product_id = v_product_id
    for update;

    if not found then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_deduct := least(v_current, v_used);
    v_after := greatest(v_current - v_used, 0);

    update public.floor_stock
    set quantity = v_after,
        updated_at = v_now
    where floor_number = p_floor_number
      and product_id = v_product_id;

    if v_used > v_current then
      v_oversell := v_oversell + (v_used - v_current);
      v_note := format(
        'HK used %s, deducted %s (oversell %s)',
        v_used,
        v_deduct,
        (v_used - v_current)
      );
    else
      v_note := format('HK used %s, deducted %s', v_used, v_deduct);
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
      'use',
      -v_deduct,
      'floor_' || p_floor_number::text,
      null,
      'housekeeping_task',
      p_task_id,
      p_room_number,
      p_floor_number,
      nullif(trim(coalesce(p_maid_name, '')), ''),
      v_note,
      v_now
    );

    v_processed := v_processed + 1;
  end loop;

  return jsonb_build_object('processed', v_processed, 'skipped', v_skipped, 'oversell', v_oversell);
end;
$$;

create or replace function public.pos_create_order(
  p_order_type text,
  p_items jsonb,
  p_payment_method text,
  p_reservation_id uuid,
  p_created_by text,
  p_note text
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
  v_order_id uuid;
  v_order_number text;
  v_guest_name text;
  v_subtotal numeric(10,2) := 0;
  v_total numeric(10,2) := 0;
  v_folio_payment_id uuid;
  v_item jsonb;
  v_product record;
  v_product_id uuid;
  v_qty int;
  v_line_total numeric(10,2);
  v_main_current int;
  v_deduct int;
  v_oversell int;
  v_order_date date := (v_now at time zone 'Asia/Bangkok')::date;
begin
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
  else
    v_payment_method := null;
    if p_reservation_id is null then
      raise exception 'p_reservation_id is required for guest_charge';
    end if;

    select r.guest_name
    into v_guest_name
    from public.reservations r
    where r.id = p_reservation_id
      and r.status = 'active'
      and exists (
        select 1
        from public.reservation_nights rn
        where rn.reservation_id = r.id
          and rn.stay_date = v_order_date
          and rn.cancelled_at is null
      )
    limit 1;

    if v_guest_name is null then
      raise exception 'reservation is not eligible for guest_charge';
    end if;
  end if;

  v_order_number := public.generate_pos_order_number();

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
    v_order_number,
    v_order_type,
    case when v_order_type = 'guest_charge' then p_reservation_id else null end,
    case when v_order_type = 'guest_charge' then v_guest_name else null end,
    'completed',
    v_subtotal,
    v_total,
    v_payment_method,
    v_note,
    v_created_by,
    v_order_date,
    v_now,
    v_now
  )
  returning id into v_order_id;

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

  if v_order_type = 'guest_charge' then
    insert into public.folio_payments (
      reservation_id,
      tx_type,
      method,
      amount,
      note,
      paid_at,
      paid_date,
      pos_order_id
    )
    values (
      p_reservation_id,
      'payment',
      'other',
      v_total,
      coalesce(v_note, 'POS guest charge ' || v_order_number),
      v_now,
      v_order_date,
      v_order_id
    )
    returning id into v_folio_payment_id;
  end if;

  return jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_number,
    'folio_payment_id', v_folio_payment_id,
    'subtotal', v_subtotal,
    'total', v_total
  );
end;
$$;

create or replace function public.pos_void_order(
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
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_voided_by text := nullif(trim(coalesce(p_voided_by, '')), '');
  v_order_date date;
  v_refund_payment_id uuid;
begin
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

  v_order_date := (v_now at time zone 'Asia/Bangkok')::date;

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

  if v_order.order_type = 'guest_charge' and v_order.reservation_id is not null and v_order.total > 0 then
    insert into public.folio_payments (
      reservation_id,
      tx_type,
      method,
      amount,
      note,
      paid_at,
      paid_date,
      pos_order_id
    )
    values (
      v_order.reservation_id,
      'refund',
      'other',
      v_order.total,
      coalesce(v_note, 'POS void refund ' || v_order.order_number),
      v_now,
      v_order_date,
      p_order_id
    )
    returning id into v_refund_payment_id;
  end if;

  return jsonb_build_object(
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'status', 'voided',
    'refund_payment_id', v_refund_payment_id
  );
end;
$$;

-- updated_at triggers (safe)
drop trigger if exists trg_products_updated_at on public.products;
create trigger trg_products_updated_at
before update on public.products
for each row execute function public.set_updated_at();

drop trigger if exists trg_pos_orders_updated_at on public.pos_orders;
create trigger trg_pos_orders_updated_at
before update on public.pos_orders
for each row execute function public.set_updated_at();

alter table public.products enable row level security;
alter table public.main_stock enable row level security;
alter table public.floor_stock enable row level security;
alter table public.stock_transactions_v2 enable row level security;
alter table public.pos_orders enable row level security;
alter table public.pos_order_items enable row level security;

drop policy if exists products_allow_all on public.products;
create policy products_allow_all on public.products
for all to anon, authenticated
using (true)
with check (true);

drop policy if exists main_stock_allow_all on public.main_stock;
create policy main_stock_allow_all on public.main_stock
for all to anon, authenticated
using (true)
with check (true);

drop policy if exists floor_stock_allow_all on public.floor_stock;
create policy floor_stock_allow_all on public.floor_stock
for all to anon, authenticated
using (true)
with check (true);

drop policy if exists stock_transactions_v2_allow_all on public.stock_transactions_v2;
create policy stock_transactions_v2_allow_all on public.stock_transactions_v2
for all to anon, authenticated
using (true)
with check (true);

drop policy if exists pos_orders_allow_all on public.pos_orders;
create policy pos_orders_allow_all on public.pos_orders
for all to anon, authenticated
using (true)
with check (true);

drop policy if exists pos_order_items_allow_all on public.pos_order_items;
create policy pos_order_items_allow_all on public.pos_order_items
for all to anon, authenticated
using (true)
with check (true);

grant execute on function public.generate_pos_order_number() to anon, authenticated;
grant execute on function public.stock_transfer(uuid, int, int, text, text) to anon, authenticated;
grant execute on function public.hk_deduct_floor_stock(uuid, text, int, text, jsonb) to anon, authenticated;
grant execute on function public.pos_create_order(text, jsonb, text, uuid, text, text) to anon, authenticated;
grant execute on function public.pos_void_order(uuid, text, text) to anon, authenticated;

insert into public.products (name, category, unit, sale_price)
values
  ('Water Bottle', 'both', 'bottles', 20.00),
  ('Coffee', 'amenity', 'sachets', null),
  ('Soap', 'amenity', 'bars', null),
  ('Shampoo', 'amenity', 'bottles', null),
  ('Toothbrush Set', 'amenity', 'sets', null),
  ('Sewing Kit', 'amenity', 'sets', null),
  ('Shower Cap', 'amenity', 'pieces', null),
  ('Razor', 'amenity', 'pieces', null)
on conflict (name) do nothing;

update public.checklist_templates ct
set product_id = p.id
from public.products p
where lower(ct.item_name) = lower(p.name)
  and ct.product_id is null;

insert into public.main_stock (product_id, quantity, reorder_level)
select p.id, 0, 10
from public.products p
where p.category in ('amenity','both')
on conflict (product_id) do nothing;

insert into public.floor_stock (floor_number, product_id, quantity)
select floors.floor_no, p.id, 0
from generate_series(1, 3) as floors(floor_no)
cross join public.products p
where p.category in ('amenity','both')
on conflict (floor_number, product_id) do nothing;

comment on table public.stock_items is 'DEPRECATED Phase 10 -> use products + main_stock + floor_stock';
comment on table public.maid_cart_items is 'DEPRECATED Phase 10 -> use floor_stock';
comment on table public.stock_transactions is 'DEPRECATED Phase 10 -> use stock_transactions_v2';

commit;
