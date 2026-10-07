-- repo parity for the 2026-07-25 anon-grant sweep.
--
-- Same class as 202607250002: Supabase's default ACL (pg_default_acl, grantors
-- postgres + supabase_admin, schema public) grants EXECUTE to anon directly at
-- function-creation time. These four SECURITY DEFINER functions were revoked
-- `from public` only in their original migrations, which deletes the PUBLIC ACL
-- entry and leaves the direct anon entry standing — silently, with no error.
-- They were therefore anon-executable via the public key.
--
-- Original revokes, for reference (all `from public`, none naming anon):
--   fn_round_price / fn_apply_action / fn_compute_group_occ
--     → 202604230004_phase73_evaluate_dynamic_rates_rpc.sql:669-671
--   invoke_ui_event_log_archive
--     → 20260531134927_ui_event_log_supabase_cron.sql:62
--
-- First applied by hand on a live database (2026-07-25). This file exists so the
-- repo matches it; it is SQL-only and changes no app behavior. REVOKE on an
-- absent grant is a no-op in PostgreSQL, so re-running this is safe.
--
-- Verified after apply by two independent read-backs, which
-- agree for all four: anon=f, authenticated=f, service_role=t.
-- service_role (and postgres, for invoke_ui_event_log_archive) keep EXECUTE:
-- these are called by the app's service-role client and by pg_cron, never by a
-- browser key.

revoke execute on function public.fn_round_price(numeric, text) from anon, authenticated;

revoke execute on function public.fn_apply_action(numeric, text, numeric) from anon, authenticated;

revoke execute on function public.fn_compute_group_occ(uuid, date, bigint) from anon, authenticated;

revoke execute on function public.invoke_ui_event_log_archive() from anon, authenticated;
