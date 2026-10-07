-- Phase 70: Abbreviated Tax Invoice head + lines

CREATE TABLE IF NOT EXISTS public.abbreviated_tax_invoice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no text NOT NULL,
  book_no int NOT NULL,
  issue_date date NOT NULL,
  channel_group text NOT NULL CHECK (channel_group IN ('ota','walkin_direct')),
  tax_invoice_channel text NOT NULL CHECK (tax_invoice_channel IN ('ota','walkin','direct','agent')),
  audit_period_id uuid NOT NULL REFERENCES public.monthly_audit_periods(id) ON DELETE RESTRICT,
  stay_date_from date NOT NULL,
  stay_date_to date NOT NULL,
  subtotal_inc_vat numeric(12,2) NOT NULL,
  subtotal_ex_vat numeric(12,2) NOT NULL,
  vat_rate numeric(4,2) NOT NULL DEFAULT 7.00,
  vat_amount numeric(12,2) NOT NULL,
  seller_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','cancelled')),
  generated_by_user_id uuid REFERENCES auth.users(id),
  generated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_reason text,
  cancelled_at timestamptz
);

COMMENT ON TABLE public.abbreviated_tax_invoice
  IS 'Phase 70: daily abbreviated tax invoice, one invoice per issue_date and channel group.';

COMMENT ON COLUMN public.abbreviated_tax_invoice.invoice_no
  IS 'Exact legacy format: YYMMDD for OTA/agent, WYYMMDD for walkin/direct. YY is Buddhist year modulo 100.';

CREATE TABLE IF NOT EXISTS public.abbreviated_tax_invoice_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.abbreviated_tax_invoice(id) ON DELETE CASCADE,
  line_order int NOT NULL,
  tax_group char(1) NOT NULL CHECK (tax_group IN ('A','B','C','D','E')),
  label_th text NOT NULL,
  quantity int NOT NULL CHECK (quantity > 0),
  unit_price numeric(10,2) NOT NULL CHECK (unit_price >= 0),
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  source_entry_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  shifted_from_date date,
  shifted_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_abbr_invoice_no_active
  ON public.abbreviated_tax_invoice(invoice_no)
  WHERE status <> 'cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS idx_abbr_invoice_day_channel_active
  ON public.abbreviated_tax_invoice(audit_period_id, issue_date, channel_group)
  WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_abbr_invoice_period
  ON public.abbreviated_tax_invoice(audit_period_id, channel_group, issue_date);

CREATE INDEX IF NOT EXISTS idx_abbr_invoice_status
  ON public.abbreviated_tax_invoice(status, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_abbr_invoice_line_invoice
  ON public.abbreviated_tax_invoice_line(invoice_id, line_order);

ALTER TABLE public.abbreviated_tax_invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.abbreviated_tax_invoice_line ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ati_select ON public.abbreviated_tax_invoice;
CREATE POLICY ati_select ON public.abbreviated_tax_invoice
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS ati_modify ON public.abbreviated_tax_invoice;
CREATE POLICY ati_modify ON public.abbreviated_tax_invoice
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ));

DROP POLICY IF EXISTS atil_select ON public.abbreviated_tax_invoice_line;
CREATE POLICY atil_select ON public.abbreviated_tax_invoice_line
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS atil_modify ON public.abbreviated_tax_invoice_line;
CREATE POLICY atil_modify ON public.abbreviated_tax_invoice_line
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ));
