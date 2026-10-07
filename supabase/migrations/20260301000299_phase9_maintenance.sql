begin;

create extension if not exists "pgcrypto";

-- ============================================================
-- Phase 9: Maintenance Hub schema
-- ============================================================

create table if not exists public.maintenance_tasks (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  threshold_count int not null check (threshold_count > 0),
  warning_count int check (warning_count is null or warning_count > 0),
  applicable_room_types text[] check (
    applicable_room_types is null
    or array_length(applicable_room_types, 1) is null
    or applicable_room_types <@ array['TS','DS','DQ','DT','JS','TB','FR']::text[]
  ),
  sync_to_housekeeper boolean not null default false,
  checklist_items text[],
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.maintenance_logs (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  task_id uuid not null references public.maintenance_tasks(id) on delete cascade,
  performed_at timestamptz not null default timezone('utc', now()),
  performed_by text,
  stay_count_at_time int not null default 0,
  notes text
);

create table if not exists public.maintenance_notes (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  task_id uuid not null references public.maintenance_tasks(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default timezone('utc', now()),
  is_resolved boolean not null default false,
  resolved_at timestamptz
);

create table if not exists public.maintenance_task_times (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.maintenance_tasks(id) on delete cascade,
  room_type_code text not null check (room_type_code in ('TS','DS','DQ','DT','JS','TB','FR')),
  estimated_minutes int not null default 30 check (estimated_minutes > 0),
  created_at timestamptz not null default timezone('utc', now()),
  unique (task_id, room_type_code)
);

create table if not exists public.maintenance_assignments (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  task_id uuid not null references public.maintenance_tasks(id) on delete cascade,
  assigned_at timestamptz not null default timezone('utc', now()),
  assigned_by text,
  assigned_date date not null default current_date,
  status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled')),
  completed_at timestamptz,
  notes text
);

-- ============================================================
-- Indexes
-- ============================================================

create index if not exists idx_maintenance_logs_room_task_performed_at
  on public.maintenance_logs (room_id, task_id, performed_at desc);

create index if not exists idx_maintenance_notes_active_by_room
  on public.maintenance_notes (room_id)
  where is_resolved = false;

create index if not exists idx_maintenance_assignments_room_date_status
  on public.maintenance_assignments (room_id, assigned_date, status);

-- ============================================================
-- RLS + allow-all policies (project currently no auth restrictions)
-- ============================================================

alter table public.maintenance_tasks enable row level security;
alter table public.maintenance_logs enable row level security;
alter table public.maintenance_notes enable row level security;
alter table public.maintenance_task_times enable row level security;
alter table public.maintenance_assignments enable row level security;

drop policy if exists maintenance_tasks_allow_all on public.maintenance_tasks;
create policy maintenance_tasks_allow_all
  on public.maintenance_tasks
  for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists maintenance_logs_allow_all on public.maintenance_logs;
create policy maintenance_logs_allow_all
  on public.maintenance_logs
  for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists maintenance_notes_allow_all on public.maintenance_notes;
create policy maintenance_notes_allow_all
  on public.maintenance_notes
  for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists maintenance_task_times_allow_all on public.maintenance_task_times;
create policy maintenance_task_times_allow_all
  on public.maintenance_task_times
  for all to anon, authenticated
  using (true)
  with check (true);

drop policy if exists maintenance_assignments_allow_all on public.maintenance_assignments;
create policy maintenance_assignments_allow_all
  on public.maintenance_assignments
  for all to anon, authenticated
  using (true)
  with check (true);

-- ============================================================
-- Trigger: auto-calculate stay_count_at_time from housekeeping_tasks approved
-- ============================================================

create or replace function public.calculate_stay_count_on_insert()
returns trigger
language plpgsql
as $$
begin
  select coalesce(count(*), 0)
  into new.stay_count_at_time
  from public.housekeeping_tasks ht
  where ht.room_id = new.room_id
    and ht.status = 'approved';

  return new;
end;
$$;

drop trigger if exists trigger_calculate_stay_count on public.maintenance_logs;
create trigger trigger_calculate_stay_count
before insert on public.maintenance_logs
for each row execute function public.calculate_stay_count_on_insert();

-- ============================================================
-- RPC 1: get_room_maintenance_status()
-- ============================================================

drop function if exists public.get_room_maintenance_status();

create or replace function public.get_room_maintenance_status()
returns table (
  room_id uuid,
  room_number text,
  room_type_code text,
  task_id uuid,
  task_name text,
  threshold_count int,
  warning_count int,
  applicable_room_types text[],
  total_stays bigint,
  last_stay_at timestamptz,
  last_done_at timestamptz,
  last_done_at_stay int,
  stays_since_last bigint,
  status text
)
language sql
stable
as $$
  with room_stays as (
    select
      ht.room_id,
      count(*)::bigint as stay_count,
      max(ht.approved_at) as last_stay_at
    from public.housekeeping_tasks ht
    where ht.status = 'approved'
    group by ht.room_id
  ),
  last_maintenance as (
    select distinct on (ml.room_id, ml.task_id)
      ml.room_id,
      ml.task_id,
      ml.performed_at,
      ml.stay_count_at_time
    from public.maintenance_logs ml
    order by ml.room_id, ml.task_id, ml.performed_at desc
  )
  select
    r.id as room_id,
    r.room_number,
    rt.code as room_type_code,
    t.id as task_id,
    t.name as task_name,
    t.threshold_count,
    t.warning_count,
    t.applicable_room_types,
    coalesce(rs.stay_count, 0) as total_stays,
    rs.last_stay_at,
    lm.performed_at as last_done_at,
    coalesce(lm.stay_count_at_time, 0) as last_done_at_stay,
    greatest(coalesce(rs.stay_count, 0) - coalesce(lm.stay_count_at_time, 0), 0) as stays_since_last,
    case
      when greatest(coalesce(rs.stay_count, 0) - coalesce(lm.stay_count_at_time, 0), 0) >= t.threshold_count then 'OVERDUE'
      when t.warning_count is not null
        and greatest(coalesce(rs.stay_count, 0) - coalesce(lm.stay_count_at_time, 0), 0) >= t.warning_count then 'WARNING'
      else 'OK'
    end as status
  from public.rooms r
  join public.room_types rt on rt.id = r.room_type_id
  cross join public.maintenance_tasks t
  left join room_stays rs on rs.room_id = r.id
  left join last_maintenance lm on lm.room_id = r.id and lm.task_id = t.id
  where r.is_visible_on_board = true
    and t.is_active = true
    and (
      t.applicable_room_types is null
      or array_length(t.applicable_room_types, 1) is null
      or rt.code = any(t.applicable_room_types)
    )
  order by r.room_number, t.name;
$$;

-- ============================================================
-- RPC 2: get_maintenance_for_rooms(p_room_ids UUID[])
-- ============================================================

drop function if exists public.get_maintenance_for_rooms(uuid[]);

create or replace function public.get_maintenance_for_rooms(p_room_ids uuid[])
returns table (
  room_id uuid,
  task_id uuid,
  task_name text,
  checklist_items text[],
  estimated_minutes int,
  stays_since_last bigint,
  threshold_count int,
  status text
)
language sql
stable
as $$
  select
    rms.room_id,
    rms.task_id,
    rms.task_name,
    mt.checklist_items,
    coalesce(mtt.estimated_minutes, 30) as estimated_minutes,
    rms.stays_since_last,
    rms.threshold_count,
    rms.status
  from public.get_room_maintenance_status() rms
  join public.maintenance_tasks mt on mt.id = rms.task_id
  left join public.maintenance_task_times mtt
    on mtt.task_id = rms.task_id
   and mtt.room_type_code = rms.room_type_code
  where rms.room_id = any(p_room_ids)
    and rms.status = 'OVERDUE'
    and mt.sync_to_housekeeper = true;
$$;

-- ============================================================
-- RPC 3: get_todays_maintenance_assignments(p_target_date DATE)
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

grant execute on function public.get_room_maintenance_status() to anon, authenticated;
grant execute on function public.get_maintenance_for_rooms(uuid[]) to anon, authenticated;
grant execute on function public.get_todays_maintenance_assignments(date) to anon, authenticated;

-- ============================================================
-- Seed default maintenance tasks
-- ============================================================

insert into public.maintenance_tasks (
  name,
  description,
  threshold_count,
  warning_count,
  applicable_room_types,
  sync_to_housekeeper,
  checklist_items,
  is_active
)
values
  ('ล้างแอร์', 'ล้างแอร์ทำความสะอาด', 200, 150, null, false, null, true),
  ('ราดน้ำยาท่อน้ำ', 'ราดน้ำยาป้องกันท่อตัน', 5, null, null, false, null, true),
  ('Deep Clean เบื้องต้น', 'ทำความสะอาดขั้นพื้นฐาน', 10, null, null, false, null, true),
  ('Deep Clean แบบละเอียด', 'ทำความสะอาดอย่างละเอียด', 30, 25, null, false, null, true),
  ('ซักผ้าม่าน', 'ซักผ้าม่านประจำ', 50, 40, null, false, null, true)
on conflict (name) do update set
  description = excluded.description,
  threshold_count = excluded.threshold_count,
  warning_count = excluded.warning_count,
  applicable_room_types = excluded.applicable_room_types,
  sync_to_housekeeper = excluded.sync_to_housekeeper,
  checklist_items = excluded.checklist_items,
  is_active = excluded.is_active;

commit;
