begin;

-- Phase 53: Passport photo retention + cleanup telemetry

create extension if not exists pg_cron;
create extension if not exists pg_net;

alter table public.passport_scans
  add column if not exists cleaned_at timestamptz;

alter table public.hotel_settings
  add column if not exists passport_photo_retention_days integer;

update public.hotel_settings
set passport_photo_retention_days = 30
where passport_photo_retention_days is null;

alter table public.hotel_settings
  alter column passport_photo_retention_days set default 30;

alter table public.hotel_settings
  alter column passport_photo_retention_days set not null;

alter table public.hotel_settings
  drop constraint if exists chk_hotel_settings_passport_photo_retention_days;

alter table public.hotel_settings
  add constraint chk_hotel_settings_passport_photo_retention_days
  check (passport_photo_retention_days between 7 and 90);

alter table public.hotel_settings
  add column if not exists passport_cleanup_last_run_at timestamptz,
  add column if not exists passport_cleanup_last_deleted_count integer not null default 0,
  add column if not exists passport_cleanup_last_error text;

create table if not exists public.cleanup_logs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  ran_at timestamptz not null default timezone('utc', now()),
  deleted_count integer not null default 0,
  error_message text,
  duration_ms integer
);

create index if not exists idx_cleanup_logs_job_ran_at
  on public.cleanup_logs (job_name, ran_at desc);

create or replace function public.recalculate_passport_scan_expires_at(new_retention_days integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer := 0;
begin
  if new_retention_days is null or new_retention_days < 1 then
    raise exception 'new_retention_days must be >= 1';
  end if;

  update public.passport_scans
  set expires_at = created_at + make_interval(days => new_retention_days)
  where image_path is not null
    and cleaned_at is null;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

grant execute on function public.recalculate_passport_scan_expires_at(integer) to authenticated;
grant execute on function public.recalculate_passport_scan_expires_at(integer) to service_role;

commit;
