-- ============================================================================
-- Phase 72 · Migration 003 — Rate Template → OTA Sync Trigger
-- ============================================================================
-- Owner: Agent B
-- Reviewer: Lead (P1 — idempotence + supersede correctness)
-- Depends on: 001, 002
--
-- LAYER 0 SKELETON — DO NOT APPLY UNTIL AGENT B FILLS BODY.
-- Agent B creates: fn_rate_template_ota_sync() + AFTER INSERT/UPDATE trigger.
-- See WORK_ASSIGNMENT_PHASE72.md §5.3 for reference implementation.
--
-- P1 invariants Lead will verify:
--   1. Re-running same UPDATE (price unchanged) MUST NOT insert a new task.
--   2. Prior pending tasks for (channel, room_type, stay_date) MUST be
--      marked 'superseded' with superseded_by FK pointing to the new task.
--   3. Trigger must cover ALL active manual channels (loop over
--      ota_channels WHERE is_active AND sync_method='manual').
-- ============================================================================

-- Agent B: implement full migration below this line.

create or replace function public.fn_rate_template_ota_sync()
returns trigger
language plpgsql
as $$
declare
  v_type_id bigint;
  v_channel record;
  v_old_price numeric(10, 2);
  v_calc numeric(10, 2);
  v_new_task_id uuid;
  v_same_pending_id uuid;
  v_matching_synced_id uuid;
  v_pending_ids uuid[];
begin
  select r.room_type_id
    into v_type_id
  from public.rooms r
  where r.id = new.room_id;

  if v_type_id is null then
    return new;
  end if;

  v_old_price := case when tg_op = 'UPDATE' then old.price else null end;

  if tg_op = 'UPDATE' and v_old_price is not distinct from new.price then
    return new;
  end if;

  for v_channel in
    select code, markup_type, markup_value
    from public.ota_channels
    where is_active = true
      and sync_method = 'manual'
  loop
    v_calc := round(
      case v_channel.markup_type
        when 'percent' then new.price * (1 + (v_channel.markup_value / 100.0))
        when 'fixed' then new.price + v_channel.markup_value
        else new.price
      end,
      2
    );

    select t.id
      into v_same_pending_id
    from public.ota_rate_sync_tasks t
    where t.channel_code = v_channel.code
      and t.room_type_id = v_type_id
      and t.stay_date = new.stay_date
      and t.status = 'pending'
      and t.new_price is not distinct from new.price
      and t.calculated_ota_price is not distinct from v_calc
    order by t.created_at desc
    limit 1;

    if v_same_pending_id is not null then
      continue;
    end if;

    select array_agg(t.id order by t.created_at)
      into v_pending_ids
    from public.ota_rate_sync_tasks t
    where t.channel_code = v_channel.code
      and t.room_type_id = v_type_id
      and t.stay_date = new.stay_date
      and t.status = 'pending';

    select t.id
      into v_matching_synced_id
    from public.ota_rate_sync_tasks t
    where t.channel_code = v_channel.code
      and t.room_type_id = v_type_id
      and t.stay_date = new.stay_date
      and t.status = 'synced'
      and t.new_price is not distinct from new.price
      and t.calculated_ota_price is not distinct from v_calc
    order by t.acked_at desc nulls last, t.created_at desc
    limit 1;

    if v_matching_synced_id is not null then
      if coalesce(array_length(v_pending_ids, 1), 0) > 0 then
        update public.ota_rate_sync_tasks
           set status = 'superseded',
               superseded_by = v_matching_synced_id
         where id = any(v_pending_ids);
      end if;
      continue;
    end if;

    insert into public.ota_rate_sync_tasks (
      channel_code,
      room_type_id,
      stay_date,
      old_price,
      new_price,
      calculated_ota_price,
      markup_snapshot,
      status,
      reason,
      created_by
    )
    values (
      v_channel.code,
      v_type_id,
      new.stay_date,
      v_old_price,
      new.price,
      v_calc,
      jsonb_build_object('type', v_channel.markup_type, 'value', v_channel.markup_value),
      'pending',
      case when tg_op = 'INSERT' then 'initial' else 'update' end,
      new.updated_by
    )
    returning id into v_new_task_id;

    if coalesce(array_length(v_pending_ids, 1), 0) > 0 then
      update public.ota_rate_sync_tasks
         set status = 'superseded',
             superseded_by = v_new_task_id
       where id = any(v_pending_ids);
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_rate_template_ota_sync on public.rate_templates;

create trigger trg_rate_template_ota_sync
  after insert or update of price
  on public.rate_templates
  for each row
  execute function public.fn_rate_template_ota_sync();
