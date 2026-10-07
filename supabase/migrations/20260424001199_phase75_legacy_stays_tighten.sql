-- Phase 75 · Batch 4 · legacy_stays policy tightening
-- Date: 2026-04-24
-- Owner: Lead (skeleton) + Agent B (verify + apply)
--
-- Context: Agent B §2.1 found the policy `legacy_stays_service_role` (created in
--   20260329_phase51_guest_migration.sql:28) was missing a `TO service_role`
--   qualifier, making it effectively TO PUBLIC — any authenticated user with the
--   anon key would read all legacy stay rows.
--
-- Fix shape: DROP the broken policy. RLS stays ON with zero policies. Combined
-- with the fact that all legit readers use the service_role client in API
-- routes (which bypasses RLS entirely), the table becomes truly server-only.
--
-- Agent B MUST verify before applying:
--   1. grep `.from('legacy_stays')` — confirm every call site is a server API
--      route, never a browser client.
--   2. curl as non-service-role user after migration: expect zero rows.
--
-- Risk: LOW — the existing policy was broken; removing it matches documented intent.

BEGIN;

DROP POLICY IF EXISTS legacy_stays_service_role ON public.legacy_stays;
COMMENT ON TABLE public.legacy_stays IS
  'Historical pre-migration stay data. Service-role only (RLS ON with no policies).';

COMMIT;
