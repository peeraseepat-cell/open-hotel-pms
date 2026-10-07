ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS remark text;

COMMENT ON COLUMN public.invoices.remark IS
  'Customer-facing remark printed in the full tax invoice remark box.';
