-- ============================================================================
-- Phase 73 · Migration 003 — Dynamic Engine app_settings Seed
-- ============================================================================
-- Owner: Agent B
-- Reviewer: Lead (P3 — key names + defaults)
-- Depends on: Phase 72 Migration 001 (app_settings table exists)
--
-- LAYER 0 SKELETON — DO NOT APPLY UNTIL AGENT B FILLS BODY.
-- See WORK_ASSIGNMENT_PHASE73.md §5.3 for seed reference.
--
-- Keys to insert (ON CONFLICT DO NOTHING):
--   rate.dynamic_max_multiplier            → 1.5
--   rate.dynamic_eval_window_days          → 60
--   rate.dynamic_undo_window_minutes       → 60
--   rate.dynamic_suggestion_stale_minutes  → 120
--
-- Note: Changing these via /pms/setup/rates/admin UI writes directly to
-- app_settings. The pg_cron schedule is NOT parameterised by these
-- (B15 — schedule is a migration-time decision).
-- ============================================================================

-- Agent B: implement full migration below this line.

insert into public.app_settings (key, value_json, description)
values
  (
    'rate.dynamic_max_multiplier',
    '1.5'::jsonb,
    'Max multiple of current base price a dynamic suggestion may output. Hard cap enforced by evaluator.'
  ),
  (
    'rate.dynamic_eval_window_days',
    '60'::jsonb,
    'Default look-ahead window in days for scheduled evaluations. Manual run may override.'
  ),
  (
    'rate.dynamic_undo_window_minutes',
    '60'::jsonb,
    'Minutes after apply during which the operation may be undone.'
  ),
  (
    'rate.dynamic_suggestion_stale_minutes',
    '120'::jsonb,
    'Minutes a suggested row may sit before Telegram alerts admin.'
  )
on conflict (key) do nothing;
