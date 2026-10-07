begin;

-- Phase 66.2: Monthly linen reconciliation, vendor rates, and month close.

-- 1. Rename inactive extra items 13-15 per user lock-in.
update public.linen_items
set name_th = 'ไส้นวมเล็ก', name_en = 'Single Comforter'
where item_number = 13;

update public.linen_items
set name_th = 'ไส้นวมกลาง', name_en = 'Double Comforter'
where item_number = 14;

update public.linen_items
set name_th = 'ไส้นวมใหญ่', name_en = 'King Comforter'
where item_number = 15;

-- 2. Vendor rate history by effective month.
create table if not exists public.linen_item_rates (
  id uuid primary key default gen_random_uuid(),
  linen_item_id int not null references public.linen_items(id) on delete cascade,
  effective_month date not null check (extract(day from effective_month) = 1),
  rate_per_piece numeric(10, 2) not null check (rate_per_piece >= 0),
  note text,
  created_at timestamptz not null default timezone('utc', now()),
  created_by uuid references auth.users(id),
  unique (linen_item_id, effective_month)
);

create index if not exists idx_linen_item_rates_item_month
  on public.linen_item_rates (linen_item_id, effective_month desc);

alter table public.linen_item_rates enable row level security;

drop policy if exists linen_item_rates_read on public.linen_item_rates;
create policy linen_item_rates_read on public.linen_item_rates
  for select to authenticated
  using (true);

drop policy if exists linen_item_rates_admin_write on public.linen_item_rates;
create policy linen_item_rates_admin_write on public.linen_item_rates
  for all to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and lower(coalesce(p.role::text, '')) in ('admin', 'supervisor')
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and lower(coalesce(p.role::text, '')) in ('admin', 'supervisor')
    )
  );

with seed(item_number, rate) as (values
  (1, 3), (2, 5), (3, 3), (4, 8), (5, 9), (6, 9),
  (7, 15), (8, 20), (9, 20),
  (10, 30), (11, 30), (12, 30),
  (13, 30), (14, 40), (15, 40), (16, 50)
)
insert into public.linen_item_rates (linen_item_id, effective_month, rate_per_piece, note)
select li.id, date '2026-04-01', seed.rate, 'Initial seed from Phase 66.2'
from seed
join public.linen_items li on li.item_number = seed.item_number
on conflict (linen_item_id, effective_month) do update
set rate_per_piece = excluded.rate_per_piece,
    note = excluded.note;

-- 3. Month close state.
create table if not exists public.laundry_monthly_close (
  id uuid primary key default gen_random_uuid(),
  year smallint not null,
  month smallint not null check (month between 1 and 12),
  closed_at timestamptz not null default timezone('utc', now()),
  closed_by uuid references auth.users(id),
  total_pieces int not null,
  total_baht numeric(12, 2) not null,
  reopened_at timestamptz,
  reopened_by uuid references auth.users(id),
  reopen_reason text,
  unique (year, month)
);

create index if not exists idx_laundry_monthly_close_open
  on public.laundry_monthly_close (year, month)
  where reopened_at is null;

alter table public.laundry_monthly_close enable row level security;

drop policy if exists laundry_monthly_close_read on public.laundry_monthly_close;
create policy laundry_monthly_close_read on public.laundry_monthly_close
  for select to authenticated
  using (true);

drop policy if exists laundry_monthly_close_admin_write on public.laundry_monthly_close;
create policy laundry_monthly_close_admin_write on public.laundry_monthly_close
  for all to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and lower(coalesce(p.role::text, '')) in ('admin', 'supervisor')
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and lower(coalesce(p.role::text, '')) in ('admin', 'supervisor')
    )
  );

-- 4. Variance thresholds.
create table if not exists public.linen_variance_config (
  id smallint primary key default 1 check (id = 1),
  green_min smallint not null default 90,
  green_max smallint not null default 110,
  yellow_min smallint not null default 70,
  yellow_max smallint not null default 130,
  updated_at timestamptz not null default timezone('utc', now()),
  updated_by uuid references auth.users(id),
  check (yellow_min <= green_min),
  check (green_min <= green_max),
  check (green_max <= yellow_max)
);

