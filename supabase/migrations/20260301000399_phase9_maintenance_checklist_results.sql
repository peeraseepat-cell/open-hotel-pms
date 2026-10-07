begin;

create extension if not exists "pgcrypto";

-- ============================================================
-- Phase 9.1: Maintenance checklist result audit (per assignment)
-- ============================================================

create table if not exists public.maintenance_assignment_checklist_results (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.maintenance_assignments(id) on delete cascade,
  item_index int not null check (item_index > 0),
  item_name text not null,
  is_checked boolean not null default false,
  checked_at timestamptz,
  checked_by text,
  note text,
  created_at timestamptz not null default timezone('utc', now()),
  unique (assignment_id, item_index)
);

create index if not exists idx_maintenance_assignment_checklists_assignment
  on public.maintenance_assignment_checklist_results (assignment_id);

alter table public.maintenance_assignment_checklist_results enable row level security;

drop policy if exists maintenance_assignment_checklists_allow_all on public.maintenance_assignment_checklist_results;
create policy maintenance_assignment_checklists_allow_all
  on public.maintenance_assignment_checklist_results
  for all to anon, authenticated
  using (true)
  with check (true);

-- ============================================================
-- Extend RPC get_todays_maintenance_assignments with sync flag
-- ============================================================

drop function if exists public.get_todays_maintenance_assignments(date);

create or replace function public.get_todays_maintenance_assignments(p_target_date date default current_date)
returns table (
  assignment_id uuid,
  room_id uuid,
  room_number text,
  room_type_code text,
  task_id uuid,
  task_name text,
  sync_to_housekeeper boolean,
  checklist_items text[],
  estimated_minutes int,
  status text,
  assigned_by text,
  assigned_at timestamptz,
  notes text
)
language sql
stable
as $$
  select
    ma.id as assignment_id,
    ma.room_id,
    r.room_number,
    rt.code as room_type_code,
    ma.task_id,
    mt.name as task_name,
    mt.sync_to_housekeeper,
    mt.checklist_items,
    coalesce(mtt.estimated_minutes, 30) as estimated_minutes,
    ma.status,
    ma.assigned_by,
    ma.assigned_at,
    ma.notes
  from public.maintenance_assignments ma
  join public.rooms r on r.id = ma.room_id
  join public.room_types rt on rt.id = r.room_type_id
  join public.maintenance_tasks mt on mt.id = ma.task_id
  left join public.maintenance_task_times mtt
    on mtt.task_id = ma.task_id
   and mtt.room_type_code = rt.code
  where ma.assigned_date = coalesce(p_target_date, current_date)
    and ma.status = 'pending'
  order by ma.assigned_at asc;
$$;

grant execute on function public.get_todays_maintenance_assignments(date) to anon, authenticated;

-- ============================================================
-- Atomic finish: validate + persist maintenance checklists
-- ============================================================

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

drop function if exists public.hk_finish_task_with_maintenance(
  uuid,
  text,
  text,
  jsonb,
  boolean,
  text,
  uuid[],
  text,
  jsonb
);

create or replace function public.hk_finish_task_with_maintenance(
  p_task_id uuid,
  p_maid_name text default null,
  p_note text default null,
  p_checklist jsonb default null,
  p_auto_approve boolean default false,
  p_approved_by text default null,
  p_maintenance_assignment_ids uuid[] default null,
  p_maintenance_note text default null,
  p_maintenance_checklist jsonb default null
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
  v_assignment record;
  v_required_item text;
  v_payload_entry jsonb;
  v_item_checked boolean;
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
    -- Validate and persist per-assignment checklist results before closing assignments.
    for v_assignment in
      select
        ma.id as assignment_id,
        ma.task_id,
        mt.sync_to_housekeeper,
        mt.checklist_items
      from public.maintenance_assignments ma
      join public.maintenance_tasks mt on mt.id = ma.task_id
      where ma.id = any(v_target_assignment_ids)
    loop
      v_payload_entry := null;

      if p_maintenance_checklist is not null then
        select entry
        into v_payload_entry
        from jsonb_array_elements(p_maintenance_checklist) as entry
        where nullif(entry->>'assignment_id', '') is not null
          and (entry->>'assignment_id')::uuid = v_assignment.assignment_id
        limit 1;
      end if;

      if coalesce(v_assignment.sync_to_housekeeper, false)
         and coalesce(array_length(v_assignment.checklist_items, 1), 0) > 0 then
        if v_payload_entry is null then
          raise exception 'Missing maintenance checklist for assignment %', v_assignment.assignment_id;
        end if;

        foreach v_required_item in array v_assignment.checklist_items
        loop
          select exists (
            select 1
            from jsonb_array_elements(coalesce(v_payload_entry->'items', '[]'::jsonb)) as it
            where lower(trim(coalesce(it->>'item', ''))) = lower(trim(v_required_item))
              and lower(coalesce(it->>'checked', 'false')) in ('true', 't', '1', 'yes', 'y')
          )
          into v_item_checked;

          if not coalesce(v_item_checked, false) then
            raise exception
              'Maintenance checklist incomplete for assignment % item %',
              v_assignment.assignment_id,
              v_required_item;
          end if;
        end loop;
      end if;

      if v_payload_entry is not null then
        insert into public.maintenance_assignment_checklist_results (
          assignment_id,
          item_index,
          item_name,
          is_checked,
          checked_at,
          checked_by,
          note
        )
        select
          v_assignment.assignment_id,
          item_ordinality::int,
          trim(coalesce(item_value->>'item', '')) as item_name,
          case
            when lower(coalesce(item_value->>'checked', 'false')) in ('true', 't', '1', 'yes', 'y') then true
            else false
          end as is_checked,
          case
            when lower(coalesce(item_value->>'checked', 'false')) in ('true', 't', '1', 'yes', 'y') then v_now
            else null
          end as checked_at,
          case
            when lower(coalesce(item_value->>'checked', 'false')) in ('true', 't', '1', 'yes', 'y') then v_normalized_maid
            else null
          end as checked_by,
          nullif(trim(coalesce(item_value->>'note', '')), '') as note
        from jsonb_array_elements(coalesce(v_payload_entry->'items', '[]'::jsonb)) with ordinality as i(item_value, item_ordinality)
        where nullif(trim(coalesce(item_value->>'item', '')), '') is not null
        on conflict (assignment_id, item_index)
        do update set
          item_name = excluded.item_name,
          is_checked = excluded.is_checked,
          checked_at = excluded.checked_at,
          checked_by = excluded.checked_by,
          note = excluded.note;
      end if;
    end loop;

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
  text,
  jsonb
) to anon, authenticated;

commit;
