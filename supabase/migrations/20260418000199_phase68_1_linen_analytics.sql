begin;

-- Phase 68.1: Linen analytics read helpers.
-- Predict baseline intentionally stays in TypeScript via calculateExpectedLinen().

create or replace function public.fn_linen_analytics_category_key(
  p_item_number int,
  p_name_en text
)
returns text
language sql
immutable
as $$
  select case p_item_number
    when 1 then 'linen.pillowcase'
    when 2 then 'linen.bath_towel'
    when 3 then 'linen.bath_mat'
    when 4 then 'linen.single_bed_sheet'
    when 5 then 'linen.double_bed_sheet'
    when 6 then 'linen.king_bed_sheet'
    when 7 then 'linen.single_duvet_cover'
    when 8 then 'linen.double_duvet_cover'
    when 9 then 'linen.king_duvet_cover'
    else 'linen.' || regexp_replace(lower(coalesce(p_name_en, p_item_number::text)), '[^a-z0-9]+', '_', 'g')
  end
$$;

create or replace function public.fn_linen_analytics_variance(
  p_start date,
  p_end date,
  p_categories text[] default null,
  p_room_types text[] default null
)
returns table (
  linen_item_id int,
  item_number text,
  name_th text,
  name_en text,
  category_key text,
  actual_qty numeric,
  predict_qty numeric,
  max_qty numeric,
  active_rooms int,
  days_in_period int
)
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    select
      least(p_start, p_end) as start_date,
      greatest(p_start, p_end) as end_date,
      greatest((greatest(p_start, p_end) - least(p_start, p_end) + 1), 0)::int as days_in_period
  ),
  items as (
    select
      li.id,
      li.item_number,
      li.name_th,
      li.name_en,
      public.fn_linen_analytics_category_key(li.item_number, li.name_en) as category_key
    from public.linen_items li
    where li.is_active = true
      and (
        p_categories is null
        or cardinality(p_categories) = 0
        or public.fn_linen_analytics_category_key(li.item_number, li.name_en) = any(p_categories)
        or li.item_number::text = any(p_categories)
      )
  ),
  actuals as (
    select
      lbi.linen_item_id,
      coalesce(sum(lbi.sent_by_hotel), 0)::numeric as actual_qty
    from public.laundry_batches lb
    join public.laundry_batch_items lbi on lbi.batch_id = lb.id
    cross join params p
    where lb.business_date >= p.start_date
      and lb.business_date <= p.end_date
      and coalesce(lbi.is_dayuse, false) = false
    group by lbi.linen_item_id
  ),
  room_counts as (
    select
      rt.code as room_type_code,
      count(*)::int as active_rooms
    from public.rooms r
    join public.room_types rt on rt.id = r.room_type_id
    where r.is_sellable = true
      and coalesce(r.is_dayuse, false) = false
    group by rt.code
  ),
  max_daily as (
    select
      rls.linen_item_id,
      coalesce(sum(rls.qty * rc.active_rooms), 0)::numeric as daily_max,
      coalesce(sum(rc.active_rooms), 0)::int as active_rooms
    from public.room_linen_setups rls
    join room_counts rc on rc.room_type_code = rls.room_type_code
    group by rls.linen_item_id
  )
  select
    i.id as linen_item_id,
    i.item_number::text,
    i.name_th,
    i.name_en,
    i.category_key,
    coalesce(a.actual_qty, 0)::numeric as actual_qty,
    0::numeric as predict_qty,
    (coalesce(md.daily_max, 0) * p.days_in_period)::numeric as max_qty,
    coalesce(md.active_rooms, 0)::int as active_rooms,
    p.days_in_period
  from items i
  cross join params p
  left join actuals a on a.linen_item_id = i.id
  left join max_daily md on md.linen_item_id = i.id
  order by i.item_number;
$$;

create or replace function public.fn_linen_analytics_trend(
  p_start date,
  p_end date,
  p_window text default 'day',
  p_categories text[] default null,
  p_room_types text[] default null
)
returns table (
  period_start date,
  actual_qty numeric,
  predict_qty numeric,
  max_qty numeric,
  statistical_qty numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    select least(p_start, p_end) as start_date, greatest(p_start, p_end) as end_date
  ),
  days as (
    select d::date as business_date
    from params p
    cross join generate_series(p.start_date, p.end_date, interval '1 day') d
  ),
  day_periods as (
    select
      business_date,
      case
        when p_window = 'week' then date_trunc('week', business_date)::date
        when p_window = 'month' then date_trunc('month', business_date)::date
        else business_date
      end as period_start
    from days
  ),
  item_filter as (
    select li.id
    from public.linen_items li
    where li.is_active = true
      and (
        p_categories is null
        or cardinality(p_categories) = 0
        or public.fn_linen_analytics_category_key(li.item_number, li.name_en) = any(p_categories)
        or li.item_number::text = any(p_categories)
      )
  ),
  actual_daily as (
    select
      lb.business_date,
      coalesce(sum(lbi.sent_by_hotel), 0)::numeric as actual_qty
    from public.laundry_batches lb
    join public.laundry_batch_items lbi on lbi.batch_id = lb.id
    join item_filter f on f.id = lbi.linen_item_id
    cross join params p
    where lb.business_date >= p.start_date
      and lb.business_date <= p.end_date
      and coalesce(lbi.is_dayuse, false) = false
    group by lb.business_date
  ),
  room_counts as (
    select rt.code as room_type_code, count(*)::int as active_rooms
    from public.rooms r
    join public.room_types rt on rt.id = r.room_type_id
    where r.is_sellable = true
      and coalesce(r.is_dayuse, false) = false
    group by rt.code
  ),
  max_daily as (
    select coalesce(sum(rls.qty * rc.active_rooms), 0)::numeric as daily_max
    from public.room_linen_setups rls
    join room_counts rc on rc.room_type_code = rls.room_type_code
    join item_filter f on f.id = rls.linen_item_id
  )
  select
    dp.period_start,
    coalesce(sum(ad.actual_qty), 0)::numeric as actual_qty,
    0::numeric as predict_qty,
    (count(*)::numeric * coalesce((select daily_max from max_daily), 0))::numeric as max_qty,
    null::numeric as statistical_qty
  from day_periods dp
  left join actual_daily ad on ad.business_date = dp.business_date
  group by dp.period_start
  order by dp.period_start;
$$;

grant execute on function public.fn_linen_analytics_category_key(int, text) to authenticated;
grant execute on function public.fn_linen_analytics_variance(date, date, text[], text[]) to authenticated;
grant execute on function public.fn_linen_analytics_trend(date, date, text, text[], text[]) to authenticated;

commit;
