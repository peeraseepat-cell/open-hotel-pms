-- ============================================================
-- Migration: Rate Change Log + Auto-Prune
-- Date:      2026-02-24
-- Purpose:
--   1. Create rate_change_log table (audit trail)
--   2. Create trigger: log every INSERT/UPDATE on rate_templates
--   3. Schedule nightly Cron job to prune rate_templates > 30 days old
-- ============================================================

-- ─── PRE-REQUISITE ──────────────────────────────────────────
-- Before running this migration, enable pg_cron in:
--   Supabase Dashboard → Database → Extensions → pg_cron → Enable
-- If pg_cron is NOT enabled, skip section 3 below.
-- ─────────────────────────────────────────────────────────────


-- ─── 1. RATE CHANGE LOG TABLE ────────────────────────────────
create table if not exists public.rate_change_log (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references public.rooms(id) on delete cascade,
  stay_date     date not null,
  old_price     numeric(10, 2),           -- null on first INSERT
  new_price     numeric(10, 2) not null,
  changed_by    uuid references public.profiles(user_id),
  operation     text not null check (operation in ('INSERT', 'UPDATE')),
  changed_at    timestamptz not null default timezone('utc', now())
);

-- Index for quick lookup: "what changed for room X on date Y?"
create index if not exists rate_change_log_room_date
  on public.rate_change_log (room_id, stay_date, changed_at desc);

-- Index for timeline view: "show me all changes in last 7 days"
create index if not exists rate_change_log_changed_at
  on public.rate_change_log (changed_at desc);

-- ─── 2. TRIGGER FUNCTION ─────────────────────────────────────
-- Fires AFTER INSERT OR UPDATE on rate_templates
-- Records old price (null on first insert) and new price

create or replace function public.fn_log_rate_change()
returns trigger
language plpgsql
security definer
as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.rate_change_log (
      room_id, stay_date, old_price, new_price, changed_by, operation
    ) values (
      NEW.room_id,
      NEW.stay_date,
      null,           -- no old price on first insert
      NEW.price,
      NEW.updated_by,
      'INSERT'
    );
  elsif TG_OP = 'UPDATE' then
    -- Only log if price actually changed
    if OLD.price is distinct from NEW.price then
      insert into public.rate_change_log (
        room_id, stay_date, old_price, new_price, changed_by, operation
      ) values (
        NEW.room_id,
        NEW.stay_date,
        OLD.price,
        NEW.price,
        NEW.updated_by,
        'UPDATE'
      );
    end if;
  end if;
  return NEW;
end;
$$;

-- Attach trigger to rate_templates
drop trigger if exists trg_rate_change_log on public.rate_templates;
create trigger trg_rate_change_log
  after insert or update
  on public.rate_templates
  for each row
  execute function public.fn_log_rate_change();


-- ─── 3. RLS POLICIES ─────────────────────────────────────────
alter table public.rate_change_log enable row level security;

-- Authenticated users can read the log
create policy "rate_change_log: auth read"
  on public.rate_change_log
  for select
  to authenticated
  using (true);

-- No direct insert/update/delete from client — only via trigger
create policy "rate_change_log: deny direct write"
  on public.rate_change_log
  for insert
  to authenticated
  with check (false);


-- ─── 4. CRON JOB — PRUNE OLD RATE TEMPLATES ──────────────────
-- ⚠️  REQUIRES pg_cron extension to be ENABLED first!
--     Supabase Dashboard → Database → Extensions → pg_cron
--
-- Runs every night at 03:00 UTC (10:00 Thailand time)
-- Deletes rate_templates rows where stay_date < 30 days ago
-- rate_change_log is NOT deleted — it is the permanent audit trail
--
-- Uncomment the lines below after enabling pg_cron:

-- select cron.schedule(
--   'rate-prune-old',                       -- job name (unique)
--   '0 3 * * *',                            -- every day at 03:00 UTC
--   $$
--     delete from public.rate_templates
--     where stay_date < current_date - interval '30 days';
--   $$
-- );


-- ─── VERIFY ───────────────────────────────────────────────────
-- After running, test with:
--
-- 1. Check table exists:
--    SELECT * FROM public.rate_change_log LIMIT 5;
--
-- 2. Manually trigger a rate update via the app's Bulk Update
--    then check:
--    SELECT * FROM public.rate_change_log ORDER BY changed_at DESC LIMIT 10;
--
-- 3. (After enabling pg_cron) list scheduled jobs:
--    SELECT * FROM cron.job;
