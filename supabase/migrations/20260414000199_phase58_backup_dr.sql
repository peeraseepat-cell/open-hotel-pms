create table if not exists public.backup_logs (
  id uuid primary key default gen_random_uuid(),
  backup_type text not null,
  status text not null default 'started',
  file_name text null,
  file_size_bytes bigint null,
  record_count integer null,
  error_message text null,
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists idx_backup_logs_type_date
  on public.backup_logs (backup_type, created_at desc);

create table if not exists public.backup_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  snapshot_data jsonb not null,
  record_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_backup_snapshots_date
  on public.backup_snapshots (created_at desc);

create table if not exists public.backup_config (
  id integer primary key default 1,
  offline_pin text null,
  r2_bucket text not null default 'pms-backups',
  retention_days integer not null default 60,
  updated_at timestamptz not null default now(),
  constraint backup_config_singleton check (id = 1)
);

insert into public.backup_config (id)
values (1)
on conflict (id) do nothing;
