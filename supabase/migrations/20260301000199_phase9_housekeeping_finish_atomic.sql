begin;

drop function if exists public.hk_finish_task_with_maintenance(
  uuid,
  text,
  text,
  jsonb,
  boolean,
  text,
  uuid[],
  text
);

create or replace function public.hk_finish_task_with_maintenance(
  p_task_id uuid,
  p_maid_name text default null,
  p_note text default null,
  p_checklist jsonb default null,
  p_auto_approve boolean default false,
  p_approved_by text default null,
  p_maintenance_assignment_ids uuid[] default null,
  p_maintenance_note text default null
)
returns table (
  task_id uuid,
  duration_ms bigint,
  final_status text,
  auto_approved boolean,
  maintenance_completed_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.housekeeping_tasks%rowtype;
  v_now timestamptz := timezone('utc', now());
  v_final_ms bigint := 0;
  v_final_min integer := 0;
  v_should_auto_approve boolean := false;
  v_final_status text := 'cleaned';
  v_normalized_maid text := nullif(trim(coalesce(p_maid_name, '')), '');
  v_normalized_approve_by text := nullif(trim(coalesce(p_approved_by, '')), '');
  v_normalized_maintenance_note text := nullif(trim(coalesce(p_maintenance_note, '')), '');
  v_target_assignment_ids uuid[] := '{}'::uuid[];
  v_completed_count integer := 0;
begin
  if p_task_id is null then
    raise exception 'p_task_id is required';
  end if;

  select *
  into v_task
  from public.housekeeping_tasks
  where id = p_task_id
  for update;

  if not found then
    raise exception 'Task not found';
  end if;

  if v_task.status not in ('in_progress', 'paused') then
    raise exception 'Task must be in_progress or paused to finish (current: %)', v_task.status;
  end if;

  if v_task.status = 'in_progress' then
    if v_task.started_at is null then
      raise exception 'Data inconsistency: in_progress task has no started_at';
    end if;

    v_final_ms := coalesce(v_task.accumulated_ms, 0)
      + greatest(extract(epoch from (v_now - v_task.started_at)) * 1000, 0)::bigint;
  else
    v_final_ms := coalesce(v_task.accumulated_ms, 0);
  end if;

  v_final_min := greatest(1, round(v_final_ms::numeric / 60000)::integer);

  update public.housekeeping_tasks
  set
    status = 'cleaned',
    finished_at = v_now,
    accumulated_ms = v_final_ms,
    started_at = null,
    checklist_snapshot = p_checklist
  where id = p_task_id;

  insert into public.housekeeping_logs (task_id, status, note, checklist)
  values (
    p_task_id,
    'cleaned',
    coalesce(
      nullif(trim(coalesce(p_note, '')), ''),
      format('finished by %s, duration: %s min', coalesce(v_normalized_maid, 'unknown'), v_final_min)
    ),
    p_checklist
  );

  if p_maintenance_assignment_ids is null or coalesce(array_length(p_maintenance_assignment_ids, 1), 0) = 0 then
    select coalesce(array_agg(ma.id), '{}'::uuid[])
    into v_target_assignment_ids
    from public.maintenance_assignments ma
    where ma.room_id = v_task.room_id
      and ma.assigned_date = v_task.stay_date
      and ma.status = 'pending';
  else
    select coalesce(array_agg(ma.id), '{}'::uuid[])
    into v_target_assignment_ids
    from public.maintenance_assignments ma
    where ma.id = any(p_maintenance_assignment_ids)
      and ma.room_id = v_task.room_id
      and ma.assigned_date = v_task.stay_date
      and ma.status = 'pending';
  end if;

  if coalesce(array_length(v_target_assignment_ids, 1), 0) > 0 then
    with completed as (
      update public.maintenance_assignments ma
      set
        status = 'completed',
        completed_at = v_now,
        notes = coalesce(v_normalized_maintenance_note, ma.notes)
      where ma.id = any(v_target_assignment_ids)
        and ma.status = 'pending'
      returning ma.task_id
    )
    insert into public.maintenance_logs (room_id, task_id, performed_at, performed_by, notes)
    select
      v_task.room_id,
      c.task_id,
      v_now,
      v_normalized_maid,
      coalesce(v_normalized_maintenance_note, format('Completed with housekeeping task %s', p_task_id::text))
    from completed c;

    get diagnostics v_completed_count = row_count;
  end if;

  v_should_auto_approve := coalesce(p_auto_approve, false) or coalesce(v_task.is_no_service, false);
  if v_should_auto_approve then
    update public.housekeeping_tasks
    set
      status = 'approved',
      approved_at = v_now
    where id = p_task_id;

    insert into public.housekeeping_logs (task_id, status, note)
    values (
      p_task_id,
      'approved',
      format(
        'approved by %s%s',
        coalesce(v_normalized_approve_by, coalesce(v_normalized_maid, 'system')),
        case when coalesce(v_task.is_no_service, false) then ' (no service auto-approve)' else '' end
      )
    );

    v_final_status := 'approved';
  end if;

  return query
  select
    p_task_id,
    v_final_ms,
    v_final_status,
    v_should_auto_approve,
    v_completed_count;
end;
$$;

grant execute on function public.hk_finish_task_with_maintenance(
  uuid,
  text,
  text,
  jsonb,
  boolean,
  text,
  uuid[],
  text
) to anon, authenticated;

commit;
