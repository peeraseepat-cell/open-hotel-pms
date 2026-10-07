-- Phase 76 · Batch 2 · evaluate_dynamic_rates EXECUTE revoke
-- Date: 2026-04-25
-- Owner: Lead (decision matrix + body) + Agent B (3-axis spike + cross-check)
--
-- Context: Picks up the deferred RPC #7 from Phase 75 mig 012 lines 96-106.
--   evaluate_dynamic_rates is SECURITY DEFINER with EXECUTE granted to
--   anon + authenticated. Any logged-in browser user could invoke it
--   directly via supabase.rpc(...), bypassing the API-route admin gate.
--
-- 3-AXIS SPIKE EVIDENCE (verified on staging 2026-04-25):
--
--   Axis 1 -- pg_cron callers (User staging SQL):
--     Job 'phase73_dynamic_rate_eval' (active, schedule '0 2 * * *')
--     runs as username=postgres. Calls public.evaluate_dynamic_rates(
--       current_date,
--       current_date + coalesce(app_settings.rate.dynamic_eval_window_days, 60)
--     ).
--     -> postgres MUST retain EXECUTE.
--
--   Axis 2 -- server route callers (Agent B trace):
--     Single caller: POST /api/dynamic-rules/eval (route.ts:24).
--     Guard: requireDynamicRulesAdminAccess (admin role only,
--       src/lib/dynamic-rules/service.ts:532-542).
--     Client: createServerSupabaseClient() = service_role.
--     UI trigger: ManualRunButton.tsx:16 calls server route via fetch
--       (NOT direct .rpc).
--     No browser-side .rpc("evaluate_dynamic_rates") found in src/.
--     -> service_role MUST retain EXECUTE.
--
--   Axis 3 -- current ACL (User staging SQL):
--     Function: public.evaluate_dynamic_rates(p_start date, p_end date)
--     SECURITY DEFINER: true
--     Current proacl: postgres=X/postgres, anon=X/postgres,
--       authenticated=X/postgres, service_role=X/postgres
--     -> anon + authenticated EXECUTE is the security gap (browser bypass
--        of admin gate via supabase.rpc()).
--
-- Decision matrix (per WORK_ASSIGNMENT_PHASE76.md §3.2):
--   cron=postgres + server callers exist
--   -> REVOKE EXECUTE FROM PUBLIC, anon, authenticated
--      GRANT  EXECUTE TO postgres, service_role
--
-- Auth-helper scan on POST /api/dynamic-rules/eval (per WA §3.3):
--   Sole gate: requireDynamicRulesAdminAccess. No double-auth, no
--   CRON_SECRET bypass, no skipRoleCheck-style fail-open.
--
-- Risk: LOW. postgres path = cron job (preserved). service_role path =
--   server route (preserved). Browser path (anon/authenticated direct
--   .rpc) = closed.
--
-- Rollback (emergency only):
--   GRANT EXECUTE ON FUNCTION public.evaluate_dynamic_rates(date, date)
--     TO authenticated, anon;

BEGIN;

-- ============================================================================
-- evaluate_dynamic_rates  (Phase 73 -- Dynamic rate engine)
-- Source: 202604230004_phase73_evaluate_dynamic_rates_rpc.sql:174
-- Sig: (date, date)
-- Callers (verified Phase 76 Batch 2 spike, 2026-04-25):
--   - src/lib/dynamic-rules/service.ts:914  (runDynamicEvaluation, service_role)
--   - pg_cron 'phase73_dynamic_rate_eval'   (postgres role, '0 2 * * *')
-- ============================================================================
REVOKE EXECUTE ON FUNCTION public.evaluate_dynamic_rates(date, date)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.evaluate_dynamic_rates(date, date)
  TO postgres, service_role;

COMMIT;
