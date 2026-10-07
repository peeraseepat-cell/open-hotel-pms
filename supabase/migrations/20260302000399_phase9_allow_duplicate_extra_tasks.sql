-- Phase 9 hotfix: allow creating multiple extra task cards with same task_name on same date.
-- Old schema had UNIQUE (assignment_date, task_name) which blocks duplicate cards.

ALTER TABLE IF EXISTS public.extra_task_assignments
  DROP CONSTRAINT IF EXISTS extra_task_assignments_assignment_date_task_name_key;

CREATE INDEX IF NOT EXISTS idx_extra_task_assignments_date_maid_priority
  ON public.extra_task_assignments (assignment_date, assigned_maid, priority);
