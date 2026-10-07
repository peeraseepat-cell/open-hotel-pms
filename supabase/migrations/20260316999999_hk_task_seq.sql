-- HK Task Seq: Allow multiple HK tasks per room per day
-- Scenario: room cleaned (C/O), new guest checks in, problem occurs,
--           guest moves to another room → old room becomes dirty again.
--           Both the completed task AND the new dirty task must be preserved.
--
-- Solution: add task_seq SMALLINT (default 1) to unique key.
-- Existing rows stay as seq=1. New tasks after a completed seq=1 get seq=2, etc.

ALTER TABLE public.housekeeping_tasks
  ADD COLUMN IF NOT EXISTS task_seq SMALLINT NOT NULL DEFAULT 1;

-- Drop old unique index
DROP INDEX IF EXISTS uq_housekeeping_tasks_room_day;

-- New composite unique index
CREATE UNIQUE INDEX IF NOT EXISTS uq_housekeeping_tasks_room_day_seq
  ON public.housekeeping_tasks (room_id, stay_date, task_seq);
