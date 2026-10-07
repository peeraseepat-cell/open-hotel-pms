-- Phase 71: POS item seed
--
-- Lead folded the actual seed payload into 202604210002_phase71_products_name_th.sql
-- together with the schema additions (`name_th`, `pos_abbreviated_enabled`).
-- This no-op migration preserves the Phase 71 numbering / ownership contract
-- from WORK_ASSIGNMENT_PHASE71.md without duplicating seed writes.

BEGIN;
SELECT 1;
COMMIT;
