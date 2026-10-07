ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS cancelled_invoice_no text;

COMMENT ON COLUMN public.invoices.cancelled_invoice_no IS
  'Stores the previous invoice number for cancelled invoices when the number is released for reuse by the next invoice.';
