create table if not exists public.backup_pairing_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  device_name text null,
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_by_user_id uuid null,
  created_at timestamptz not null default now()
);

create index if not exists idx_backup_pairing_tokens_expires_at
  on public.backup_pairing_tokens (expires_at desc);

create table if not exists public.backup_trusted_devices (
  id uuid primary key default gen_random_uuid(),
  device_name text not null,
  device_token_hash text not null unique,
  paired_via_token_id uuid null references public.backup_pairing_tokens(id) on delete set null,
  user_agent text null,
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz null,
  revoked_at timestamptz null
);

create index if not exists idx_backup_trusted_devices_active
  on public.backup_trusted_devices (revoked_at, paired_at desc);
