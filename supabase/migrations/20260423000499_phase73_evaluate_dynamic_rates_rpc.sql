-- ============================================================================
-- Phase 73 · Migration 004 — evaluate_dynamic_rates RPC
-- ============================================================================
-- Owner: Agent B
-- Reviewer: Lead (P1 — algorithm correctness is the highest-stakes gate)
-- Depends on: 001, 002, 003, init_core (rate_templates, rooms, reservation_nights)
--             Phase 72 Migration 001 (room_types.min_rate_floor)
--
-- LAYER 0 SKELETON — DO NOT APPLY UNTIL AGENT B FILLS BODY.
-- See WORK_ASSIGNMENT_PHASE73.md §5.4 + §8 (pseudocode) for reference.
--
-- Function signature:
--   public.evaluate_dynamic_rates(p_start DATE, p_end DATE) RETURNS JSONB
--   LANGUAGE plpgsql
--   SECURITY DEFINER
--   SET search_path = public, pg_temp                                 -- B20
--
-- Helper functions (same SECURITY DEFINER + search_path pattern):
--   - fn_round_price(p_price NUMERIC, p_mode TEXT) RETURNS NUMERIC
--   - fn_apply_action(p_base NUMERIC, p_action_type TEXT, p_action_value NUMERIC)
--   - fn_compute_group_occ(p_group_id UUID, p_stay_date DATE) RETURNS NUMERIC
--
-- Return JSONB shape (matches EvaluateResponse in dynamic-types.ts):
--   {
--     success: true,
--     eval_run_id: uuid,
--     stats: {
--       evaluated_dates, groups_fired, suggestions, applied,
--       no_op_count,           -- B22
--       clamped_floor, clamped_max
--     }
--   }
--
-- P1 invariants Lead will verify:
--   1. Idempotent re-run (B16): supersedes prior 'suggested' in range;
--      does NOT touch 'applied' or 'rejected'.
--   2. Direction asymmetry (B12): price-down rows NEVER auto-apply, even
--      when rule.mode='auto_apply'. They enter queue with
--      requires_confirmation=true AND direction_override=true.
--   3. Clamp order: max first, floor second (floor wins when both would fire).
--   4. No-op skip (B22): rows where suggested_price == base_price after
--      rounding+clamp are NOT inserted; stats.no_op_count++ instead.
--   5. Group conflict (B21): within same eval_run_id, higher-priority group
--      writes new row; lower-priority group's prior row in same eval marked
--      status='superseded', superseded_by=<winner id>.
--   6. SECURITY DEFINER with explicit search_path (B20). REVOKE from public
--      on helpers; GRANT EXECUTE on evaluate_dynamic_rates to authenticated
--      + service_role.
--   7. auto_apply path writes rate_templates; Phase 72 trigger auto-generates
--      ota_rate_sync_tasks — do NOT manually insert OTA tasks here.
--   8. applied_log row's affected_room_ids[] captured at apply time (not
--      re-computed on undo) so room reassignment doesn't break undo target.
-- ============================================================================

-- Agent B: implement full migration below this line.

create or replace function public.fn_round_price(p_price numeric, p_mode text)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  case coalesce(p_mode, 'nearest_10')
    when 'nearest_100' then
      return round(p_price / 100.0) * 100;
    when 'nearest_50' then
      return round(p_price / 50.0) * 50;
    when 'nearest_10' then
      return round(p_price / 10.0) * 10;
    else
      return round(p_price, 2);
  end case;
end;
$$;

