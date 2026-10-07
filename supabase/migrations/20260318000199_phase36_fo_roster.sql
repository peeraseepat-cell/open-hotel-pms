begin;

-- ============================================================
-- Phase 36: FO Shift Roster — roster_config + staff_shifts extensions
-- ============================================================

-- 1A: roster_config — FO-specific scheduling configuration per staff
create table if not exists public.roster_config (
  id                      uuid primary key default gen_random_uuid(),
  staff_id                uuid not null unique references public.staff(id) on delete cascade,
  regular_day_off         smallint not null check (regular_day_off between 0 and 6), -- 0=Sun..6=Sat
  shift_preference        text not null default 'rotate'
                            check (shift_preference in ('morning_fixed', 'rotate')),
  night_rotation_order    smallint check (night_rotation_order between 1 and 10),
  extra_day_offs_per_month smallint not null default 0 check (extra_day_offs_per_month >= 0),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

drop trigger if exists trg_roster_config_updated_at on public.roster_config;
create trigger trg_roster_config_updated_at
before update on public.roster_config
for each row execute function public.set_updated_at();

-- 1B: Add is_generated column to staff_shifts
alter table public.staff_shifts
  add column if not exists is_generated boolean not null default false;

-- 1C: DELETE policy on staff_shifts (admin/supervisor only)
drop policy if exists shifts_delete_admin_supervisor on public.staff_shifts;
create policy shifts_delete_admin_supervisor on public.staff_shifts
  for delete to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role in ('admin', 'supervisor')
    )
  );

-- 1D: RLS on roster_config
alter table public.roster_config enable row level security;

drop policy if exists roster_config_select_authenticated on public.roster_config;
create policy roster_config_select_authenticated on public.roster_config
  for select to authenticated
  using (true);

drop policy if exists roster_config_insert_admin_supervisor on public.roster_config;
create policy roster_config_insert_admin_supervisor on public.roster_config
  for insert to authenticated
  with check (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role in ('admin', 'supervisor')
    )
  );

drop policy if exists roster_config_update_admin_supervisor on public.roster_config;
create policy roster_config_update_admin_supervisor on public.roster_config
  for update to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role in ('admin', 'supervisor')
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role in ('admin', 'supervisor')
    )
  );

drop policy if exists roster_config_delete_admin_supervisor on public.roster_config;
create policy roster_config_delete_admin_supervisor on public.roster_config
  for delete to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role in ('admin', 'supervisor')
    )
  );

-- 1E: Indexes
create index if not exists idx_staff_shifts_generated
  on public.staff_shifts (shift_date, is_generated)
  where is_generated = true;

commit;
