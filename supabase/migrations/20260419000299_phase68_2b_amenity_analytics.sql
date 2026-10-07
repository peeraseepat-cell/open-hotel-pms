begin;

-- Phase 68.2b: Amenity Analytics RPCs.
-- Locks from Lead:
-- - room_type filter uses room type codes via p_room_type_codes (same contract as Linen)
-- - Max uses sold room nights from business_date - 1
-- - Actual roomtype filtering is allocated by setup × occupancy weighting
-- - Predict is trailing-14-day median from FO reconciled consumption only

create or replace function public.fn_amenity_analytics_category_key(p_product_name text)
returns text
language sql
immutable
as $$
  select 'amenity.' || coalesce(
    nullif(
      trim(both '_' from regexp_replace(lower(coalesce(p_product_name, 'item')), '[^a-z0-9]+', '_', 'g')),
      ''
    ),
    'item'
  );
$$;

create or replace function public.fn_amenity_analytics_categories()
returns table (
  category_key text,
  label text,
  source_hint text
)
language sql
security definer
set search_path = public
as $$
  select
    public.fn_amenity_analytics_category_key(p.name) as category_key,
    p.name as label,
    case
      when p.stock_tracking_mode = 'amenity_prepare' then 'fo_reconciled'
      else 'audit_adjusted'
    end as source_hint
  from public.products p
  where coalesce(p.is_active, true) = true
    and p.stock_tracking_mode in ('amenity_prepare', 'amenity_direct')
  order by
    case p.stock_tracking_mode
      when 'amenity_prepare' then 1
      when 'amenity_direct' then 2
      else 9
    end,
    p.name;
$$;

