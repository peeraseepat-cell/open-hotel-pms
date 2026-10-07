begin;

create extension if not exists "pgcrypto";

-- ============================================================
-- Phase 12A: Staff Directory Foundation (Layer 1)
-- Scope:
--   1) departments (+ seed)
--   2) staff (1:1 extension of profiles.user_id)
--   3) line_binding_tokens
--   4) idempotent backfill profiles -> staff
--   5) baseline RLS
-- ============================================================

-- ------------------------------------------------------------
-- 1) departments
-- ------------------------------------------------------------
create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  line_group_id text,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_departments_is_active
  on public.departments (is_active);

drop trigger if exists trg_departments_updated_at on public.departments;
create trigger trg_departments_updated_at
before update on public.departments
for each row execute function public.set_updated_at();

insert into public.departments (code, name)
values
  ('FO', 'Front Office'),
  ('HK', 'Housekeeping'),
  ('MNT', 'Maintenance'),
  ('FB', 'Food & Beverage'),
  ('SEC', 'Security')
on conflict (code) do nothing;

-- ------------------------------------------------------------
-- 2) staff (profiles extension)
-- ------------------------------------------------------------
create table if not exists public.staff (
  id uuid primary key references public.profiles(user_id) on delete cascade,
  employee_code text unique not null,
  display_name text not null,
  nickname text,
  department_id uuid references public.departments(id) on delete set null,
  is_active boolean not null default true,
  line_user_id text unique,
  line_display_name text,
  line_picture_url text,
  line_bound_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_staff_department
  on public.staff (department_id);

create index if not exists idx_staff_is_active
  on public.staff (is_active);

create index if not exists idx_staff_display_name
  on public.staff (display_name);

drop trigger if exists trg_staff_updated_at on public.staff;
create trigger trg_staff_updated_at
before update on public.staff
for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- 3) line_binding_tokens
-- ------------------------------------------------------------
create table if not exists public.line_binding_tokens (
  token text primary key,
  staff_id uuid not null references public.staff(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_line_binding_tokens_staff_expires
  on public.line_binding_tokens (staff_id, expires_at desc);

create index if not exists idx_line_binding_tokens_open
  on public.line_binding_tokens (staff_id, used_at, expires_at);

-- ------------------------------------------------------------
-- 4) idempotent backfill (profiles -> staff)
-- Role lock in Phase 12A: admin | frontdesk | maid | supervisor
-- ------------------------------------------------------------
insert into public.staff (
  id,
  display_name,
  employee_code,
  department_id,
  is_active,
  created_at,
  updated_at
)
select
  p.user_id,
  coalesce(nullif(trim(p.full_name), ''), 'Unknown'),
  'TMP-' || upper(substr(p.user_id::text, 1, 8)),
  d.id,
  true,
  timezone('utc', now()),
  timezone('utc', now())
from public.profiles p
left join public.departments d
  on d.code = case
    when p.role = 'frontdesk' then 'FO'
    when p.role = 'maid' then 'HK'
    when p.role = 'supervisor' then 'FO'
    when p.role = 'admin' then 'FO'
    else 'FO'
  end
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- 5) baseline RLS
-- Intentionally no DELETE policies in Phase 12A:
--   - staff uses soft-delete via is_active=false
--   - line_binding_tokens uses used_at lifecycle instead of hard delete
-- ------------------------------------------------------------
alter table public.departments enable row level security;
alter table public.staff enable row level security;
alter table public.line_binding_tokens enable row level security;

drop policy if exists departments_select_authenticated on public.departments;
create policy departments_select_authenticated on public.departments
for select to authenticated
using (is_active = true);

drop policy if exists departments_write_admin_supervisor on public.departments;
create policy departments_write_admin_supervisor on public.departments
for all to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  )
);

drop policy if exists staff_select_self_or_admin_supervisor on public.staff;
create policy staff_select_self_or_admin_supervisor on public.staff
for select to authenticated
using (
  id = auth.uid()
  or exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  )
);

drop policy if exists staff_write_admin_supervisor on public.staff;
create policy staff_write_admin_supervisor on public.staff
for all to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  )
);

drop policy if exists line_binding_tokens_select_self_or_admin_supervisor on public.line_binding_tokens;
create policy line_binding_tokens_select_self_or_admin_supervisor on public.line_binding_tokens
for select to authenticated
using (
  staff_id = auth.uid()
  or exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  )
);

drop policy if exists line_binding_tokens_insert_self_or_admin_supervisor on public.line_binding_tokens;
create policy line_binding_tokens_insert_self_or_admin_supervisor on public.line_binding_tokens
for insert to authenticated
with check (
  staff_id = auth.uid()
  or exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  )
);

drop policy if exists line_binding_tokens_update_self_or_admin_supervisor on public.line_binding_tokens;
create policy line_binding_tokens_update_self_or_admin_supervisor on public.line_binding_tokens
for update to authenticated
using (
  staff_id = auth.uid()
  or exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  )
)
with check (
  staff_id = auth.uid()
  or exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  )
);

commit;
