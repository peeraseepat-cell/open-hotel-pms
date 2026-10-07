create table if not exists public.ui_event_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles (user_id) on delete set null,
  actor_name text,
  actor_role text,
  pathname text not null,
  event_type text not null,
  event_name text not null,
  severity text not null default 'info',
  entity_type text,
  entity_id text,
  request_id text,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_ui_event_logs_created_at
  on public.ui_event_logs (created_at desc);

create index if not exists idx_ui_event_logs_type_created
  on public.ui_event_logs (event_type, created_at desc);

create index if not exists idx_ui_event_logs_path_created
  on public.ui_event_logs (pathname, created_at desc);

create index if not exists idx_ui_event_logs_actor_created
  on public.ui_event_logs (actor_user_id, created_at desc);

create index if not exists idx_ui_event_logs_severity_created
  on public.ui_event_logs (severity, created_at desc);

alter table public.ui_event_logs enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'ui_event_logs'
      and policyname = 'ui_event_logs_read_policy'
  ) then
    create policy ui_event_logs_read_policy
      on public.ui_event_logs
      for select
      using (auth.role() = 'authenticated');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'ui_event_logs'
      and policyname = 'ui_event_logs_insert_policy'
  ) then
    create policy ui_event_logs_insert_policy
      on public.ui_event_logs
      for insert
      with check (auth.role() = 'authenticated');
  end if;
end $$;
