-- Maintenance security hardening: close the anon back door on the
-- maintenance module.
--
-- THE HOLE: 202603010002_phase9_maintenance.sql:92-125 created
-- `for all to anon, authenticated using(true) with check(true)` on 5 maintenance
-- tables, and 202603010003_phase9_maintenance_checklist_results.sql:28-32 did the
-- same for the 6th (maintenance_assignment_checklist_results). Both files also
-- granted EXECUTE on the maintenance read RPCs to anon (:317-319 and :85).
-- Net effect: anyone holding the publishable (anon) key could read and MUTATE every
-- maintenance table directly through PostgREST, bypassing Next.js entirely. The
-- 2026-06 security waves (202606060002 POS/stock, 202606210001 hk_finish) never
-- reached this module, so the phase9 grants are still live.
--
-- THE FIX: RLS + table REVOKE is the load-bearing wall here. The 3 read RPCs are
-- `language sql stable` (NOT security definer), so they execute as the CALLER and
-- respect RLS — dropping the policies alone already blanks them for anon. The
-- EXECUTE revokes below are defense-in-depth, and cheap.
--
-- ★ RE-EMIT TRAP — READ BEFORE EDITING THESE FUNCTIONS:
-- 202603010003_phase9_maintenance_checklist_results.sql:38 does
--   `drop function if exists public.get_todays_maintenance_assignments(date);`
-- then re-creates it and re-grants it to anon at :85. DROP FUNCTION discards every
-- prior grant, so a later drop/create silently RESTORES anon access and quietly
-- re-opens this hole. Any future migration that redefines these functions must
-- re-emit the REVOKE/GRANT block below in the same file.
--
-- SAFE TO REVOKE: every caller uses the service-role client
-- (createServerSupabaseClient). Verified call sites — api/maintenance/status:77,
-- api/maintenance/assignments:91+173, api/housekeeping/status:686,
-- api/housekeeping/maid-rooms:435. Zero anon/authenticated (browser) callers, so
-- no app path loses access. service_role bypasses RLS, so no replacement policy is
-- needed: RLS enabled with no policy = fail-closed for anon/authenticated.
--
-- NOT TOUCHED: public.hk_finish_task_with_maintenance — already locked down by
-- 202606210001_secure_hk_finish_anon.sql, and the maid "finish task with top-up"
-- flow rides it. Left strictly alone.
--
-- Transaction split follows the 202606060002 idiom: the table/policy tightening
-- commits FIRST and independently, so a later RPC signature drift cannot roll back
-- the wall that actually closes the hole.

-- ============================================================
-- STEP 0 — schema-state probe (fail LOUD, never silently skip)
-- ============================================================
-- Deliberately NOT written as `ALTER TABLE IF EXISTS ...`: an IF EXISTS guard on a
-- missing object no-ops the whole statement, and the migration then reports success
-- while having locked down nothing. If phase9 is not applied, stop and say so.
DO $$
DECLARE
  missing text[] := '{}';
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'public.maintenance_tasks',
    'public.maintenance_logs',
    'public.maintenance_notes',
    'public.maintenance_task_times',
    'public.maintenance_assignments',
    'public.maintenance_assignment_checklist_results'
  ] LOOP
    IF to_regclass(t) IS NULL THEN
      missing := missing || t;
    END IF;
  END LOOP;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Preflight failed: missing maintenance table(s): %. phase9 migrations are not applied on this database; refusing to report a lockdown that did not happen.', array_to_string(missing, ', ');
  END IF;
END $$;

-- ============================================================
-- PART A — tables: drop the permissive policies, revoke the grants
-- ============================================================
BEGIN;

-- NOTE: the checklist policy name is NOT derived from its table name
-- (maintenance_assignment_checklists_allow_all on maintenance_assignment_checklist_results).
-- A DROP written from the table name misses it and leaves that table wide open.
DROP POLICY IF EXISTS maintenance_tasks_allow_all ON public.maintenance_tasks;
DROP POLICY IF EXISTS maintenance_logs_allow_all ON public.maintenance_logs;
DROP POLICY IF EXISTS maintenance_notes_allow_all ON public.maintenance_notes;
DROP POLICY IF EXISTS maintenance_task_times_allow_all ON public.maintenance_task_times;
DROP POLICY IF EXISTS maintenance_assignments_allow_all ON public.maintenance_assignments;
DROP POLICY IF EXISTS maintenance_assignment_checklists_allow_all ON public.maintenance_assignment_checklist_results;

-- Re-assert RLS (idempotent). With the policies gone and RLS on, anon/authenticated
-- see zero rows and can write nothing; service_role bypasses RLS and is unaffected.
ALTER TABLE public.maintenance_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_task_times ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_assignment_checklist_results ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.maintenance_tasks,
  public.maintenance_logs,
  public.maintenance_notes,
  public.maintenance_task_times,
  public.maintenance_assignments,
  public.maintenance_assignment_checklist_results
FROM anon, authenticated;

GRANT ALL ON TABLE
  public.maintenance_tasks,
  public.maintenance_logs,
  public.maintenance_notes,
  public.maintenance_task_times,
  public.maintenance_assignments,
  public.maintenance_assignment_checklist_results
TO service_role;

COMMIT;

-- ============================================================
-- PART B — RPCs: service_role-only EXECUTE (defense-in-depth)
-- ============================================================
-- Overload sweep done across every migration: exactly one live signature each. The
-- legacy get_todays_maintenance_assignments(date) overload was already dropped by
-- 202603010003:38 before its re-create, so no stale arity survives to be missed.
BEGIN;

REVOKE EXECUTE ON FUNCTION public.get_room_maintenance_status()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_room_maintenance_status()
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.get_maintenance_for_rooms(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_maintenance_for_rooms(uuid[])
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.get_todays_maintenance_assignments(date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_todays_maintenance_assignments(date)
  TO service_role;

COMMIT;
