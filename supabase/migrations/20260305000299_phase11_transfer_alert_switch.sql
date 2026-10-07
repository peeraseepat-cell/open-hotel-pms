-- Phase 11 hotfix: board transfer alert switch (ON/OFF)
-- Default behavior: every transfer starts with alert enabled.

alter table if exists public.transfers
  add column if not exists alert_enabled boolean;

update public.transfers
set alert_enabled = true
where alert_enabled is null;

alter table if exists public.transfers
  alter column alert_enabled set default true,
  alter column alert_enabled set not null;

create index if not exists idx_transfers_alert_enabled
  on public.transfers (alert_enabled);
