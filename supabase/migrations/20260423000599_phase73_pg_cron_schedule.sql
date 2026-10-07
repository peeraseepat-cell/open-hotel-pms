-- ============================================================================
-- Phase 73 · Migration 005 — pg_cron Schedule for Dynamic Rate Evaluation
-- ============================================================================
-- Owner: Agent B
-- Reviewer: Lead (P1 — schedule correctness, idempotence, tz correctness)
-- Depends on: 004 (evaluate_dynamic_rates function exists), Phase 72
--             app_settings (for dynamic_eval_window_days lookup)
--
-- LAYER 0 SKELETON — DO NOT APPLY UNTIL AGENT B FILLS BODY.
-- See WORK_ASSIGNMENT_PHASE73.md §5.5 for reference SQL.
--
-- Job:
--   jobname = 'phase73_dynamic_rate_eval'
--   cron    = '0 2 * * *'          -- 02:00 UTC = 09:00 Asia/Bangkok (B14)
--   command = SELECT public.evaluate_dynamic_rates(
--               CURRENT_DATE,
--               CURRENT_DATE + <app_settings.rate.dynamic_eval_window_days>::INT
--             );
--
-- Migration must:
--   1. CREATE EXTENSION IF NOT EXISTS pg_cron;
--   2. Unschedule any prior job named 'phase73_dynamic_rate_eval' (idempotent).
--   3. Schedule fresh via cron.schedule(...).
--
-- P1 invariants Lead will verify:
--   1. Migration is re-runnable (unschedule-then-schedule pattern).
--   2. Job command reads window from app_settings at runtime (not baked at
--      migration time) so admin edits take effect next run without a new
--      migration — even though schedule time itself is migration-locked (B15).
--   3. Supabase target tier supports pg_cron (Lead verifies on staging before
--      prod). If extension unavailable, Agent B raises to Lead — fallback:
--      Vercel Cron hitting /api/dynamic-rules/eval. This migration's failure
--      must NOT block prior Phase 73 migrations from running.
-- ============================================================================

-- Agent B: implement full migration below this line.

do $$
begin
  begin
    create extension if not exists pg_cron;
  exception
    when others then
      raise notice 'Phase 73: pg_cron extension unavailable (%). Skipping dynamic rate schedule migration.', sqlerrm;
      return;
  end;

  begin
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
      if exists (select 1 from cron.job where jobname = 'phase73_dynamic_rate_eval') then
        perform cron.unschedule(jobid)
        from cron.job
        where jobname = 'phase73_dynamic_rate_eval';
      end if;

      perform cron.schedule(
        'phase73_dynamic_rate_eval',
        '0 2 * * *',
        $job$
        select public.evaluate_dynamic_rates(
          current_date,
          current_date + coalesce(
            (
              select (value_json #>> '{}')::int
              from public.app_settings
              where key = 'rate.dynamic_eval_window_days'
            ),
            60
          )
        );
        $job$
      );

      execute $comment$
        comment on extension pg_cron is
        'Phase 73 scheduler for dynamic rate evaluation. Job: phase73_dynamic_rate_eval @ 02:00 UTC daily.';
      $comment$;
    end if;
  exception
    when others then
      raise notice 'Phase 73: unable to schedule pg_cron job (%). Dynamic rate schedule skipped.', sqlerrm;
  end;
end;
$$;
