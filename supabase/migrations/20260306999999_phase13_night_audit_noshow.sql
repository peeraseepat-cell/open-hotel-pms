-- ============================================================
-- Phase 13: Night Audit + No-Show + Dashboard KPI
-- ============================================================

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS no_show_fee numeric(10,2) DEFAULT NULL;

COMMENT ON COLUMN reservations.no_show_fee IS
  'Optional no-show penalty amount. NULL = no fee. Set per booking.';

ALTER TABLE daily_snapshots
  ADD COLUMN IF NOT EXISTS no_show_count int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS no_show_fee_total numeric(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pos_revenue numeric(12,2) DEFAULT 0;

COMMENT ON COLUMN daily_snapshots.no_show_count IS
  'Number of reservations marked no-show on this business date.';
COMMENT ON COLUMN daily_snapshots.no_show_fee_total IS
  'Total no-show fees charged on this business date.';
COMMENT ON COLUMN daily_snapshots.pos_revenue IS
  'POS revenue for this business date (from pos_orders completed).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'daily_snapshots'
      AND column_name = 'eod_run_by'
  ) THEN
    ALTER TABLE daily_snapshots
      ADD COLUMN eod_run_by uuid REFERENCES profiles(user_id);
  END IF;
END $$;

COMMENT ON COLUMN folio_payments.revenue_category IS
  'Valid: room_revenue, pos_revenue, extra_charge, deposit, no_show_fee';

CREATE INDEX IF NOT EXISTS idx_reservations_noshow_pending
  ON reservations (checkin_date, status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_daily_snapshots_date_desc
  ON daily_snapshots (business_date DESC);
