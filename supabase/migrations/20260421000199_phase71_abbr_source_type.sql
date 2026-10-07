-- Phase 71: Abbreviated Tax Invoice — add `source_type` discriminator
-- Enables the Phase 70 `abbreviated_tax_invoice` table to host 3 sources:
--   - room   → Phase 70 original behaviour (daily, per channel_group)
--   - dayuse → Phase 71 monthly (Walk-in only, channel_group = NULL)
--   - pos    → Phase 71 daily   (Walk-in only, channel_group = NULL)
--
-- Contract locks (per Lead answer to Agent B, 2026-04-21):
--   1. source_type is NOT NULL, default 'room' (back-compat for Phase 70 rows).
--   2. channel_group is DROP NOT NULL — NULL for dayuse/pos.
--   3. tax_group on line table is DROP NOT NULL — NULL for dayuse/pos lines.
--   4. source_entry_ids is reused for all 3 types:
--         room/dayuse → monthly_audit_entries.id[]
--         pos         → pos_orders.id[]
--   5. Uniqueness indexes are partitioned per source_type (see below).

BEGIN;

-- ------------------------------------------------------------
-- 1) Create source_type enum
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'abbreviated_source_type') THEN
    CREATE TYPE public.abbreviated_source_type AS ENUM ('room', 'dayuse', 'pos');
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 2) Head: add source_type, relax channel_group, add consistency CHECK
-- ------------------------------------------------------------
ALTER TABLE public.abbreviated_tax_invoice
  ADD COLUMN IF NOT EXISTS source_type public.abbreviated_source_type
    NOT NULL DEFAULT 'room';

COMMENT ON COLUMN public.abbreviated_tax_invoice.source_type
  IS 'Phase 71 discriminator: room | dayuse | pos. channel_group is NULL for dayuse/pos.';

ALTER TABLE public.abbreviated_tax_invoice
  ALTER COLUMN channel_group DROP NOT NULL;

-- Replace the original channel_group CHECK (which forbade NULL) with a
-- NULL-aware version, then add cross-column consistency against source_type.
-- The original check was inline (no explicit name) — drop by probing the
-- constraint catalog for whichever name PostgreSQL auto-assigned.
DO $$
DECLARE
  v_con text;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.abbreviated_tax_invoice'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%channel_group%IN%(%ota%walkin_direct%)%'
  LOOP
    EXECUTE format('ALTER TABLE public.abbreviated_tax_invoice DROP CONSTRAINT %I', v_con);
  END LOOP;
END
$$;

ALTER TABLE public.abbreviated_tax_invoice
  ADD CONSTRAINT abbr_invoice_channel_group_valid
  CHECK (
    channel_group IS NULL
    OR channel_group IN ('ota', 'walkin_direct')
  );

ALTER TABLE public.abbreviated_tax_invoice
  ADD CONSTRAINT abbr_invoice_source_channel_consistency
  CHECK (
    (source_type = 'room'   AND channel_group IS NOT NULL) OR
    (source_type = 'dayuse' AND channel_group IS NULL)     OR
    (source_type = 'pos'    AND channel_group IS NULL)
  );

-- ------------------------------------------------------------
-- 3) Lines: allow NULL tax_group (dayuse/pos have no A-E semantics)
-- ------------------------------------------------------------
ALTER TABLE public.abbreviated_tax_invoice_line
  ALTER COLUMN tax_group DROP NOT NULL;

DO $$
DECLARE
  v_con text;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.abbreviated_tax_invoice_line'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%tax_group%IN%(%A%B%C%D%E%)%'
  LOOP
    EXECUTE format('ALTER TABLE public.abbreviated_tax_invoice_line DROP CONSTRAINT %I', v_con);
  END LOOP;
END
$$;

ALTER TABLE public.abbreviated_tax_invoice_line
  ADD CONSTRAINT abbr_line_tax_group_valid
  CHECK (tax_group IS NULL OR tax_group IN ('A', 'B', 'C', 'D', 'E'));

-- ------------------------------------------------------------
-- 4) Uniqueness — partition per source_type
--
-- Drop the Phase 70 composite index that only covered (audit_period_id,
-- issue_date, channel_group). Replace with 3 partial indexes, one per
-- source_type, so each type has a correct uniqueness rule:
--   - room   → (audit_period_id, issue_date, channel_group)  ≤ 1 per day per channel
--   - dayuse → (audit_period_id)                             ≤ 1 per audit period
--   - pos    → (issue_date)                                  ≤ 1 per calendar date
-- ------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_abbr_invoice_day_channel_active;

CREATE UNIQUE INDEX IF NOT EXISTS idx_abbr_invoice_room_day_channel_active
  ON public.abbreviated_tax_invoice(audit_period_id, issue_date, channel_group)
  WHERE source_type = 'room' AND status <> 'cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS idx_abbr_invoice_dayuse_period_active
  ON public.abbreviated_tax_invoice(audit_period_id)
  WHERE source_type = 'dayuse' AND status <> 'cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS idx_abbr_invoice_pos_date_active
  ON public.abbreviated_tax_invoice(issue_date)
  WHERE source_type = 'pos' AND status <> 'cancelled';

-- Helpful lookup index for source_type filtering
CREATE INDEX IF NOT EXISTS idx_abbr_invoice_source_type
  ON public.abbreviated_tax_invoice(source_type, issue_date);

COMMIT;
