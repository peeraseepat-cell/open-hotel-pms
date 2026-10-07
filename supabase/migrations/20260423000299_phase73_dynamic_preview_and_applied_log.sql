-- ============================================================================
-- Phase 73 · Migration 002 — Dynamic Preview + Applied Log
-- ============================================================================
-- Owner: Agent B
-- Reviewer: Lead (P1)
-- Depends on: 001 (rate_rule_groups, rate_rule_tiers), init_core (room_types)
--
-- LAYER 0 SKELETON — DO NOT APPLY UNTIL AGENT B FILLS BODY.
-- See WORK_ASSIGNMENT_PHASE73.md §5.2 for DDL reference.
--
-- Tables:
--   - rate_dynamic_preview       (suggestion queue + applied audit — unified)
--   - rate_dynamic_applied_log   (undo window tracking — B13)
--
-- Invariants Lead will verify (P1):
--   1. status CHECK covers 5 values (suggested/applied/rejected/superseded/expired).
--   2. direction CHECK covers 3 values (up/down/same).
--   3. requires_confirmation correctly forced true when direction='down' (B12)
--      — enforced by evaluator logic, also add a CHECK constraint here as
--      defense-in-depth:
--        CHECK (direction <> 'down' OR requires_confirmation = true)
--   4. superseded_by is self-FK (rate_dynamic_preview.id). (B21)
--   5. apply_method CHECK covers 3 values (auto/confirmed/manual_run).
--   6. affected_room_ids[] NOT NULL and non-empty.
--   7. All RLS enabled; admin/supervisor read, admin-only write (API-mediated).
--
-- Indexes required:
--   - idx_preview_pending ON (status, stay_date) WHERE status='suggested'
--   - idx_preview_by_date ON (stay_date, room_type_id)
--   - idx_preview_eval_run ON (eval_run_id)
--   - idx_applied_log_undoable ON (reversible_until) WHERE undone_at IS NULL
--   - idx_applied_log_recent ON (applied_at DESC)
-- ============================================================================

-- Agent B: implement full migration below this line.

create table if not exists public.rate_dynamic_preview (
  id uuid primary key default gen_random_uuid(),
  stay_date date not null,
  room_type_id bigint not null references public.room_types(id) on delete cascade,
  base_price numeric(10, 2) not null,
  suggested_price numeric(10, 2) not null,
  direction text not null
    check (direction in ('up', 'down', 'same')),
  requires_confirmation boolean not null default false,
  clamped_to_floor boolean not null default false,
  clamped_to_max boolean not null default false,
  direction_override boolean not null default false,
  applied_rule_group_id uuid not null references public.rate_rule_groups(id) on delete cascade,
  applied_tier_id uuid not null references public.rate_rule_tiers(id) on delete cascade,
  status text not null default 'suggested'
    check (status in ('suggested', 'applied', 'rejected', 'superseded', 'expired')),
  superseded_by uuid references public.rate_dynamic_preview(id) on delete set null,
  eval_run_id uuid not null,
  created_at timestamptz not null default timezone('utc', now()),
  actioned_at timestamptz,
  actioned_by uuid references auth.users(id),
  reject_reason text,
  check (direction <> 'down' or requires_confirmation = true)
);

comment on table public.rate_dynamic_preview is
  'Phase 73 preview queue plus audit trail for dynamic rule evaluations.';

create index if not exists idx_preview_pending
  on public.rate_dynamic_preview(status, stay_date)
  where status = 'suggested';

create index if not exists idx_preview_by_date
  on public.rate_dynamic_preview(stay_date, room_type_id);

create index if not exists idx_preview_eval_run
  on public.rate_dynamic_preview(eval_run_id);

create table if not exists public.rate_dynamic_applied_log (
  id uuid primary key default gen_random_uuid(),
  preview_id uuid references public.rate_dynamic_preview(id) on delete set null,
  stay_date date not null,
  room_type_id bigint not null references public.room_types(id),
  previous_price numeric(10, 2) not null,
  new_price numeric(10, 2) not null,
  applied_at timestamptz not null default timezone('utc', now()),
  applied_by uuid references auth.users(id),
  apply_method text not null
    check (apply_method in ('auto', 'confirmed', 'manual_run')),
  reversible_until timestamptz not null,
  undone_at timestamptz,
  undone_by uuid references auth.users(id),
  affected_room_ids uuid[] not null,
  check (coalesce(array_length(affected_room_ids, 1), 0) > 0)
);

comment on table public.rate_dynamic_applied_log is
  'Phase 73 apply audit log with undo window and fixed room-id snapshot.';

create index if not exists idx_applied_log_undoable
  on public.rate_dynamic_applied_log(reversible_until)
  where undone_at is null;

create index if not exists idx_applied_log_recent
  on public.rate_dynamic_applied_log(applied_at desc);

alter table public.rate_dynamic_preview enable row level security;
alter table public.rate_dynamic_applied_log enable row level security;

drop policy if exists rdp_read on public.rate_dynamic_preview;
create policy rdp_read on public.rate_dynamic_preview
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  ));

drop policy if exists rdp_write on public.rate_dynamic_preview;
create policy rdp_write on public.rate_dynamic_preview
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and p.role = 'admin'
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and p.role = 'admin'
  ));

drop policy if exists rdal_read on public.rate_dynamic_applied_log;
create policy rdal_read on public.rate_dynamic_applied_log
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  ));

drop policy if exists rdal_write on public.rate_dynamic_applied_log;
create policy rdal_write on public.rate_dynamic_applied_log
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and p.role = 'admin'
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and p.role = 'admin'
  ));