create or replace function public.fn_amenity_analytics_variance(
  p_start date,
  p_end date,
  p_categories text[] default null,
  p_source text default 'all',
  p_room_type_codes text[] default null
)
returns table (
  category text,
  label text,
  source text,
  actual_qty numeric,
  predict_qty numeric,
  max_qty numeric,
  statistical_qty numeric,
  actual_source text,
  has_setup boolean,
  history_sample_size int,
  days_in_period int
)
language sql
security definer
set search_path = public
as $$
  with params as (
    select
      p_start as start_date,
      p_end as end_date,
      greatest((p_end - p_start + 1), 0)::int as days_in_period,
      coalesce(nullif(p_source, ''), 'all') as source_filter,
      coalesce(cardinality(p_room_type_codes), 0) > 0 as has_room_filter
  ),
  requested_sources as (
    select unnest(
      case
        when (select source_filter from params) = 'all' then array['fo_reconciled', 'audit_adjusted']::text[]
        else array[(select source_filter from params)]::text[]
      end
    ) as source
  ),
  product_scope as (
    select
      p.id as product_id,
      p.name as label,
      p.stock_tracking_mode,
      case
        when p.stock_tracking_mode = 'amenity_prepare' then 'fo_reconciled'
        else 'audit_adjusted'
      end as source,
      public.fn_amenity_analytics_category_key(p.name) as category
    from public.products p
    join requested_sources rs
      on rs.source = case
        when p.stock_tracking_mode = 'amenity_prepare' then 'fo_reconciled'
        else 'audit_adjusted'
      end
    where coalesce(p.is_active, true) = true
      and p.stock_tracking_mode in ('amenity_prepare', 'amenity_direct')
      and (
        p_categories is null
        or cardinality(p_categories) = 0
        or public.fn_amenity_analytics_category_key(p.name) = any(p_categories)
      )
  ),
  setup_presence as (
    select rtas.product_id, count(*)::int as setup_count
    from public.room_type_amenity_setups rtas
    group by rtas.product_id
  ),
  days as (
    select generate_series(
      (select start_date from params),
      (select end_date from params),
      interval '1 day'
    )::date as business_date
  ),
  sold_nights as (
    select
      d.business_date,
      r.room_type_id,
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
      or sn.room_type_code = any(p_room_type_codes)
  ),
  selected_max as (
    select
      rtas.product_id,
      coalesce(sum(rtas.units_per_occupied_night), 0)::numeric as max_qty
    from selected_sold_nights sn
    join public.room_type_amenity_setups rtas on rtas.room_type_id = sn.room_type_id
    group by rtas.product_id
  ),
  total_max as (
    select
      rtas.product_id,
      coalesce(sum(rtas.units_per_occupied_night), 0)::numeric as max_qty
    from sold_nights sn
    join public.room_type_amenity_setups rtas on rtas.room_type_id = sn.room_type_id
    group by rtas.product_id
  ),
  fo_actual as (
    select
      v.product_id,
      'fo_reconciled'::text as source,
      coalesce(sum(v.consumed_qty), 0)::numeric as actual_qty
    from public.v_amenity_consumption_daily v
    cross join params p
    where v.business_date >= p.start_date
      and v.business_date <= p.end_date
    group by v.product_id
  ),
  audit_actual as (
    select
      ai.product_id,
      'audit_adjusted'::text as source,
      coalesce(sum(greatest(ai.refill_delta, 0)), 0)::numeric as actual_qty
    from public.fo_amenity_audit_sessions s
    join public.fo_amenity_audit_items ai on ai.session_id = s.id
    join public.products pdt on pdt.id = ai.product_id
    cross join params p
    where s.business_date >= p.start_date
      and s.business_date <= p.end_date
      and pdt.stock_tracking_mode = 'amenity_direct'
    group by ai.product_id
  ),
  actuals as (
    select * from fo_actual
    union all
    select * from audit_actual
  ),
  history as (
    select
      v.product_id,
      count(*)::int as sample_size,
      percentile_cont(0.5) within group (order by v.consumed_qty)::numeric as median_daily
    from public.v_amenity_consumption_daily v
    cross join params p
    where v.business_date >= (p.start_date - interval '14 days')::date
      and v.business_date < p.start_date
    group by v.product_id
  )
  select
    ps.category,
    ps.label,
    ps.source,
    case
      when max(par.has_room_filter::int) = 1 and coalesce(max(sp.setup_count), 0) > 0 then
        case
          when coalesce(max(tm.max_qty), 0) > 0
            then (coalesce(max(a.actual_qty), 0) * coalesce(max(sm.max_qty), 0) / max(tm.max_qty))::numeric
          else 0::numeric
        end
      else coalesce(max(a.actual_qty), 0)::numeric
    end as actual_qty,
    case
      when ps.source = 'fo_reconciled' and coalesce(max(h.sample_size), 0) >= 7
        then (max(h.median_daily) * max(par.days_in_period))::numeric
      else null::numeric
    end as predict_qty,
    case
      when coalesce(max(sp.setup_count), 0) = 0 then null::numeric
      else coalesce(max(sm.max_qty), 0)::numeric
    end as max_qty,
    null::numeric as statistical_qty,
    case
      when max(par.has_room_filter::int) = 1 and coalesce(max(sp.setup_count), 0) > 0 then 'allocated'
      else 'direct'
    end as actual_source,
    coalesce(max(sp.setup_count), 0) > 0 as has_setup,
    coalesce(max(h.sample_size), 0)::int as history_sample_size,
    max(par.days_in_period)::int as days_in_period
  from product_scope ps
  cross join params par
  left join actuals a on a.product_id = ps.product_id and a.source = ps.source
  left join selected_max sm on sm.product_id = ps.product_id
  left join total_max tm on tm.product_id = ps.product_id
  left join setup_presence sp on sp.product_id = ps.product_id
  left join history h on h.product_id = ps.product_id
  group by ps.product_id, ps.category, ps.label, ps.source
  order by ps.source, ps.label;
$$;

