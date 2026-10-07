-- Tax invoice coverage/split hotfix.
-- Adds metadata for Admin-managed prepayment/balance invoices and removes the
-- one-issued-invoice-per-reservation database constraint in favor of API guards.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS invoice_kind text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS split_group_id uuid,
  ADD COLUMN IF NOT EXISTS coverage_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS coverage_note text,
  ADD COLUMN IF NOT EXISTS manual_issue_date_reason text;

DO $$
BEGIN
  ALTER TABLE public.invoices
    ADD CONSTRAINT invoices_invoice_kind_check
    CHECK (invoice_kind IN ('standard', 'prepayment', 'balance'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

UPDATE public.invoices
SET
  invoice_kind = COALESCE(NULLIF(invoice_kind, ''), 'standard'),
  coverage_amount = COALESCE(coverage_amount, grand_total)
WHERE invoice_kind IS NULL
   OR invoice_kind = ''
   OR coverage_amount IS NULL;

DROP INDEX IF EXISTS public.idx_invoices_reservation_issued_unique;

CREATE INDEX IF NOT EXISTS idx_invoices_reservation_status_kind
  ON public.invoices(reservation_id, status, invoice_kind);

CREATE INDEX IF NOT EXISTS idx_invoices_split_group
  ON public.invoices(split_group_id)
  WHERE split_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_invoice_kind
  ON public.invoices(invoice_kind);

COMMENT ON COLUMN public.invoices.invoice_kind IS
  'Tax invoice type: standard full-coverage invoice, prepayment split, or balance split.';
COMMENT ON COLUMN public.invoices.split_group_id IS
  'Groups the Admin-created prepayment and balance invoices for the same stay coverage.';
COMMENT ON COLUMN public.invoices.coverage_amount IS
  'VAT-inclusive amount covered/printed by this invoice after booking discounts.';
COMMENT ON COLUMN public.invoices.coverage_note IS
  'Short printed/internal note for coverage-based invoices.';
COMMENT ON COLUMN public.invoices.manual_issue_date_reason IS
  'Admin audit note when a split invoice is issued using a manually selected issue date.';