insert into public.linen_variance_config (id) values (1)
on conflict (id) do nothing;

alter table public.linen_variance_config enable row level security;

drop policy if exists linen_variance_config_read on public.linen_variance_config;
create policy linen_variance_config_read on public.linen_variance_config
  for select to authenticated
  using (true);

drop policy if exists linen_variance_config_admin_write on public.linen_variance_config;
create policy linen_variance_config_admin_write on public.linen_variance_config
  for all to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and lower(coalesce(p.role::text, '')) in ('admin', 'supervisor')
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and lower(coalesce(p.role::text, '')) in ('admin', 'supervisor')
    )
  );

-- 5. Rate lookup helper. Carry-forward is automatic by latest effective month.
create or replace function public.fn_linen_rate(p_linen_item_id int, p_business_date date)
returns numeric(10, 2)
language sql
stable
as $$
  select coalesce((
    select r.rate_per_piece
    from public.linen_item_rates r
    where r.linen_item_id = p_linen_item_id
      and r.effective_month <= date_trunc('month', p_business_date)::date
    order by r.effective_month desc
    limit 1
  ), 0)::numeric(10, 2);
$$;

-- 6. Monthly summary RPC. Billing canonical is sent_by_hotel, not received_back.
create or replace function public.fn_linen_monthly_summary(p_year int, p_month int)
returns table (
  linen_item_id int,
  item_number smallint,
  name_th text,
  name_en text,
  rate numeric,
  qty_sent bigint,
  qty_returned bigint,
  qty_pending bigint,
  qty_extra bigint,
  qty_dayuse bigint,
  total_baht numeric
)
language sql
stable
as $$
  with bounds as (
    select make_date(p_year, p_month, 1) as start_date,
           (make_date(p_year, p_month, 1) + interval '1 month')::date as end_date
  ),
  item_agg as (
    select
      i.linen_item_id,
      sum(case when i.is_dayuse is false then i.sent_by_hotel else 0 end)::bigint as qty_sent,
      sum(case when i.is_dayuse is false then i.received_back else 0 end)::bigint as qty_returned,
      sum(case when i.is_dayuse is false and li.item_number in (1, 2)
          then greatest(i.sent_by_hotel - i.estimated_qty, 0)
          else 0 end)::bigint as qty_extra,
      sum(case when i.is_dayuse is true then i.sent_by_hotel else 0 end)::bigint as qty_dayuse
    from public.laundry_batches b
    join public.laundry_batch_items i on i.batch_id = b.id
    join public.linen_items li on li.id = i.linen_item_id
    cross join bounds
    where b.business_date >= bounds.start_date
      and b.business_date < bounds.end_date
    group by i.linen_item_id
  )
  select
    li.id as linen_item_id,
    li.item_number,
    li.name_th,
    li.name_en,
    public.fn_linen_rate(li.id, bounds.start_date) as rate,
    coalesce(a.qty_sent, 0) as qty_sent,
    coalesce(a.qty_returned, 0) as qty_returned,
    greatest(coalesce(a.qty_sent, 0) - coalesce(a.qty_returned, 0), 0) as qty_pending,
    coalesce(a.qty_extra, 0) as qty_extra,
    coalesce(a.qty_dayuse, 0) as qty_dayuse,
    (public.fn_linen_rate(li.id, bounds.start_date) * coalesce(a.qty_sent, 0))::numeric(12, 2) as total_baht
  from public.linen_items li
  cross join bounds
  left join item_agg a on a.linen_item_id = li.id
  order by li.item_number;
$$;

