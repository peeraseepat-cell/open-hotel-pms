begin;

-- ============================================================
-- Phase 12B: Staff Shifts foundation for roster + LINE bind flow
-- ============================================================

create table if not exists public.staff_shifts (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff(id) on delete cascade,
  shift_date date not null,
  shift_type text not null
    check (shift_type in ('morning', 'afternoon', 'night', 'off')),
  started_at timestamptz,
  ended_at timestamptz,
  is_on_duty boolean generated always as (
    started_at is not null and ended_at is null
  ) stored,
  created_at timestamptz not null default timezone('utc', now()),
  unique (staff_id, shift_date, shift_type),
  constraint chk_staff_shifts_clock_order
    check (ended_at is null or started_at is null or ended_at >= started_at)
);

create index if not exists idx_staff_shifts_date
  on public.staff_shifts (shift_date, staff_id);

create index if not exists idx_staff_shifts_on_duty
  on public.staff_shifts (is_on_duty)
  where is_on_duty = true;

alter table public.staff_shifts enable row level security;

drop policy if exists shifts_select_authenticated on public.staff_shifts;
create policy shifts_select_authenticated on public.staff_shifts
for select to authenticated
using (true);

drop policy if exists shifts_insert_admin_supervisor on public.staff_shifts;
create policy shifts_insert_admin_supervisor on public.staff_shifts
for insert to authenticated
with check (
  exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  )
);

drop policy if exists shifts_update_admin_supervisor on public.staff_shifts;
create policy shifts_update_admin_supervisor on public.staff_shifts
for update to authenticated
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

-- Intentionally no DELETE policy (history should be preserved).

commit;
