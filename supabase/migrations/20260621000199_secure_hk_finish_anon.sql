-- Residual from an RBAC review (2026-06-21): the SECURITY DEFINER write RPC
-- hk_finish_task_with_maintenance was never revoked from anon/authenticated, while
-- its sibling DEFINER write RPCs were locked down in 202606060002. With the grant in
-- place, the public anon key can call it directly via PostgREST (finish arbitrary HK
-- tasks, write maintenance_logs, trigger stock deduction), bypassing Next.js entirely.
-- The app invokes it via the service-role client only, so service_role keeps EXECUTE.
-- The legacy 8-arg overload was already dropped in 202603010003; only the current
-- 9-arg signature needs locking down.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.hk_finish_task_with_maintenance(
  uuid, text, text, jsonb, boolean, text, uuid[], text, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.hk_finish_task_with_maintenance(
  uuid, text, text, jsonb, boolean, text, uuid[], text, jsonb
) TO service_role;

COMMIT;