-- 7. Daily grid RPC. Returns a full item x day matrix with zeros.
create or replace function public.fn_linen_monthly_daily(p_year int, p_month int)
returns table (
  linen_item_id int,
  item_number smallint,
  day_of_month int,
  qty_sent bigint
)
language sql
stable
as $$
  with bounds as (
    select make_date(p_year, p_month, 1) as start_date,
           (make_date(p_year, p_month, 1) + interval '1 month')::date as end_date
  ),
  days as (
    select generate_series(bounds.start_date, bounds.end_date - 1, interval '1 day')::date as business_date
    from bounds
  ),
  agg as (
    select i.linen_item_id, b.business_date, sum(i.sent_by_hotel)::bigint as qty_sent
    from public.laundry_batches b
    join public.laundry_batch_items i on i.batch_id = b.id
    cross join bounds
    where b.business_date >= bounds.start_date
      and b.business_date < bounds.end_date
      and i.is_dayuse is false
    group by i.linen_item_id, b.business_date
  )
  select
    li.id as linen_item_id,
    li.item_number,
    extract(day from days.business_date)::int as day_of_month,
    coalesce(agg.qty_sent, 0) as qty_sent
  from public.linen_items li
  cross join days
  left join agg on agg.linen_item_id = li.id and agg.business_date = days.business_date
  order by li.item_number, day_of_month;
$$;

create or replace function public.fn_linen_month_is_closed(p_business_date date)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.laundry_monthly_close c
    where c.year = extract(year from p_business_date)::int
      and c.month = extract(month from p_business_date)::int
      and c.reopened_at is null
  );
$$;

-- 8. Close/reopen RPCs. API layer performs admin role checks before calling.
create or replace function public.fn_linen_monthly_close(p_year int, p_month int, p_actor uuid default auth.uid())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start date := make_date(p_year, p_month, 1);
  v_end date := (make_date(p_year, p_month, 1) + interval '1 month')::date;
  v_disputed jsonb;
  v_pending jsonb;
  v_open jsonb;
  v_errors text[] := array[]::text[];
  v_total_pieces int := 0;
  v_total_baht numeric(12, 2) := 0;
  v_close public.laundry_monthly_close%rowtype;
begin
  select coalesce(jsonb_agg(b.id::text order by b.business_date, b.pickup_round), '[]'::jsonb)
  into v_disputed
  from public.laundry_batches b
  where b.business_date >= v_start
    and b.business_date < v_end
    and b.status = 'disputed';

  if jsonb_array_length(v_disputed) > 0 then
    v_errors := array_append(v_errors, 'dispute_exists');
  end if;

  select coalesce(jsonb_agg(p.id::text order by b.business_date, b.pickup_round), '[]'::jsonb)
  into v_pending
  from public.laundry_pending_items p
  join public.laundry_batches b on b.id = p.source_batch_id
  where p.resolved_batch_id is null
    and b.business_date >= v_start
    and b.business_date < v_end;

  if jsonb_array_length(v_pending) > 0 then
    v_errors := array_append(v_errors, 'pending_exists');
  end if;

  select coalesce(jsonb_agg(b.id::text order by b.business_date, b.pickup_round), '[]'::jsonb)
  into v_open
  from public.laundry_batches b
  where b.business_date >= v_start
    and b.business_date < v_end
    and b.status not in ('closed', 'partial');

  if jsonb_array_length(v_open) > 0 then
    v_errors := array_append(v_errors, 'open_batch_exists');
  end if;

  if array_length(v_errors, 1) is not null then
    return jsonb_build_object(
      'success', false,
      'close', null,
      'errors', to_jsonb(v_errors),
      'error_details', jsonb_build_object(
        'disputed_batch_ids', v_disputed,
        'pending_item_ids', v_pending,
        'open_batch_ids', v_open
      )
    );
  end if;

  select
    coalesce(sum(i.sent_by_hotel), 0)::int,
    coalesce(sum(i.sent_by_hotel * public.fn_linen_rate(i.linen_item_id, b.business_date)), 0)::numeric(12, 2)
  into v_total_pieces, v_total_baht
  from public.laundry_batches b
  join public.laundry_batch_items i on i.batch_id = b.id
  where b.business_date >= v_start
    and b.business_date < v_end;

  insert into public.laundry_monthly_close (
    year, month, closed_at, closed_by, total_pieces, total_baht,
    reopened_at, reopened_by, reopen_reason
  )
  values (p_year, p_month, timezone('utc', now()), p_actor, v_total_pieces, v_total_baht, null, null, null)
  on conflict (year, month) do update set
    closed_at = excluded.closed_at,
    closed_by = excluded.closed_by,
    total_pieces = excluded.total_pieces,
    total_baht = excluded.total_baht,
    reopened_at = null,
    reopened_by = null,
    reopen_reason = null
  returning * into v_close;

  return jsonb_build_object('success', true, 'close', to_jsonb(v_close));
