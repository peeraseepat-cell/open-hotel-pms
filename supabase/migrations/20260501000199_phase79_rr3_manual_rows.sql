begin;

create table if not exists public.rr3_row_overrides (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.monthly_audit_periods(id) on delete cascade,
  reservation_id uuid not null,
  guest_profile_id uuid not null,
  checkin_datetime text not null default '',
  room_number text not null default '',
  full_name text not null default '',
  nationality text not null default '',
  id_or_passport text not null default '',
  current_address text not null default '',
  occupation text not null default 'รับจ้าง',
  coming_from text not null default '',
  going_to text not null default 'ตัวอย่าง',
  checkout_datetime text not null default '',
  remarks text not null default '',
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (period_id, reservation_id, guest_profile_id)
);

create index if not exists idx_rr3_row_overrides_period
  on public.rr3_row_overrides(period_id, created_at);

drop trigger if exists trg_rr3_row_overrides_updated_at on public.rr3_row_overrides;
create trigger trg_rr3_row_overrides_updated_at
before update on public.rr3_row_overrides
for each row execute function public.set_updated_at();

alter table public.rr3_row_overrides enable row level security;

drop policy if exists rr3_row_overrides_select on public.rr3_row_overrides;
create policy rr3_row_overrides_select on public.rr3_row_overrides
  for select to authenticated using (true);

drop policy if exists rr3_row_overrides_insert on public.rr3_row_overrides;
create policy rr3_row_overrides_insert on public.rr3_row_overrides
  for insert to authenticated
  with check (exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role in ('admin', 'supervisor')
  ));

drop policy if exists rr3_row_overrides_update on public.rr3_row_overrides;
create policy rr3_row_overrides_update on public.rr3_row_overrides
  for update to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role in ('admin', 'supervisor')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role in ('admin', 'supervisor')
  ));

drop policy if exists rr3_row_overrides_delete on public.rr3_row_overrides;
create policy rr3_row_overrides_delete on public.rr3_row_overrides
  for delete to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role in ('admin', 'supervisor')
  ));

commit;
