-- Phase 70: deterministic abbreviated tax invoice number

CREATE OR REPLACE FUNCTION public.next_abbreviated_invoice_no(
  p_date date,
  p_channel_group text
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_group text;
  v_prefix text;
  v_be_year int;
  v_no text;
BEGIN
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'next_abbreviated_invoice_no expects p_date';
  END IF;

  v_group := lower(coalesce(trim(p_channel_group), ''));
  IF v_group NOT IN ('ota', 'walkin_direct') THEN
    RAISE EXCEPTION 'next_abbreviated_invoice_no expects channel group ota or walkin_direct, got: %', p_channel_group;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('phase70-abbr-no:' || v_group || ':' || p_date::text));

  v_prefix := CASE WHEN v_group = 'walkin_direct' THEN 'W' ELSE '' END;
  v_be_year := extract(year from p_date)::int + 543;
  v_no := v_prefix
    || lpad((v_be_year % 100)::text, 2, '0')
    || to_char(p_date, 'MMDD');

  IF EXISTS (
    SELECT 1
    FROM public.abbreviated_tax_invoice i
    WHERE i.invoice_no = v_no
      AND i.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Active abbreviated invoice number already exists: %', v_no
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.abbreviated_tax_invoice i
    WHERE i.issue_date = p_date
      AND i.channel_group = v_group
      AND i.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Active abbreviated invoice already exists for % / %', p_date, v_group
      USING ERRCODE = '23505';
  END IF;

  RETURN v_no;
END;
$$;

COMMENT ON FUNCTION public.next_abbreviated_invoice_no(date, text)
  IS 'Phase 70: returns exact YYMMDD / WYYMMDD abbreviated tax invoice number using Buddhist year. Cancelled invoices do not block reuse.';
