-- Phase 42: Admin Corrections — Compensating Entry approach
-- Adds correction tracking to folio_payments + admin_corrections audit table
-- Design: NO soft-delete void — instead insert reversal rows (compensating entries)
-- This means ALL existing queries continue to work without modification

-- ─── 1. Correction columns on folio_payments ────────────────────────

-- Void tracking: reversal row points back to original
ALTER TABLE folio_payments
  ADD COLUMN IF NOT EXISTS is_void_reversal BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE folio_payments
  ADD COLUMN IF NOT EXISTS void_of UUID REFERENCES folio_payments(id);

-- Adjustment tracking: correction row points back to what it corrects
ALTER TABLE folio_payments
  ADD COLUMN IF NOT EXISTS is_correction BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE folio_payments
  ADD COLUMN IF NOT EXISTS correction_ref UUID REFERENCES folio_payments(id);
ALTER TABLE folio_payments
  ADD COLUMN IF NOT EXISTS correction_reason TEXT;

-- Index for finding void/correction chains
CREATE INDEX IF NOT EXISTS idx_folio_payments_void_of
  ON folio_payments(void_of) WHERE void_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_folio_payments_correction_ref
  ON folio_payments(correction_ref) WHERE correction_ref IS NOT NULL;

-- ─── 2. Folio reopen flag on reservations ───────────────────────────

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS folio_reopened BOOLEAN NOT NULL DEFAULT false;

-- ─── 3. Admin corrections audit table ───────────────────────────────

CREATE TABLE IF NOT EXISTS admin_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL REFERENCES reservations(id),
  action TEXT NOT NULL CHECK (action IN (
    'void', 'adjustment', 'reinstate',
    'reopen_folio', 'close_folio', 'transfer_payment'
  )),
  actor_user_id UUID NOT NULL REFERENCES profiles(user_id),
  before_snapshot JSONB NOT NULL DEFAULT '{}',
  after_snapshot JSONB NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL,
  related_payment_ids UUID[] DEFAULT '{}',
  business_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_corrections_reservation
  ON admin_corrections(reservation_id);
CREATE INDEX IF NOT EXISTS idx_admin_corrections_created
  ON admin_corrections(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_corrections_action
  ON admin_corrections(action);

-- RLS
ALTER TABLE admin_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_corrections_service ON admin_corrections
  FOR ALL USING (true) WITH CHECK (true);

-- ─── 4. Guard: prevent double-void ──────────────────────────────────
-- A payment that already has a void reversal cannot be voided again
-- Enforced at application layer, but this partial unique index is a safety net
CREATE UNIQUE INDEX IF NOT EXISTS idx_folio_payments_void_of_unique
  ON folio_payments(void_of) WHERE void_of IS NOT NULL;
