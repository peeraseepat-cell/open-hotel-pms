-- ============================================================================
-- Phase 73 · Migration 001 — Rule Groups + Members + Tiers
-- ============================================================================
-- Owner: Agent B
-- Reviewer: Lead (P1 — FK integrity, priority unique? NO, CHECK constraints)
-- Depends on: 20260219_000001_init_core.sql (room_types), auth schema
--
-- LAYER 0 SKELETON — DO NOT APPLY UNTIL AGENT B FILLS BODY.
-- See WORK_ASSIGNMENT_PHASE73.md §5.1 for DDL reference.
--
-- Tables:
--   - rate_rule_groups        (priority, trigger_scope, mode, effective window)
--   - rate_rule_group_members (per-member action_type + action_value + rounding — B1/B2/B4)
--   - rate_rule_tiers         (threshold ladder — B3)
--
-- Invariants Lead will verify (P1):
--   1. trigger_scope CHECK covers 3 values exactly.
--   2. mode CHECK covers 2 values exactly.
--   3. action_type CHECK covers 4 values (percent/fixed_thb/step/override).
--   4. rounding CHECK covers 4 values (none/nearest_10/nearest_50/nearest_100).
--   5. effective_to >= effective_from when both set.
--   6. RLS enabled on all 3 tables with admin-write / supervisor+admin-read pattern.
-- ============================================================================

-- Agent B: implement full migration below this line.

create table if not exists public.rate_rule_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  priority int not null default 100,
  trigger_scope text not null
    check (trigger_scope in ('hotel_wide', 'group_aggregate', 'per_room_type')),
  mode text not null
    check (mode in ('suggest_only', 'auto_apply')),
  is_active boolean not null default true,
  effective_from date,
  effective_to date,
  applies_to_dow int[],
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  created_by uuid references auth.users(id),
  check (effective_to is null or effective_from is null or effective_to >= effective_from),
  check (
    applies_to_dow is null
    or (
      coalesce(array_length(applies_to_dow, 1), 0) > 0
      and applies_to_dow <@ array[0, 1, 2, 3, 4, 5, 6]::int[]
    )
  )
);

comment on table public.rate_rule_groups is
  'Phase 73 dynamic rate rule groups. Each group has a trigger scope, mode, and threshold tiers.';

create table if not exists public.rate_rule_group_members (
  group_id uuid not null references public.rate_rule_groups(id) on delete cascade,
  room_type_id bigint not null references public.room_types(id) on delete cascade,
  action_type text not null
    check (action_type in ('percent', 'fixed_thb', 'step', 'override')),
  action_value numeric(10, 2) not null,
  rounding text not null default 'nearest_10'
    check (rounding in ('none', 'nearest_10', 'nearest_50', 'nearest_100')),
  primary key (group_id, room_type_id)
);

comment on table public.rate_rule_group_members is
  'Phase 73 per-room-type pricing adjustment rules within a dynamic rate rule group.';

create table if not exists public.rate_rule_tiers (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.rate_rule_groups(id) on delete cascade,
  trigger_metric text not null
    check (trigger_metric in ('occ_percent', 'occ_rooms_booked')),
  trigger_threshold numeric(10, 2) not null,
  tier_order int not null default 1,
  unique (group_id, tier_order)
);

comment on table public.rate_rule_tiers is
  'Phase 73 threshold ladder for a dynamic rate rule group. Highest matching tier wins.';

create index if not exists idx_rule_groups_active
  on public.rate_rule_groups(is_active, priority)
  where is_active;

create index if not exists idx_rule_tiers_by_group
  on public.rate_rule_tiers(group_id, trigger_threshold desc, tier_order asc);

drop trigger if exists trg_rate_rule_groups_updated_at on public.rate_rule_groups;
create trigger trg_rate_rule_groups_updated_at
  before update on public.rate_rule_groups
  for each row execute function public.set_updated_at();

alter table public.rate_rule_groups enable row level security;
alter table public.rate_rule_group_members enable row level security;
alter table public.rate_rule_tiers enable row level security;

drop policy if exists rrg_read on public.rate_rule_groups;
create policy rrg_read on public.rate_rule_groups
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  ));

drop policy if exists rrg_write on public.rate_rule_groups;
create policy rrg_write on public.rate_rule_groups
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

drop policy if exists rrgm_read on public.rate_rule_group_members;
create policy rrgm_read on public.rate_rule_group_members
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  ));

drop policy if exists rrgm_write on public.rate_rule_group_members;
create policy rrgm_write on public.rate_rule_group_members
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

drop policy if exists rrt_read on public.rate_rule_tiers;
create policy rrt_read on public.rate_rule_tiers
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  ));

drop policy if exists rrt_write on public.rate_rule_tiers;
create policy rrt_write on public.rate_rule_tiers
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
