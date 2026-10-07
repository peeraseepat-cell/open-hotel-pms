-- Phase 70: Pre-generate abbreviated invoice override state

CREATE TABLE IF NOT EXISTS public.abbreviated_invoice_override (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_period_id uuid NOT NULL REFERENCES public.monthly_audit_periods(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES public.monthly_audit_entries(id) ON DELETE CASCADE,
  night_date date NOT NULL,
  decision text NOT NULL CHECK (decision IN ('include_this_month','carry_to_next','excluded_full_tax')),
  reason text,
  set_by_user_id uuid REFERENCES auth.users(id),
  set_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, night_date)
);

COMMENT ON TABLE public.abbreviated_invoice_override
  IS 'Phase 70: per-night carry/include/exclude decision before abbreviated tax invoice generation.';

CREATE TABLE IF NOT EXISTS public.abbreviated_row_shift_override (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_period_id uuid NOT NULL REFERENCES public.monthly_audit_periods(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES public.monthly_audit_entries(id) ON DELETE CASCADE,
  tax_group char(1) NOT NULL CHECK (tax_group IN ('A','B','C','D','E')),
  unit_price numeric(10,2) NOT NULL CHECK (unit_price >= 0),
  quantity int NOT NULL CHECK (quantity > 0),
  original_date date NOT NULL,
  target_date date NOT NULL,
  reason text,
  set_by_user_id uuid REFERENCES auth.users(id),
  set_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.abbreviated_row_shift_override
  IS 'Phase 70: manual pre-generate row movement between issue dates.';

CREATE INDEX IF NOT EXISTS idx_aio_period_date
  ON public.abbreviated_invoice_override(audit_period_id, night_date);

CREATE INDEX IF NOT EXISTS idx_arso_period_target
  ON public.abbreviated_row_shift_override(audit_period_id, target_date);

CREATE INDEX IF NOT EXISTS idx_arso_entry_original
  ON public.abbreviated_row_shift_override(entry_id, original_date);

ALTER TABLE public.abbreviated_invoice_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.abbreviated_row_shift_override ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aio_select ON public.abbreviated_invoice_override;
CREATE POLICY aio_select ON public.abbreviated_invoice_override
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS aio_modify ON public.abbreviated_invoice_override;
CREATE POLICY aio_modify ON public.abbreviated_invoice_override
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ));

DROP POLICY IF EXISTS arso_select ON public.abbreviated_row_shift_override;
CREATE POLICY arso_select ON public.abbreviated_row_shift_override
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS arso_modify ON public.abbreviated_row_shift_override;
CREATE POLICY arso_modify ON public.abbreviated_row_shift_override
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ));
