-- ============================================================================
-- Phase 72 · Migration 005 — get_rate_grid_with_occ RPC
-- ============================================================================
-- Owner: Agent B
-- Reviewer: Lead (P1 — return shape must match RateGridResponseV2 exactly)
-- Depends on: 001, 20260219_000001_init_core.sql (rate_templates, rooms,
--             room_types, reservations)
--
-- LAYER 0 SKELETON — DO NOT APPLY UNTIL AGENT B FILLS BODY.
-- Agent B creates:
--   get_rate_grid_with_occ(p_start DATE, p_end DATE) RETURNS JSONB
--
-- Response contract (see src/lib/rates/types.ts → RateGridResponseV2):
-- {
--   success: true,
--   start_date, end_date, days: [...],
--   room_types: [{ type_id, type_name, type_code, rooms: [{room_id, room_number, rates:{date:price}}]}],
--   occupancy: {
--     per_room_type: { [type_id]: { [date]: { booked, total, pct } } },
--     hotel_wide:    { [date]: { booked, total, pct } }
--   }
-- }
--
-- P1 invariants Lead will verify:
--   1. Closed rooms excluded from `total` (status != 'closed').
--   2. Cancelled/no_show reservations excluded from `booked`.
--   3. Date-range inclusive on both ends; `days` array length = end-start+1.
--   4. pct rounded to 1 decimal; never NaN (guard total=0 → pct=0).
-- ============================================================================

-- Agent B: implement full migration below this line.

create or replace function public.get_rate_grid_with_occ(p_start date, p_end date)
returns jsonb
language plpgsql
stable
as $$
declare
  v_result jsonb;
begin
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'Invalid date range for get_rate_grid_with_occ(% , %)', p_start, p_end;
  end if;

  with days as (
    select generate_series(p_start, p_end, interval '1 day')::date as stay_date
  ),
  eligible_rooms as (
    select
      r.id,
      r.room_number,
      r.room_type_id,
      rt.name_en,
      rt.code,
      coalesce(rt.sort_order, 0) as type_sort_order
    from public.rooms r
    join public.room_types rt on rt.id = r.room_type_id
    where coalesce(r.is_sellable, false) = true
      and coalesce(r.is_dayuse, false) = false
  ),
  room_types_in_scope as (
    select distinct
      er.room_type_id,
      er.name_en,
      er.code,
      er.type_sort_order
    from eligible_rooms er
  ),
  room_rates as (
    select
      er.room_type_id,
      er.name_en,
      er.code,
      er.type_sort_order,
      er.id as room_id,
      er.room_number,
      d.stay_date,
      rt.price
    from eligible_rooms er
    cross join days d
    left join public.rate_templates rt
      on rt.room_id = er.id
     and rt.stay_date = d.stay_date
  ),
  room_rate_json as (
    select
      rr.room_type_id,
      rr.name_en,
      rr.code,
      rr.type_sort_order,
      rr.room_id,
      rr.room_number,
      jsonb_object_agg(
        rr.stay_date::text,
        to_jsonb(case when rr.price is null then null else round(rr.price, 2) end)
        order by rr.stay_date
      ) as rates_json
    from room_rates rr
    group by rr.room_type_id, rr.name_en, rr.code, rr.type_sort_order, rr.room_id, rr.room_number
  ),
  room_type_json as (
    select
      rj.room_type_id,
      rj.name_en,
      rj.code,
      rj.type_sort_order,
      jsonb_agg(
        jsonb_build_object(
          'room_id', rj.room_id::text,
          'room_number', rj.room_number,
          'rates', rj.rates_json
        )
        order by rj.room_number
      ) as rooms_json
    from room_rate_json rj
    group by rj.room_type_id, rj.name_en, rj.code, rj.type_sort_order
  ),
  room_count as (
    select er.room_type_id, count(*)::int as total
    from eligible_rooms er
    group by er.room_type_id
  ),
  booked as (
    select
      er.room_type_id,
      d.stay_date,
      count(distinct rn.room_id)::int as booked
    from days d
    cross join room_types_in_scope er
    left join public.reservation_nights rn
      on rn.stay_date = d.stay_date
     and rn.cancelled_at is null
    left join public.rooms booked_room
      on booked_room.id = rn.room_id
     and booked_room.room_type_id = er.room_type_id
     and coalesce(booked_room.is_sellable, false) = true
     and coalesce(booked_room.is_dayuse, false) = false
    left join public.reservations res
      on res.id = rn.reservation_id
     and res.status not in ('cancelled', 'no_show')
    where booked_room.id is not null
      and res.id is not null
    group by er.room_type_id, d.stay_date
  ),
  occ_type as (
    select
      rtis.room_type_id,
      d.stay_date,
      coalesce(b.booked, 0)::int as booked,
      coalesce(rc.total, 0)::int as total,
      case
        when coalesce(rc.total, 0) > 0 then round((coalesce(b.booked, 0)::numeric * 100.0) / rc.total::numeric, 1)
        else 0
      end as pct
    from room_types_in_scope rtis
    cross join days d
    left join room_count rc on rc.room_type_id = rtis.room_type_id
    left join booked b
      on b.room_type_id = rtis.room_type_id
     and b.stay_date = d.stay_date
  ),
  occ_hotel as (
    select
      ot.stay_date,
      sum(ot.booked)::int as booked_total,
      sum(ot.total)::int as room_total,
      case
        when sum(ot.total) > 0 then round((sum(ot.booked)::numeric * 100.0) / sum(ot.total)::numeric, 1)
        else 0
      end as pct
    from occ_type ot
    group by ot.stay_date
  )
  select jsonb_build_object(
    'success', true,
    'start_date', p_start::text,
    'end_date', p_end::text,
    'days', coalesce(
      (select jsonb_agg(d.stay_date::text order by d.stay_date) from days d),
      '[]'::jsonb
    ),
    'room_types', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'type_id', rtj.room_type_id::text,
            'type_name', rtj.name_en,
            'type_code', rtj.code,
            'rooms', rtj.rooms_json
          )
          order by rtj.type_sort_order, rtj.name_en, rtj.room_type_id
        )
        from room_type_json rtj
      ),
      '[]'::jsonb
    ),
    'occupancy', jsonb_build_object(
      'per_room_type', coalesce(
        (
          select jsonb_object_agg(
            otx.room_type_id::text,
            otx.payload
          )
          from (
            select
              ot.room_type_id,
              jsonb_object_agg(
                ot.stay_date::text,
                jsonb_build_object(
                  'booked', ot.booked,
                  'total', ot.total,
                  'pct', ot.pct,
                  'tier',
                    case
                      when ot.pct < 30 then 'low'
                      when ot.pct < 60 then 'normal'
                      when ot.pct < 85 then 'high'
                      else 'peak'
                    end
                )
                order by ot.stay_date
              ) as payload
            from occ_type ot
            group by ot.room_type_id
          ) otx
        ),
        '{}'::jsonb
      ),
      'hotel_wide', coalesce(
        (
          select jsonb_object_agg(
            oh.stay_date::text,
            jsonb_build_object(
              'booked', oh.booked_total,
              'total', oh.room_total,
              'pct', oh.pct,
              'tier',
                case
                  when oh.pct < 30 then 'low'
                  when oh.pct < 60 then 'normal'
                  when oh.pct < 85 then 'high'
                  else 'peak'
                end
            )
            order by oh.stay_date
          )
          from occ_hotel oh
        ),
        '{}'::jsonb
      )
    )
  )
  into v_result;

  return v_result;
end;
$$;
