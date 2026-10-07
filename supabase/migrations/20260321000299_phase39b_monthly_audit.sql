-- Phase 39B: Monthly Audit & Correction System
-- Snapshot + correction layer for end-of-month financial reconciliation

-- ============================================================
-- 1. Add tax_invoice_requested to reservations
-- ============================================================
ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS tax_invoice_requested boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.reservations.tax_invoice_requested
  IS 'True when guest requests full tax invoice (ใบกำกับภาษีเต็มรูปแบบ)';

-- ============================================================
-- 2. monthly_audit_periods — tracks audit lifecycle per month
-- ============================================================
CREATE TABLE IF NOT EXISTS public.monthly_audit_periods (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year          smallint NOT NULL,
  month         smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','reviewing','audited','locked')),
  closed_at     timestamptz,
  closed_by     uuid,
  audited_at    timestamptz,
  audited_by    uuid,
  summary_json  jsonb,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(year, month)
);

COMMENT ON TABLE public.monthly_audit_periods
  IS 'Monthly audit lifecycle: open → reviewing → audited → locked';

-- RLS
ALTER TABLE public.monthly_audit_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY map_select ON public.monthly_audit_periods
  FOR SELECT TO authenticated USING (true);

CREATE POLICY map_insert ON public.monthly_audit_periods
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ));

CREATE POLICY map_update ON public.monthly_audit_periods
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ));

-- ============================================================
-- 3. monthly_audit_entries — snapshot per reservation
-- ============================================================
CREATE TABLE IF NOT EXISTS public.monthly_audit_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id             uuid NOT NULL REFERENCES public.monthly_audit_periods(id) ON DELETE CASCADE,
  reservation_id        uuid NOT NULL,
  booking_code          text,
  guest_name            text NOT NULL,
  source                text NOT NULL,
  checkin_date          date NOT NULL,
  checkout_date         date NOT NULL,
  room_number           text,
  room_type_name        text,
  total_nights          smallint NOT NULL DEFAULT 1,

  -- Revenue breakdown
  room_revenue          numeric(12,2) NOT NULL DEFAULT 0,
  extra_revenue         numeric(12,2) NOT NULL DEFAULT 0,
  pos_revenue           numeric(12,2) NOT NULL DEFAULT 0,
  total_revenue         numeric(12,2) NOT NULL DEFAULT 0,

  -- Payment breakdown by method
  paid_cash             numeric(12,2) NOT NULL DEFAULT 0,
  paid_transfer         numeric(12,2) NOT NULL DEFAULT 0,
  paid_credit_card      numeric(12,2) NOT NULL DEFAULT 0,
  paid_other            numeric(12,2) NOT NULL DEFAULT 0,
  total_paid            numeric(12,2) NOT NULL DEFAULT 0,

  -- Refund & balance
  refund_total          numeric(12,2) NOT NULL DEFAULT 0,
  outstanding           numeric(12,2) NOT NULL DEFAULT 0,

  -- Tax invoice
  tax_invoice_requested boolean NOT NULL DEFAULT false,
  tax_invoice_name      text,
  tax_id                text,

  -- Guest identity (for TM.30 / รร3 prep)
  nationality           text,
  passport_number       text,
  id_card_number        text,
  guest_count           smallint NOT NULL DEFAULT 1,

  -- Metadata
  raw_snapshot_json     jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE(period_id, reservation_id)
);

COMMENT ON TABLE public.monthly_audit_entries
  IS 'Frozen snapshot of each checked-out reservation for monthly audit';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mae_period ON public.monthly_audit_entries(period_id);
CREATE INDEX IF NOT EXISTS idx_mae_reservation ON public.monthly_audit_entries(reservation_id);
CREATE INDEX IF NOT EXISTS idx_mae_source ON public.monthly_audit_entries(period_id, source);
CREATE INDEX IF NOT EXISTS idx_mae_checkout ON public.monthly_audit_entries(period_id, checkout_date);

-- RLS
ALTER TABLE public.monthly_audit_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY mae_select ON public.monthly_audit_entries
  FOR SELECT TO authenticated USING (true);

CREATE POLICY mae_insert ON public.monthly_audit_entries
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ));

-- No direct UPDATE — corrections go through monthly_audit_corrections table

-- ============================================================
-- 4. monthly_audit_corrections — tracked edits by FO/Accountant
-- ============================================================
CREATE TABLE IF NOT EXISTS public.monthly_audit_corrections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id        uuid NOT NULL REFERENCES public.monthly_audit_entries(id) ON DELETE CASCADE,
  field_name      text NOT NULL,
  old_value       text,
  new_value       text,
  reason          text,
  corrected_by    uuid,
  corrected_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.monthly_audit_corrections
  IS 'Tracked corrections to monthly audit entries. Each row = one field change.';

CREATE INDEX IF NOT EXISTS idx_mac_entry ON public.monthly_audit_corrections(entry_id);
CREATE INDEX IF NOT EXISTS idx_mac_corrected_at ON public.monthly_audit_corrections(corrected_at);

-- RLS
ALTER TABLE public.monthly_audit_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY mac_select ON public.monthly_audit_corrections
  FOR SELECT TO authenticated USING (true);

CREATE POLICY mac_insert ON public.monthly_audit_corrections
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ));

-- ============================================================
-- 5. Index on reservations for monthly audit scope query
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_reservations_checkout_status
  ON public.reservations(checkout_date, status)
  WHERE status = 'checked_out';

CREATE INDEX IF NOT EXISTS idx_reservations_tax_invoice
  ON public.reservations(tax_invoice_requested)
  WHERE tax_invoice_requested = true;