create or replace function public.fn_amenity_analytics_trend(
  p_start date,
  p_end date,
  p_window text default 'day',
  p_source text default 'all',
  p_room_type_codes text[] default null
)
returns table (
  period date,
  actual numeric,
  predict numeric,
  max numeric,
  statistical numeric
)
language sql
security definer
set search_path = public
as $$
  with params as (
    select
      p_start as start_date,
      p_end as end_date,
      case when p_window in ('day', 'week', 'month') then p_window else 'day' end as bucket_window,
      coalesce(nullif(p_source, ''), 'all') as source_filter,
      coalesce(cardinality(p_room_type_codes), 0) > 0 as has_room_filter
  ),
  day_periods as (
    select
      gs::date as business_date,
      case
        when (select bucket_window from params) = 'month' then date_trunc('month', gs)::date
        when (select bucket_window from params) = 'week' then date_trunc('week', gs)::date
        else gs::date
      end as period_start
    from generate_series(
      (select start_date from params),
      (select end_date from params),
      interval '1 day'
    ) gs
  ),
  period_days as (
    select period_start, count(*)::int as days_in_bucket
    from day_periods
    group by period_start
  ),
  requested_sources as (
    select unnest(
      case
        when (select source_filter from params) = 'all' then array['fo_reconciled', 'audit_adjusted']::text[]
        else array[(select source_filter from params)]::text[]
      end
    ) as source
  ),
  product_scope as (
    select
      p.id as product_id,
      p.stock_tracking_mode,
      case
        when p.stock_tracking_mode = 'amenity_prepare' then 'fo_reconciled'
        else 'audit_adjusted'
      end as source
    from public.products p
    join requested_sources rs
      on rs.source = case
        when p.stock_tracking_mode = 'amenity_prepare' then 'fo_reconciled'
        else 'audit_adjusted'
      end
    where coalesce(p.is_active, true) = true
      and p.stock_tracking_mode in ('amenity_prepare', 'amenity_direct')
  ),
  setup_presence as (
    select rtas.product_id, count(*)::int as setup_count
    from public.room_type_amenity_setups rtas
    group by rtas.product_id
  ),
  sold_nights as (
    select
      dp.business_date,
      dp.period_start,
      r.room_type_id,
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
      or sn.room_type_code = any(p_room_type_codes)
  ),
  selected_max_daily as (
    select
      sn.business_date,
      rtas.product_id,
      coalesce(sum(rtas.units_per_occupied_night), 0)::numeric as max_qty
    from selected_sold_nights sn
    join public.room_type_amenity_setups rtas on rtas.room_type_id = sn.room_type_id
    group by sn.business_date, rtas.product_id
  ),
  total_max_daily as (
    select
      sn.business_date,
      rtas.product_id,
      coalesce(sum(rtas.units_per_occupied_night), 0)::numeric as max_qty
    from sold_nights sn
    join public.room_type_amenity_setups rtas on rtas.room_type_id = sn.room_type_id
    group by sn.business_date, rtas.product_id
  ),
  fo_actual_daily as (
    select
      v.business_date,
      v.product_id,
      'fo_reconciled'::text as source,
      coalesce(sum(v.consumed_qty), 0)::numeric as actual_qty
    from public.v_amenity_consumption_daily v
    cross join params p
    where v.business_date >= p.start_date
      and v.business_date <= p.end_date
    group by v.business_date, v.product_id
  ),
  audit_actual_daily as (
    select
      s.business_date,
      ai.product_id,
      'audit_adjusted'::text as source,
      coalesce(sum(greatest(ai.refill_delta, 0)), 0)::numeric as actual_qty
    from public.fo_amenity_audit_sessions s
    join public.fo_amenity_audit_items ai on ai.session_id = s.id
    join public.products pdt on pdt.id = ai.product_id
    cross join params p
    where s.business_date >= p.start_date
      and s.business_date <= p.end_date
      and pdt.stock_tracking_mode = 'amenity_direct'
    group by s.business_date, ai.product_id
  ),
  actual_daily as (
    select * from fo_actual_daily
    union all
    select * from audit_actual_daily
  ),
  allocated_actual_daily as (
    select
      dp.period_start,
      ps.product_id,
      ps.source,
      case
        when max(par.has_room_filter::int) = 1 and coalesce(max(sp.setup_count), 0) > 0 then
          case
            when coalesce(max(tmd.max_qty), 0) > 0
              then (coalesce(max(ad.actual_qty), 0) * coalesce(max(smd.max_qty), 0) / max(tmd.max_qty))::numeric
            else 0::numeric
          end
        else coalesce(max(ad.actual_qty), 0)::numeric
      end as actual_qty,
      case
        when coalesce(max(sp.setup_count), 0) = 0 then null::numeric
        else coalesce(max(smd.max_qty), 0)::numeric
      end as max_qty
    from day_periods dp
    cross join product_scope ps
    cross join params par
    left join actual_daily ad on ad.business_date = dp.business_date and ad.product_id = ps.product_id and ad.source = ps.source
    left join setup_presence sp on sp.product_id = ps.product_id
    left join selected_max_daily smd on smd.business_date = dp.business_date and smd.product_id = ps.product_id
    left join total_max_daily tmd on tmd.business_date = dp.business_date and tmd.product_id = ps.product_id
    group by dp.business_date, dp.period_start, ps.product_id, ps.source
  ),
  history as (
    select
      v.product_id,
      count(*)::int as sample_size,
      percentile_cont(0.5) within group (order by v.consumed_qty)::numeric as median_daily
    from public.v_amenity_consumption_daily v
    cross join params p
    where v.business_date >= (p.start_date - interval '14 days')::date
      and v.business_date < p.start_date
    group by v.product_id
  ),
  predict_period as (
    select
      pd.period_start,
      sum(h.median_daily * pd.days_in_bucket)::numeric as predict_qty
    from period_days pd
    join product_scope ps on ps.source = 'fo_reconciled'
    join history h on h.product_id = ps.product_id and h.sample_size >= 7
    group by pd.period_start
  )
  select
    pd.period_start as period,
    coalesce(sum(aad.actual_qty), 0)::numeric as actual,
    max(pp.predict_qty)::numeric as predict,
    case
      when count(aad.max_qty) filter (where aad.max_qty is not null) = 0 then null::numeric
      else coalesce(sum(aad.max_qty), 0)::numeric
    end as max,
    null::numeric as statistical
  from period_days pd
  left join allocated_actual_daily aad on aad.period_start = pd.period_start
  left join predict_period pp on pp.period_start = pd.period_start
  group by pd.period_start
  order by pd.period_start;
