-- Phase 77: full tax invoice number format IVYYMMXX.
-- Example: issue_date 2026-04-01, first invoice of month => IV260401.
CREATE OR REPLACE FUNCTION public.next_invoice_no(p_yy text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_raw text;
  v_yymm text;
  v_prefix text;
  v_last_seq bigint;
  v_next_seq bigint;
  v_width int;
BEGIN
  v_raw := COALESCE(NULLIF(trim(p_yy), ''), to_char(timezone('Asia/Bangkok', now())::date, 'YYMM'));

  IF v_raw ~ '^\d{4}-\d{2}-\d{2}$' THEN
    v_yymm := to_char(v_raw::date, 'YYMM');
  ELSIF v_raw ~ '^\d{4}$' THEN
    v_yymm := v_raw;
  ELSIF v_raw ~ '^\d{2}$' THEN
    v_yymm := v_raw || to_char(timezone('Asia/Bangkok', now())::date, 'MM');
  ELSE
    RAISE EXCEPTION 'next_invoice_no(p_yy) expects YY, YYMM, or YYYY-MM-DD, got: %', p_yy;
  END IF;

  v_prefix := 'IV' || v_yymm;

  SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_no FROM 7) AS bigint)), 0)
    INTO v_last_seq
  FROM public.invoices
  WHERE invoice_no LIKE v_prefix || '%'
    AND invoice_no ~ ('^' || v_prefix || '[0-9]+$');

  v_next_seq := v_last_seq + 1;
  v_width := GREATEST(2, LENGTH(v_next_seq::text));

  RETURN v_prefix || LPAD(v_next_seq::text, v_width, '0');
END;
$$;

COMMENT ON FUNCTION public.next_invoice_no(text)
  IS 'Phase 77: returns full tax invoice number IVYYMMXX, resetting sequence per issue month. Accepts YY, YYMM, or YYYY-MM-DD for backwards compatibility.';
