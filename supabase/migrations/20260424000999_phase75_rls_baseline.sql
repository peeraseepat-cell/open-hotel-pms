-- Phase 75 · Batch 3 · RLS baseline on 11 no-RLS tables
-- Date: 2026-04-24
-- Owner: Lead (skeleton) + Agent B (body fill)
-- Risk: LOW — Agent A confirmed client-side reads go through API routes (service_role bypasses RLS).
--              Permissive SELECT policy for authenticated keeps any future anon-key path working too.
--
-- Pattern per table (MUST be idempotent):
--   ALTER TABLE public.<table> ENABLE ROW LEVEL SECURITY;
--   DROP POLICY IF EXISTS <table>_authenticated_read ON public.<table>;
--   CREATE POLICY <table>_authenticated_read
--     ON public.<table>
--     FOR SELECT
--     TO authenticated
--     USING (true);
--
-- No INSERT/UPDATE/DELETE policies — writes remain service-role-only (existing behavior).
--
-- Rollback: run 202604240010_phase75_rls_rollback.sql (prepared but NOT applied).

BEGIN;

-- ============================================================================
-- 1. rate_plans
-- ============================================================================
ALTER TABLE public.rate_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rate_plans_authenticated_read ON public.rate_plans;
CREATE POLICY rate_plans_authenticated_read
  ON public.rate_plans
  FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- 2. rate_plan_tiers
-- ============================================================================
ALTER TABLE public.rate_plan_tiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rate_plan_tiers_authenticated_read ON public.rate_plan_tiers;
CREATE POLICY rate_plan_tiers_authenticated_read
  ON public.rate_plan_tiers
  FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- 3. rate_plan_profiles
-- ============================================================================
ALTER TABLE public.rate_plan_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rate_plan_profiles_authenticated_read ON public.rate_plan_profiles;
CREATE POLICY rate_plan_profiles_authenticated_read
  ON public.rate_plan_profiles
  FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- 4. booking_groups
-- ============================================================================
ALTER TABLE public.booking_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS booking_groups_authenticated_read ON public.booking_groups;
CREATE POLICY booking_groups_authenticated_read
  ON public.booking_groups
  FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- 5. daily_plans
-- ============================================================================
ALTER TABLE public.daily_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS daily_plans_authenticated_read ON public.daily_plans;
CREATE POLICY daily_plans_authenticated_read
  ON public.daily_plans
  FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- 6. checklist_templates
-- ============================================================================
ALTER TABLE public.checklist_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS checklist_templates_authenticated_read ON public.checklist_templates;
CREATE POLICY checklist_templates_authenticated_read
  ON public.checklist_templates
  FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- 7. extra_task_templates
-- ============================================================================
ALTER TABLE public.extra_task_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS extra_task_templates_authenticated_read ON public.extra_task_templates;
CREATE POLICY extra_task_templates_authenticated_read
  ON public.extra_task_templates
  FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- 8. extra_task_assignments
-- ============================================================================
ALTER TABLE public.extra_task_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS extra_task_assignments_authenticated_read ON public.extra_task_assignments;
CREATE POLICY extra_task_assignments_authenticated_read
  ON public.extra_task_assignments
  FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- 9. stock_items
-- ============================================================================
ALTER TABLE public.stock_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_items_authenticated_read ON public.stock_items;
CREATE POLICY stock_items_authenticated_read
  ON public.stock_items
  FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- 10. stock_transactions
-- ============================================================================
ALTER TABLE public.stock_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stock_transactions_authenticated_read ON public.stock_transactions;
CREATE POLICY stock_transactions_authenticated_read
  ON public.stock_transactions
  FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- 11. maid_cart_items
-- ============================================================================
ALTER TABLE public.maid_cart_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS maid_cart_items_authenticated_read ON public.maid_cart_items;
CREATE POLICY maid_cart_items_authenticated_read
  ON public.maid_cart_items
  FOR SELECT
  TO authenticated
  USING (true);

COMMIT;
