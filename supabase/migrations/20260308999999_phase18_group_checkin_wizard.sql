-- ============================================================
-- Phase 18: Group Check-in Wizard Drafts
-- ============================================================

create table if not exists public.group_checkin_wizard_drafts (
  id uuid primary key default gen_random_uuid(),
  booking_group_id uuid not null references public.booking_groups(id) on delete cascade,
  business_date date not null,
  status text not null default 'draft' check (status in ('draft', 'completed', 'cancelled')),
  current_step smallint not null default 1 check (current_step between 1 and 4),
  draft_json jsonb not null default '{}'::jsonb,
  last_committed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_group_id, business_date)
);

comment on table public.group_checkin_wizard_drafts is
  'Stateful draft storage for group check-in wizard by booking_group and business date.';

comment on column public.group_checkin_wizard_drafts.status is
  'draft = active wizard, completed = fully checked in, cancelled = manually or force cancelled.';

create index if not exists idx_group_checkin_wizard_drafts_status_business_date
  on public.group_checkin_wizard_drafts (status, business_date);

create or replace function public.touch_group_checkin_wizard_drafts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_group_checkin_wizard_drafts_updated_at on public.group_checkin_wizard_drafts;
create trigger trg_group_checkin_wizard_drafts_updated_at
before update on public.group_checkin_wizard_drafts
for each row execute function public.touch_group_checkin_wizard_drafts_updated_at();

alter table public.group_checkin_wizard_drafts enable row level security;
drop policy if exists service_full on public.group_checkin_wizard_drafts;
create policy service_full
  on public.group_checkin_wizard_drafts
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
