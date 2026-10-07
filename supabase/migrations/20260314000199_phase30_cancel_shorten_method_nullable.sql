-- Phase 30 hotfix prerequisite
-- Fee rows settled from pre-paid are record-only traces and must not carry a payment method.

ALTER TABLE public.folio_payments
  ALTER COLUMN method DROP NOT NULL;

COMMENT ON COLUMN public.folio_payments.method IS
  'Payment method for real money movement rows. Can be NULL for record-only settlement traces (e.g., pre-paid fee deduction).';

