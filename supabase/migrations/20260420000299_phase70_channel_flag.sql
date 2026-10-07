-- Phase 70: Monthly Audit channel flag layer
-- Additive tax-invoice channel override for abbreviated tax invoices.

CREATE TABLE IF NOT EXISTS public.monthly_audit_channel_flag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_period_id uuid NOT NULL REFERENCES public.monthly_audit_periods(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES public.monthly_audit_entries(id) ON DELETE CASCADE,
  actual_channel text NOT NULL CHECK (actual_channel IN ('ota','walkin','direct','agent')),
  tax_invoice_channel text NOT NULL CHECK (tax_invoice_channel IN ('ota','walkin','direct','agent')),
  reason text,
  flagged_by_user_id uuid REFERENCES auth.users(id),
  flagged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id)
);

COMMENT ON TABLE public.monthly_audit_channel_flag
  IS 'Phase 70: additive channel override for abbreviated tax invoices; PMS reservation source remains unchanged.';

CREATE INDEX IF NOT EXISTS idx_macf_period
  ON public.monthly_audit_channel_flag(audit_period_id);

CREATE INDEX IF NOT EXISTS idx_macf_tax_channel
  ON public.monthly_audit_channel_flag(audit_period_id, tax_invoice_channel);

ALTER TABLE public.monthly_audit_channel_flag ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS macf_select ON public.monthly_audit_channel_flag;
CREATE POLICY macf_select ON public.monthly_audit_channel_flag
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS macf_modify ON public.monthly_audit_channel_flag;
CREATE POLICY macf_modify ON public.monthly_audit_channel_flag
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ));
