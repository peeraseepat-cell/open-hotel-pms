-- Phase 75 · Batch 5 · SECURITY DEFINER RPC EXECUTE revoke
-- Date: 2026-04-24
-- Owner: Lead (skeleton + signatures verified) + Agent B (body fill)
--
-- Context: Agent B §5 found SECURITY DEFINER RPCs with PUBLIC EXECUTE grants.
--   Any authenticated user can invoke these directly via `supabase.rpc(...)`
--   from the browser, bypassing API-route auth gates.
--
-- PRE-FLIGHT VERIFIED 2026-04-24 (Lead):
--   - grep of `.rpc('<fn>')` across src/ shows ALL 6 non-Phase-73 RPCs are
--     called ONLY from server files (lib/*.ts or api/**/route.ts) using
--     createServerSupabaseClient (service_role).
--   - Therefore REVOKE FROM authenticated is safe for these 6.
--
-- ⚠️ DEFERRED TO PHASE 76: `evaluate_dynamic_rates` (Phase 73 RPC)
--   Reason: called by pg_cron job (see 202604230005_phase73_pg_cron_schedule.sql:56-72).
--   Supabase pg_cron typically runs as postgres (superuser, bypasses grants),
--   but this is NOT verified on our tier and Phase 73 is DO NOT TOUCH list.
--   Staging test required before revoke. Separate Phase 76 migration.
--
-- Signatures below are LOCKED to exact source migration definitions.
-- Agent B: do not modify argument lists. Fill REVOKE/GRANT exactly as written.
--
-- Risk: LOW for these 6 (verified server-only). Rollback = GRANT EXECUTE TO authenticated.

BEGIN;

-- ============================================================================
-- 1. pos_create_order_v2  (Phase 29/54 — POS)
-- Source: 202603310001_phase54_business_date_pos_deposit_hotfix.sql:230
-- Sig: (text, jsonb, text, uuid, text, text, numeric)
-- Caller: src/app/api/pos/orders/route.ts:303 (server)
-- ============================================================================
REVOKE EXECUTE ON FUNCTION public.pos_create_order_v2(text, jsonb, text, uuid, text, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.pos_create_order_v2(text, jsonb, text, uuid, text, text, numeric)
  TO service_role;

-- ============================================================================
-- 2. pos_void_order_v2  (Phase 29/54 — POS)
-- Source: 202603310001_phase54_business_date_pos_deposit_hotfix.sql:650
-- Sig: (uuid, text, text)
-- Caller: src/app/api/pos/orders/[id]/void/route.ts:154 (server)
-- ============================================================================
REVOKE EXECUTE ON FUNCTION public.pos_void_order_v2(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.pos_void_order_v2(uuid, text, text)
  TO service_role;

-- ============================================================================
-- 3. stock_transfer  (Phase 10 — Inventory)
-- Source: 202603020001_phase10_pos_inventory.sql:125
-- Sig: (uuid, int, int, text, text)
-- Caller: src/app/api/stock/transfer/route.ts:53 (server)
-- ============================================================================
REVOKE EXECUTE ON FUNCTION public.stock_transfer(uuid, int, int, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.stock_transfer(uuid, int, int, text, text)
  TO service_role;

-- ============================================================================
-- 4. fo_prepare_daily_stock  (Phase 10 — FO)
-- Source: 202603020002_phase10_fo_prepare_flow.sql:64
-- Sig: (date, text, text, jsonb)
-- Caller: src/app/api/stock/fo-prepare/route.ts:199 (server)
-- ============================================================================
REVOKE EXECUTE ON FUNCTION public.fo_prepare_daily_stock(date, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fo_prepare_daily_stock(date, text, text, jsonb)
  TO service_role;

-- ============================================================================
-- 5. fo_return_daily_stock  (Phase 10 — FO)
-- Source: 202603020002_phase10_fo_prepare_flow.sql:317
-- Sig: (uuid, text, text, jsonb, boolean, text)
-- Caller: no direct .rpc() found in src/ — called via stored proc chain only.
--         Safe to revoke.
-- ============================================================================
REVOKE EXECUTE ON FUNCTION public.fo_return_daily_stock(uuid, text, text, jsonb, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fo_return_daily_stock(uuid, text, text, jsonb, boolean, text)
  TO service_role;

-- ============================================================================
-- 6. fo_amenity_audit_submit  (Phase 65 — FO)
-- Source: 202604150001_phase65_stock_snapshot_amenity_audit.sql:433
-- Sig: (jsonb)
-- Caller: src/lib/fo-amenity-audit.ts:118 (server lib, uses createServerSupabaseClient)
-- ============================================================================
REVOKE EXECUTE ON FUNCTION public.fo_amenity_audit_submit(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fo_amenity_audit_submit(jsonb)
  TO service_role;

-- ============================================================================
-- 7. evaluate_dynamic_rates  — ⚠️ DEFERRED to Phase 76
-- Source: 202604230004_phase73_evaluate_dynamic_rates_rpc.sql:174
-- Sig: (date, date)
-- Callers:
--   - src/lib/dynamic-rules/service.ts:918 (server lib, service_role) — safe
--   - pg_cron job in 202604230005_phase73_pg_cron_schedule.sql:56-72 — UNCERTAIN
--     (Supabase pg_cron role privileges not verified on our tier)
-- Decision 2026-04-24 (Lead): DEFER to Phase 76 with dedicated staging test.
-- Phase 73 is also on DO NOT TOUCH list (Inventory §5.3).
-- DO NOT UNCOMMENT.
-- ============================================================================

COMMIT;