end;
$$;

create or replace function public.fn_linen_monthly_reopen(p_year int, p_month int, p_reason text, p_actor uuid default auth.uid())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_close public.laundry_monthly_close%rowtype;
begin
  update public.laundry_monthly_close
  set reopened_at = timezone('utc', now()),
      reopened_by = p_actor,
      reopen_reason = nullif(trim(p_reason), '')
  where year = p_year
    and month = p_month
    and reopened_at is null
  returning * into v_close;

  if v_close.id is null then
    return jsonb_build_object('success', false, 'close', null, 'error', 'month_not_closed');
  end if;

  insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, after_json)
  values (
    p_actor,
    'linen_monthly_reopened',
    'laundry_monthly_close',
    v_close.id::text,
    jsonb_build_object('year', p_year, 'month', p_month, 'reason', p_reason)
  );

  return jsonb_build_object('success', true, 'close', to_jsonb(v_close));
end;
$$;

-- 9. Freeze guards for closed months.
create or replace function public.fn_laundry_batches_freeze_closed_month()
returns trigger
language plpgsql
as $$
declare
  v_date date;
begin
  v_date := case when tg_op = 'DELETE' then old.business_date else new.business_date end;
  if public.fn_linen_month_is_closed(v_date) then
    raise exception 'Linen month % is closed. Reopen month before editing.', to_char(v_date, 'YYYY-MM')
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.fn_laundry_batch_items_freeze_closed_month()
returns trigger
language plpgsql
as $$
declare
  v_old_date date;
  v_new_date date;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select b.business_date into v_old_date from public.laundry_batches b where b.id = old.batch_id;
    if v_old_date is not null and public.fn_linen_month_is_closed(v_old_date) then
      raise exception 'Linen month % is closed. Reopen month before editing.', to_char(v_old_date, 'YYYY-MM')
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select b.business_date into v_new_date from public.laundry_batches b where b.id = new.batch_id;
    if v_new_date is not null and public.fn_linen_month_is_closed(v_new_date) then
      raise exception 'Linen month % is closed. Reopen month before editing.', to_char(v_new_date, 'YYYY-MM')
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.fn_linen_item_rates_freeze_closed_month()
returns trigger
language plpgsql
as $$
declare
  v_old_month date;
  v_new_month date;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_old_month := old.effective_month;
    if public.fn_linen_month_is_closed(v_old_month) then
      raise exception 'Linen month % is closed. Reopen month before editing rates.', to_char(v_old_month, 'YYYY-MM')
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    v_new_month := new.effective_month;
    if public.fn_linen_month_is_closed(v_new_month) then
      raise exception 'Linen month % is closed. Reopen month before editing rates.', to_char(v_new_month, 'YYYY-MM')
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_laundry_batches_freeze_closed_month on public.laundry_batches;
create trigger trg_laundry_batches_freeze_closed_month
before insert or update or delete on public.laundry_batches
for each row execute function public.fn_laundry_batches_freeze_closed_month();

drop trigger if exists trg_laundry_batch_items_freeze_closed_month on public.laundry_batch_items;
create trigger trg_laundry_batch_items_freeze_closed_month
before insert or update or delete on public.laundry_batch_items
for each row execute function public.fn_laundry_batch_items_freeze_closed_month();

drop trigger if exists trg_linen_item_rates_freeze_closed_month on public.linen_item_rates;
create trigger trg_linen_item_rates_freeze_closed_month
before insert or update or delete on public.linen_item_rates
for each row execute function public.fn_linen_item_rates_freeze_closed_month();

commit;
