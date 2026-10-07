begin;

create table if not exists public.guest_profile_conflict_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null default (timezone('utc', now()) + interval '7 days'),
  actor_user_id uuid references public.profiles (user_id),
  reservation_id uuid references public.reservations (id) on delete set null,
  attempted_profile_id uuid references public.guest_profiles (id) on delete set null,
  resolved_profile_id uuid not null references public.guest_profiles (id) on delete cascade,
  source_flow text not null,
  document_type text,
  document_masked text,
  business_date date not null default ((timezone('Asia/Bangkok', now()))::date),
  retry_count integer not null default 1,
  terminal_id text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_guest_profile_conflict_events_created_at
  on public.guest_profile_conflict_events (created_at desc);

create index if not exists idx_guest_profile_conflict_events_expires_at
  on public.guest_profile_conflict_events (expires_at);

create index if not exists idx_guest_profile_conflict_events_source_flow
  on public.guest_profile_conflict_events (source_flow, created_at desc);

create index if not exists idx_guest_profile_conflict_events_reservation
  on public.guest_profile_conflict_events (reservation_id, created_at desc);

alter table public.guest_profile_conflict_events enable row level security;

drop policy if exists guest_profile_conflict_events_service_read on public.guest_profile_conflict_events;
create policy guest_profile_conflict_events_service_read
  on public.guest_profile_conflict_events
  for select
  to authenticated
  using (public.has_any_role(array['admin'::public.user_role, 'supervisor'::public.user_role]));

create or replace function public.cleanup_guest_profile_conflict_events()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer := 0;
begin
  delete from public.guest_profile_conflict_events
  where expires_at < timezone('utc', now());

  get diagnostics deleted_count = row_count;

  insert into public.cleanup_logs (job_name, deleted_count)
  values ('guest_profile_conflict_events', deleted_count);

  return deleted_count;
end;
$$;

grant execute on function public.cleanup_guest_profile_conflict_events() to service_role;

commit;