create or replace function public.fn_apply_action(
  p_base numeric,
  p_action_type text,
  p_action_value numeric
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  case p_action_type
    when 'percent' then
      return round(p_base * (1 + (coalesce(p_action_value, 0) / 100.0)), 2);
    when 'fixed_thb' then
      return round(p_base + coalesce(p_action_value, 0), 2);
    when 'step' then
      return round(p_base + coalesce(p_action_value, 0), 2);
    when 'override' then
      return round(coalesce(p_action_value, p_base), 2);
    else
      return round(p_base, 2);
  end case;
end;
$$;

create or replace function public.fn_compute_group_occ(
  p_group_id uuid,
  p_stay_date date,
  p_room_type_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_scope text;
  v_total int := 0;
  v_booked int := 0;
begin
  select trigger_scope
    into v_scope
  from public.rate_rule_groups
  where id = p_group_id;

  if v_scope is null then
    return jsonb_build_object('booked', 0, 'total', 0, 'pct', 0);
  end if;

  with scope_rooms as (
    select r.id
    from public.rooms r
    where r.is_sellable = true
      and coalesce(r.is_dayuse, false) = false
      and (
        v_scope = 'hotel_wide'
        or (
          v_scope = 'group_aggregate'
          and exists (
            select 1
            from public.rate_rule_group_members gm
            where gm.group_id = p_group_id
              and gm.room_type_id = r.room_type_id
          )
        )
        or (
          v_scope = 'per_room_type'
          and p_room_type_id is not null
          and r.room_type_id = p_room_type_id
        )
      )
  )
  select
    count(*)::int,
    coalesce(count(rn.room_id), 0)::int
  into v_total, v_booked
  from scope_rooms sr
  left join public.reservation_nights rn
    on rn.room_id = sr.id
   and rn.stay_date = p_stay_date
   and rn.cancelled_at is null
  left join public.reservations res
    on res.id = rn.reservation_id
   and res.status not in ('cancelled', 'no_show');

  return jsonb_build_object(
    'booked', coalesce(v_booked, 0),
    'total', coalesce(v_total, 0),
    'pct', case
      when coalesce(v_total, 0) > 0 then round((coalesce(v_booked, 0)::numeric * 100.0) / v_total, 2)
      else 0
    end
  );
end;
$$;

create or replace function public.evaluate_dynamic_rates(p_start date, p_end date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_eval_run_id uuid := gen_random_uuid();
  v_day date;
  v_group record;
  v_member record;
  v_tier record;
  v_occ jsonb;
  v_base numeric(10, 2);
  v_raw_price numeric(10, 2);
  v_next_price numeric(10, 2);
  v_floor numeric(10, 2);
  v_max numeric(10, 2);
  v_direction text;
  v_requires_confirmation boolean;
  v_direction_override boolean;
  v_candidate_id uuid;
  v_now timestamptz;
  v_groups_fired int := 0;
  v_suggestions int := 0;
  v_applied int := 0;
  v_no_op_count int := 0;
  v_clamped_floor int := 0;
  v_clamped_max int := 0;
  v_evaluated_dates int := 0;
  v_group_counted boolean;
  v_room_ids uuid[];
  v_max_multiplier numeric := 1.5;
  v_undo_window_minutes int := 60;
  v_status text;
  v_existing_winner_id uuid;
  v_apply_row record;
begin
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'Invalid date range.';
  end if;

  select coalesce((value_json #>> '{}')::numeric, 1.5)
    into v_max_multiplier
  from public.app_settings
  where key = 'rate.dynamic_max_multiplier';

  select coalesce((value_json #>> '{}')::int, 60)
    into v_undo_window_minutes
  from public.app_settings
  where key = 'rate.dynamic_undo_window_minutes';

  update public.rate_dynamic_preview
     set status = 'superseded'
   where stay_date between p_start and p_end
     and status = 'suggested';

  drop table if exists tmp_dynamic_eval_candidates;

  create temporary table tmp_dynamic_eval_candidates (
    id uuid primary key,
    stay_date date not null,
    room_type_id bigint not null,
    base_price numeric(10, 2) not null,
    suggested_price numeric(10, 2) not null,
    direction text not null,
    requires_confirmation boolean not null default false,
    clamped_to_floor boolean not null default false,
    clamped_to_max boolean not null default false,
    direction_override boolean not null default false,
    applied_rule_group_id uuid not null,
    applied_tier_id uuid not null,
    candidate_status text not null check (candidate_status in ('suggested', 'applied', 'superseded')),
    superseded_by uuid,
    eval_run_id uuid not null,
    created_at timestamptz not null default timezone('utc', now()),
    affected_room_ids uuid[] not null
  ) on commit drop;

  for v_day in
    select generate_series(p_start, p_end, interval '1 day')::date
  loop
    v_evaluated_dates := v_evaluated_dates + 1;

    for v_group in
      select *
      from public.rate_rule_groups
      where is_active = true
        and (effective_from is null or effective_from <= v_day)
        and (effective_to is null or effective_to >= v_day)
        and (
          applies_to_dow is null
          or extract(dow from v_day)::int = any(applies_to_dow)
        )
      order by priority asc, created_at asc, id asc
    loop
      v_group_counted := false;

      if v_group.trigger_scope = 'per_room_type' then
        for v_member in
          select gm.*, rt.min_rate_floor
          from public.rate_rule_group_members gm
          join public.room_types rt on rt.id = gm.room_type_id
          where gm.group_id = v_group.id
          order by gm.room_type_id asc
        loop
          v_occ := public.fn_compute_group_occ(v_group.id, v_day, v_member.room_type_id);

          select t.*
            into v_tier
          from public.rate_rule_tiers t
          where t.group_id = v_group.id
            and (
              (t.trigger_metric = 'occ_percent' and coalesce((v_occ ->> 'pct')::numeric, 0) >= t.trigger_threshold)
              or
              (t.trigger_metric = 'occ_rooms_booked' and coalesce((v_occ ->> 'booked')::numeric, 0) >= t.trigger_threshold)
            )
          order by t.trigger_threshold desc, t.tier_order asc
          limit 1;

          if v_tier.id is null then
            continue;
          end if;

          if not v_group_counted then
            v_groups_fired := v_groups_fired + 1;
            v_group_counted := true;
          end if;

          select array_agg(r.id order by r.room_number asc, r.id asc)
            into v_room_ids
          from public.rooms r
          where r.room_type_id = v_member.room_type_id
            and r.is_sellable = true
            and coalesce(r.is_dayuse, false) = false;

          if coalesce(array_length(v_room_ids, 1), 0) = 0 then
            continue;
          end if;

          select min(rt.price)
            into v_base
          from public.rate_templates rt
          where rt.stay_date = v_day
            and rt.room_id = any(v_room_ids);

          if v_base is null then
            continue;
          end if;

          v_raw_price := public.fn_apply_action(v_base, v_member.action_type, v_member.action_value);
          if v_member.action_type <> 'step' then
            v_next_price := public.fn_round_price(v_raw_price, v_member.rounding);
          else
            v_next_price := round(v_raw_price, 2);
          end if;

          v_max := round(v_base * coalesce(v_max_multiplier, 1.5), 2);
          if v_next_price > v_max then
            v_next_price := public.fn_round_price(v_max, v_member.rounding);
            v_clamped_max := v_clamped_max + 1;
          end if;

          v_floor := v_member.min_rate_floor;
          if v_floor is not null and v_next_price < v_floor then
            v_next_price := round(v_floor, 2);
            v_clamped_floor := v_clamped_floor + 1;
          end if;

          v_direction := case
            when v_next_price > v_base then 'up'
            when v_next_price < v_base then 'down'
            else 'same'
          end;

          if v_direction = 'same' then
            v_no_op_count := v_no_op_count + 1;
            continue;
          end if;

          v_requires_confirmation := (v_direction = 'down');
          v_direction_override := (v_direction = 'down' and v_group.mode = 'auto_apply');
          v_status := case
            when v_group.mode = 'auto_apply' and v_direction = 'up' then 'applied'
            else 'suggested'
          end;

          v_candidate_id := gen_random_uuid();

          update tmp_dynamic_eval_candidates
             set candidate_status = 'superseded',
                 superseded_by = v_candidate_id
           where stay_date = v_day
             and room_type_id = v_member.room_type_id
             and superseded_by is null;

          insert into tmp_dynamic_eval_candidates (
            id,
            stay_date,
            room_type_id,
            base_price,
            suggested_price,
            direction,
            requires_confirmation,
            clamped_to_floor,
            clamped_to_max,
            direction_override,
            applied_rule_group_id,
            applied_tier_id,
            candidate_status,
            eval_run_id,
            affected_room_ids
          )
          values (
            v_candidate_id,
            v_day,
            v_member.room_type_id,
            round(v_base, 2),
            round(v_next_price, 2),
            v_direction,
            v_requires_confirmation,
            (v_floor is not null and v_next_price = round(v_floor, 2)),
            (v_next_price = public.fn_round_price(v_max, v_member.rounding) and round(v_base * coalesce(v_max_multiplier, 1.5), 2) < v_raw_price),
            v_direction_override,
            v_group.id,
            v_tier.id,
            v_status,
            v_eval_run_id,
            v_room_ids
          );
        end loop;
      else
        v_occ := public.fn_compute_group_occ(v_group.id, v_day, null);

        select t.*
          into v_tier
        from public.rate_rule_tiers t
        where t.group_id = v_group.id
          and (
            (t.trigger_metric = 'occ_percent' and coalesce((v_occ ->> 'pct')::numeric, 0) >= t.trigger_threshold)
            or
            (t.trigger_metric = 'occ_rooms_booked' and coalesce((v_occ ->> 'booked')::numeric, 0) >= t.trigger_threshold)
          )
        order by t.trigger_threshold desc, t.tier_order asc
        limit 1;

        if v_tier.id is null then
          continue;
        end if;

        v_groups_fired := v_groups_fired + 1;

        for v_member in
          select gm.*, rt.min_rate_floor
          from public.rate_rule_group_members gm
          join public.room_types rt on rt.id = gm.room_type_id
          where gm.group_id = v_group.id
          order by gm.room_type_id asc
        loop
          select array_agg(r.id order by r.room_number asc, r.id asc)
            into v_room_ids
          from public.rooms r
          where r.room_type_id = v_member.room_type_id
            and r.is_sellable = true
            and coalesce(r.is_dayuse, false) = false;

          if coalesce(array_length(v_room_ids, 1), 0) = 0 then
            continue;
          end if;

          select min(rt.price)
            into v_base
          from public.rate_templates rt
          where rt.stay_date = v_day
            and rt.room_id = any(v_room_ids);

          if v_base is null then
            continue;
          end if;

          v_raw_price := public.fn_apply_action(v_base, v_member.action_type, v_member.action_value);
          if v_member.action_type <> 'step' then
            v_next_price := public.fn_round_price(v_raw_price, v_member.rounding);
          else
            v_next_price := round(v_raw_price, 2);
          end if;

          v_max := round(v_base * coalesce(v_max_multiplier, 1.5), 2);
          if v_next_price > v_max then
            v_next_price := public.fn_round_price(v_max, v_member.rounding);
            v_clamped_max := v_clamped_max + 1;
          end if;

          v_floor := v_member.min_rate_floor;
          if v_floor is not null and v_next_price < v_floor then
            v_next_price := round(v_floor, 2);
            v_clamped_floor := v_clamped_floor + 1;
          end if;

          v_direction := case
            when v_next_price > v_base then 'up'
            when v_next_price < v_base then 'down'
            else 'same'
          end;

          if v_direction = 'same' then
            v_no_op_count := v_no_op_count + 1;
            continue;
          end if;

          v_requires_confirmation := (v_direction = 'down');
          v_direction_override := (v_direction = 'down' and v_group.mode = 'auto_apply');
          v_status := case
            when v_group.mode = 'auto_apply' and v_direction = 'up' then 'applied'
            else 'suggested'
          end;

          v_candidate_id := gen_random_uuid();

          update tmp_dynamic_eval_candidates
             set candidate_status = 'superseded',
                 superseded_by = v_candidate_id
           where stay_date = v_day
             and room_type_id = v_member.room_type_id
             and superseded_by is null;

          insert into tmp_dynamic_eval_candidates (
            id,
            stay_date,
            room_type_id,
            base_price,
            suggested_price,
            direction,
            requires_confirmation,
            clamped_to_floor,
            clamped_to_max,
            direction_override,
            applied_rule_group_id,
            applied_tier_id,
            candidate_status,
            eval_run_id,
            affected_room_ids
          )
          values (
            v_candidate_id,
            v_day,
            v_member.room_type_id,
            round(v_base, 2),
            round(v_next_price, 2),
            v_direction,
            v_requires_confirmation,
            (v_floor is not null and v_next_price = round(v_floor, 2)),
            (v_next_price = public.fn_round_price(v_max, v_member.rounding) and round(v_base * coalesce(v_max_multiplier, 1.5), 2) < v_raw_price),
            v_direction_override,
            v_group.id,
            v_tier.id,
            v_status,
            v_eval_run_id,
            v_room_ids
          );
        end loop;
      end if;
    end loop;
  end loop;

  insert into public.rate_dynamic_preview (
    id,
    stay_date,
    room_type_id,
    base_price,
    suggested_price,
    direction,
    requires_confirmation,
    clamped_to_floor,
    clamped_to_max,
    direction_override,
    applied_rule_group_id,
    applied_tier_id,
    status,
    eval_run_id,
    created_at,
    actioned_at,
    actioned_by,
    reject_reason
  )
  select
    c.id,
    c.stay_date,
    c.room_type_id,
    c.base_price,
    c.suggested_price,
    c.direction,
    c.requires_confirmation,
    c.clamped_to_floor,
    c.clamped_to_max,
    c.direction_override,
    c.applied_rule_group_id,
    c.applied_tier_id,
    case
      when c.superseded_by is not null then 'superseded'
      else c.candidate_status
    end,
    c.eval_run_id,
    c.created_at,
    case
      when c.superseded_by is null and c.candidate_status = 'applied' then timezone('utc', now())
      else null
    end,
    null,
    null
  from tmp_dynamic_eval_candidates c;

  update public.rate_dynamic_preview p
     set superseded_by = c.superseded_by
    from tmp_dynamic_eval_candidates c
   where p.id = c.id
     and c.superseded_by is not null;

  select
    count(*) filter (where superseded_by is null and candidate_status = 'suggested'),
    count(*) filter (where superseded_by is null and candidate_status = 'applied')
    into v_suggestions, v_applied
  from tmp_dynamic_eval_candidates;

  for v_apply_row in
    select *
    from tmp_dynamic_eval_candidates
    where superseded_by is null
      and candidate_status = 'applied'
    order by stay_date asc, room_type_id asc
  loop
    v_now := timezone('utc', now());

    insert into public.rate_templates (
      stay_date,
      room_id,
      price,
      updated_by,
      updated_at
    )
    select
      v_apply_row.stay_date,
      room_id,
      v_apply_row.suggested_price,
      null,
      v_now
    from unnest(v_apply_row.affected_room_ids) as room_id
    on conflict (stay_date, room_id)
    do update
      set price = excluded.price,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at;

    insert into public.rate_dynamic_applied_log (
      preview_id,
      stay_date,
      room_type_id,
      previous_price,
      new_price,
      applied_at,
      applied_by,
      apply_method,
      reversible_until,
      affected_room_ids
    )
    values (
      v_apply_row.id,
      v_apply_row.stay_date,
      v_apply_row.room_type_id,
      v_apply_row.base_price,
      v_apply_row.suggested_price,
      v_now,
      null,
      'auto',
      v_now + make_interval(mins => v_undo_window_minutes),
      v_apply_row.affected_room_ids
    );
  end loop;

  return jsonb_build_object(
    'success', true,
    'eval_run_id', v_eval_run_id,
    'stats', jsonb_build_object(
      'evaluated_dates', v_evaluated_dates,
      'groups_fired', v_groups_fired,
      'suggestions', coalesce(v_suggestions, 0),
      'applied', coalesce(v_applied, 0),
      'no_op_count', coalesce(v_no_op_count, 0),
      'clamped_floor', coalesce(v_clamped_floor, 0),
      'clamped_max', coalesce(v_clamped_max, 0)
    )
  );
end;
$$;

revoke execute on function public.fn_round_price(numeric, text) from public;
revoke execute on function public.fn_apply_action(numeric, text, numeric) from public;
revoke execute on function public.fn_compute_group_occ(uuid, date, bigint) from public;
revoke execute on function public.evaluate_dynamic_rates(date, date) from public;

grant execute on function public.fn_round_price(numeric, text) to service_role;
grant execute on function public.fn_apply_action(numeric, text, numeric) to service_role;
grant execute on function public.fn_compute_group_occ(uuid, date, bigint) to service_role;
grant execute on function public.evaluate_dynamic_rates(date, date) to authenticated, service_role;