$$;

create or replace function public.fn_amenity_reconciliation_variance_notes(
  p_start date,
  p_end date,
  p_categories text[] default null
)
returns table (
  business_date date,
  product_id uuid,
  category text,
  label text,
  reconciled_consumed numeric,
  maid_tap_total numeric,
  delta numeric,
  fo_return_note text,
  recorded_at timestamptz,
  recorded_by uuid,
  batch_id uuid
)
language sql
security definer
set search_path = public
as $$
  with maid_taps as (
    select
      i.batch_id,
      i.product_id,
      coalesce(sum(i.used_qty), 0)::numeric as maid_tap_total
    from public.fo_prepare_batch_items i
    group by i.batch_id, i.product_id
  )
  select
    b.business_date,
    r.product_id,
    public.fn_amenity_analytics_category_key(p.name) as category,
    p.name as label,
    r.consumed_qty::numeric as reconciled_consumed,
    coalesce(mt.maid_tap_total, 0)::numeric as maid_tap_total,
    (r.consumed_qty - coalesce(mt.maid_tap_total, 0))::numeric as delta,
    r.note as fo_return_note,
    r.recorded_at,
    r.recorded_by,
    b.id as batch_id
  from public.fo_prepare_batch_returns r
  join public.fo_prepare_batches b on b.id = r.batch_id
  join public.products p on p.id = r.product_id
  left join maid_taps mt on mt.batch_id = r.batch_id and mt.product_id = r.product_id
  where b.return_status = 'reconciled'
    and p.stock_tracking_mode = 'amenity_prepare'
    and b.business_date >= p_start
    and b.business_date <= p_end
    and (
      p_categories is null
      or cardinality(p_categories) = 0
      or public.fn_amenity_analytics_category_key(p.name) = any(p_categories)
    )
    and (
      abs(r.consumed_qty - coalesce(mt.maid_tap_total, 0)) > 0
      or nullif(trim(coalesce(r.note, '')), '') is not null
    )
  order by b.business_date desc, category asc;
$$;

grant execute on function public.fn_amenity_analytics_category_key(text) to authenticated;
grant execute on function public.fn_amenity_analytics_categories() to authenticated;
grant execute on function public.fn_amenity_analytics_variance(date, date, text[], text, text[]) to authenticated;
grant execute on function public.fn_amenity_analytics_trend(date, date, text, text, text[]) to authenticated;
grant execute on function public.fn_amenity_reconciliation_variance_notes(date, date, text[]) to authenticated;

commit;
