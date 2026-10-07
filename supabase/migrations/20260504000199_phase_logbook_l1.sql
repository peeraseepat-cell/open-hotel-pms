begin;

-- ============================================================
-- Phase Logbook L1 -- time window + close + shared shift log
-- ============================================================

alter table public.logbook_notes
  add column if not exists start_at timestamptz,
  add column if not exists end_at timestamptz,
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by uuid references public.staff(id) on delete set null;

update public.logbook_notes
set start_at = created_at,
    end_at = (date_trunc('day', created_at at time zone 'Asia/Bangkok')
              + interval '8 days' - interval '1 second')
              at time zone 'Asia/Bangkok'
where start_at is null;

alter table public.logbook_notes
  alter column start_at set not null,
  alter column start_at set default timezone('utc', now());

create index if not exists idx_logbook_notes_start_at
  on public.logbook_notes (start_at);

create index if not exists idx_logbook_notes_end_at
  on public.logbook_notes (end_at);

create index if not exists idx_logbook_notes_active_window
  on public.logbook_notes (start_at, end_at)
  where archived_at is null and closed_at is null;

create index if not exists idx_logbook_notes_closed_at
  on public.logbook_notes (closed_at);

create table if not exists public.shift_log_entries (
  id uuid primary key default gen_random_uuid(),
  log_date date not null,
  hour_slot int not null check (hour_slot between 0 and 23),
  body text not null default '',
  body_rich jsonb,
  created_by uuid not null references public.staff(id) on delete restrict,
  updated_by uuid references public.staff(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (log_date, hour_slot)
);

create index if not exists idx_shift_log_entries_log_date
  on public.shift_log_entries (log_date desc);

drop trigger if exists trg_shift_log_entries_updated_at on public.shift_log_entries;
create trigger trg_shift_log_entries_updated_at
before update on public.shift_log_entries
for each row execute function public.set_updated_at();

alter table public.shift_log_entries enable row level security;

drop policy if exists shift_log_entries_select_authenticated on public.shift_log_entries;
create policy shift_log_entries_select_authenticated
on public.shift_log_entries for select to authenticated using (true);

drop policy if exists shift_log_entries_insert_authenticated_staff on public.shift_log_entries;
drop policy if exists shift_log_entries_insert_self on public.shift_log_entries;
create policy shift_log_entries_insert_authenticated_staff
on public.shift_log_entries for insert to authenticated
with check (
  exists (
    select 1
    from public.staff s
    where s.id = auth.uid()
      and coalesce(s.is_active, true) = true
  )
);

drop policy if exists shift_log_entries_update_authenticated_staff on public.shift_log_entries;
drop policy if exists shift_log_entries_update_owner_or_admin on public.shift_log_entries;
create policy shift_log_entries_update_authenticated_staff
on public.shift_log_entries for update to authenticated
using (
  exists (
    select 1
    from public.staff s
    where s.id = auth.uid()
      and coalesce(s.is_active, true) = true
  )
)
with check (
  exists (
    select 1
    from public.staff s
    where s.id = auth.uid()
      and coalesce(s.is_active, true) = true
  )
);

drop policy if exists shift_log_entries_delete_authenticated_staff on public.shift_log_entries;
drop policy if exists shift_log_entries_delete_owner_or_admin on public.shift_log_entries;
create policy shift_log_entries_delete_authenticated_staff
on public.shift_log_entries for delete to authenticated
using (
  exists (
    select 1
    from public.staff s
    where s.id = auth.uid()
      and coalesce(s.is_active, true) = true
  )
);

commit;
