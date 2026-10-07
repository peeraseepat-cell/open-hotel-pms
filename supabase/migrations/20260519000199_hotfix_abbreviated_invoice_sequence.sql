-- Hotfix: abbreviated invoice numbers must run continuously by actual issued rows.
--
-- Room OTA:          YYMM + monthly sequence       e.g. 690401, 690402
-- Room Walk-in/Dir:  W + YYMM + monthly sequence   e.g. W690401, W690402
-- POS:               D + YYMM + monthly sequence   e.g. D690401, D690402
-- Day Use remains monthly: DY + YY + MM            e.g. DY6904

BEGIN;

CREATE OR REPLACE FUNCTION public.next_abbreviated_invoice_no(
  p_date date,
  p_channel_group text DEFAULT NULL,
  p_source_type public.abbreviated_source_type DEFAULT 'room'
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_group text;
  v_source public.abbreviated_source_type;
  v_be_year int;
  v_yy text;
  v_prefix text;
  v_month_prefix text;
  v_sequence int;
  v_no text;
BEGIN
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'next_abbreviated_invoice_no expects p_date';
  END IF;

  v_source := COALESCE(p_source_type, 'room');
  v_group := lower(nullif(trim(coalesce(p_channel_group, '')), ''));
  v_be_year := extract(year from p_date)::int + 543;
  v_yy := lpad((v_be_year % 100)::text, 2, '0');

  IF v_source = 'room' THEN
    IF v_group NOT IN ('ota', 'walkin_direct') THEN
      RAISE EXCEPTION 'room abbreviated invoice expects channel_group ota or walkin_direct, got: %', p_channel_group;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('hotfix-abbr-no:room:' || v_group || ':' || to_char(p_date, 'YYYY-MM')));

    v_prefix := CASE WHEN v_group = 'walkin_direct' THEN 'W' ELSE '' END;
    v_month_prefix := v_prefix || v_yy || to_char(p_date, 'MM');

    IF EXISTS (
      SELECT 1
      FROM public.abbreviated_tax_invoice i
      WHERE i.source_type = 'room'
        AND i.issue_date = p_date
        AND i.channel_group = v_group
        AND i.status <> 'cancelled'
    ) THEN
      RAISE EXCEPTION 'Active room abbreviated invoice already exists for % / %', p_date, v_group
        USING ERRCODE = '23505';
    END IF;
  ELSIF v_source = 'dayuse' THEN
    IF v_group IS NOT NULL THEN
      RAISE EXCEPTION 'dayuse abbreviated invoice expects NULL channel_group, got: %', p_channel_group;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('hotfix-abbr-no:dayuse:' || to_char(p_date, 'YYYY-MM')));

    v_no := 'DY' || v_yy || to_char(p_date, 'MM');

    IF EXISTS (
      SELECT 1
      FROM public.abbreviated_tax_invoice i
      WHERE i.source_type = 'dayuse'
        AND i.issue_date = p_date
        AND i.status <> 'cancelled'
    ) THEN
      RAISE EXCEPTION 'Active dayuse abbreviated invoice already exists for %', p_date
        USING ERRCODE = '23505';
    END IF;
  ELSIF v_source = 'pos' THEN
    IF v_group IS NOT NULL THEN
      RAISE EXCEPTION 'pos abbreviated invoice expects NULL channel_group, got: %', p_channel_group;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('hotfix-abbr-no:pos:' || to_char(p_date, 'YYYY-MM')));

    v_month_prefix := 'D' || v_yy || to_char(p_date, 'MM');

    IF EXISTS (
      SELECT 1
      FROM public.abbreviated_tax_invoice i
      WHERE i.source_type = 'pos'
        AND i.issue_date = p_date
        AND i.status <> 'cancelled'
    ) THEN
      RAISE EXCEPTION 'Active pos abbreviated invoice already exists for %', p_date
        USING ERRCODE = '23505';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported abbreviated invoice source_type: %', p_source_type;
  END IF;

  IF v_source IN ('room', 'pos') THEN
    v_sequence := 1;
    LOOP
      v_no := v_month_prefix || lpad(v_sequence::text, 2, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1
        FROM public.abbreviated_tax_invoice i
        WHERE i.invoice_no = v_no
          AND i.status <> 'cancelled'
      );
      v_sequence := v_sequence + 1;
      IF v_sequence > 9999 THEN
        RAISE EXCEPTION 'Could not allocate abbreviated invoice number for prefix %', v_month_prefix;
      END IF;
    END LOOP;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.abbreviated_tax_invoice i
    WHERE i.invoice_no = v_no
      AND i.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Active abbreviated invoice number already exists: %', v_no
      USING ERRCODE = '23505';
  END IF;

  RETURN v_no;
END;
$$;

COMMENT ON FUNCTION public.next_abbreviated_invoice_no(date, text, public.abbreviated_source_type)
  IS 'Hotfix: returns continuous monthly abbreviated invoice numbers by active issued rows. room => YYMMNN/WYYMMNN, dayuse => DYYYMM, pos => DYYMMNN.';

COMMIT;
