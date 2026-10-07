begin;

-- Phase 68.1B hotfix: CLOSED / non-sellable room types are not analytical
-- room types and must never contribute to Linen Max.

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
      greatest((greatest(p_start, p_end) - least(p_start, p_end) + 1), 0)::int as days_in_period,
      coalesce(cardinality(p_room_types), 0) > 0 as has_room_filter
  ),
  days as (
    select d::date as business_date
    from params p
    cross join generate_series(p.start_date, p.end_date, interval '1 day') d
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
  sold_nights as (
    select
      d.business_date,
      rt.code as room_type_code
    from days d
    join public.reservation_nights rn on rn.stay_date = (d.business_date - interval '1 day')::date
    join public.reservations res on res.id = rn.reservation_id
    join public.rooms r on r.id = rn.room_id
    join public.room_types rt on rt.id = r.room_type_id
    where rn.cancelled_at is null
      and res.status in ('active', 'checked_out')
      and coalesce(res.is_dayuse, false) = false
      and coalesce(r.is_dayuse, false) = false
      and coalesce(r.is_sellable, false) = true
      and upper(coalesce(rt.code, '')) <> 'CLOSED'
      and lower(coalesce(rt.name_en, '')) not like '%closed%'
  ),
  selected_sold_nights as (
    select sn.*
    from sold_nights sn
    cross join params p
    where not p.has_room_filter
      or sn.room_type_code = any(p_room_types)
  ),
  selected_max as (
    select
      rls.linen_item_id,
      coalesce(sum(rls.qty), 0)::numeric as max_qty,
      count(*)::int as sold_room_nights
    from selected_sold_nights sn
    join public.room_linen_setups rls on rls.room_type_code = sn.room_type_code
    group by rls.linen_item_id
  ),
  total_max as (
    select
      rls.linen_item_id,
      coalesce(sum(rls.qty), 0)::numeric as max_qty
    from sold_nights sn
    join public.room_linen_setups rls on rls.room_type_code = sn.room_type_code
    group by rls.linen_item_id
  )
  select
    i.id as linen_item_id,
    i.item_number::text,
    i.name_th,
    i.name_en,
    i.category_key,
    case
      when p.has_room_filter then
        case
          when coalesce(tm.max_qty, 0) > 0
            then (coalesce(a.actual_qty, 0) * coalesce(sm.max_qty, 0) / tm.max_qty)::numeric
          else 0::numeric
        end
      else coalesce(a.actual_qty, 0)::numeric
    end as actual_qty,
    0::numeric as predict_qty,
    coalesce(sm.max_qty, 0)::numeric as max_qty,
    coalesce(sm.sold_room_nights, 0)::int as active_rooms,
    p.days_in_period
  from items i
  cross join params p
  left join actuals a on a.linen_item_id = i.id
  left join selected_max sm on sm.linen_item_id = i.id
  left join total_max tm on tm.linen_item_id = i.id
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
    select
      least(p_start, p_end) as start_date,
      greatest(p_start, p_end) as end_date,
      coalesce(cardinality(p_room_types), 0) > 0 as has_room_filter
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
  actual_period as (
    select
      dp.period_start,
      coalesce(sum(lbi.sent_by_hotel), 0)::numeric as actual_qty
    from day_periods dp
    join public.laundry_batches lb on lb.business_date = dp.business_date
    join public.laundry_batch_items lbi on lbi.batch_id = lb.id
    join item_filter f on f.id = lbi.linen_item_id
    where coalesce(lbi.is_dayuse, false) = false
    group by dp.period_start
  ),
  sold_nights as (
    select
      dp.period_start,
      rt.code as room_type_code
    from day_periods dp
    join public.reservation_nights rn on rn.stay_date = (dp.business_date - interval '1 day')::date
    join public.reservations res on res.id = rn.reservation_id
    join public.rooms r on r.id = rn.room_id
    join public.room_types rt on rt.id = r.room_type_id
    where rn.cancelled_at is null
      and res.status in ('active', 'checked_out')
      and coalesce(res.is_dayuse, false) = false
      and coalesce(r.is_dayuse, false) = false
      and coalesce(r.is_sellable, false) = true
      and upper(coalesce(rt.code, '')) <> 'CLOSED'
      and lower(coalesce(rt.name_en, '')) not like '%closed%'
  ),
  selected_sold_nights as (
    select sn.*
    from sold_nights sn
    cross join params p
    where not p.has_room_filter
      or sn.room_type_code = any(p_room_types)
  ),
  selected_max_period as (
    select
      sn.period_start,
      coalesce(sum(rls.qty), 0)::numeric as max_qty
    from selected_sold_nights sn
    join public.room_linen_setups rls on rls.room_type_code = sn.room_type_code
    join item_filter f on f.id = rls.linen_item_id
    group by sn.period_start
  ),
  total_max_period as (
    select
      sn.period_start,
      coalesce(sum(rls.qty), 0)::numeric as max_qty
    from sold_nights sn
    join public.room_linen_setups rls on rls.room_type_code = sn.room_type_code
    join item_filter f on f.id = rls.linen_item_id
    group by sn.period_start
  )
  select
    dp.period_start,
    case
      when max(p.has_room_filter::int) = 1 then
        case
          when coalesce(max(tmp.max_qty), 0) > 0
            then (coalesce(max(ap.actual_qty), 0) * coalesce(max(smp.max_qty), 0) / max(tmp.max_qty))::numeric
          else 0::numeric
        end
      else coalesce(max(ap.actual_qty), 0)::numeric
    end as actual_qty,
    0::numeric as predict_qty,
    coalesce(max(smp.max_qty), 0)::numeric as max_qty,
    null::numeric as statistical_qty
  from day_periods dp
  cross join params p
  left join actual_period ap on ap.period_start = dp.period_start
  left join selected_max_period smp on smp.period_start = dp.period_start
  left join total_max_period tmp on tmp.period_start = dp.period_start
  group by dp.period_start
  order by dp.period_start;
$$;

grant execute on function public.fn_linen_analytics_variance(date, date, text[], text[]) to authenticated;
grant execute on function public.fn_linen_analytics_trend(date, date, text, text[], text[]) to authenticated;

commit;
