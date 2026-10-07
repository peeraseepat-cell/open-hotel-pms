-- Phase 47: Simple Receipt
-- Lightweight receipt record for audit trail (no VAT breakdown needed)

-- 1) receipts table
CREATE TABLE IF NOT EXISTS public.receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no text UNIQUE NOT NULL,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id),
  guest_name text NOT NULL,
  room_numbers text[] NOT NULL DEFAULT '{}',
  grand_total numeric(12,2) NOT NULL DEFAULT 0,
  language text NOT NULL DEFAULT 'th' CHECK (language IN ('th', 'en')),
  printed_at timestamptz NOT NULL DEFAULT now(),
  printed_by text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_receipts_reservation
  ON public.receipts(reservation_id);
CREATE INDEX IF NOT EXISTS idx_receipts_printed_at
  ON public.receipts(printed_at DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_guest_name
  ON public.receipts(guest_name);

-- updated_at trigger not needed (receipts are immutable records)

-- 2) Receipt number generator: RCYY + min 3 digits (e.g. RC26001)
CREATE OR REPLACE FUNCTION public.next_receipt_no(p_yy text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_yy text;
  v_prefix text;
  v_last_seq bigint;
  v_next_seq bigint;
  v_width int;
BEGIN
  v_yy := COALESCE(NULLIF(trim(p_yy), ''), to_char(timezone('Asia/Bangkok', now())::date, 'YY'));
  IF v_yy !~ '^\d{2}$' THEN
    RAISE EXCEPTION 'next_receipt_no(p_yy) expects 2 digits (YY), got: %', p_yy;
  END IF;

  v_prefix := 'RC' || v_yy;

  SELECT COALESCE(MAX(CAST(SUBSTRING(receipt_no FROM 5) AS bigint)), 0)
    INTO v_last_seq
  FROM public.receipts
  WHERE receipt_no LIKE v_prefix || '%'
    AND receipt_no ~ ('^' || v_prefix || '[0-9]+$');

  v_next_seq := v_last_seq + 1;
  v_width := GREATEST(3, LENGTH(v_next_seq::text));

  RETURN v_prefix || LPAD(v_next_seq::text, v_width, '0');
END;
$$;

-- 3) RLS
ALTER TABLE public.receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS receipts_service ON public.receipts;
CREATE POLICY receipts_service ON public.receipts
  FOR ALL USING (true) WITH CHECK (true);
