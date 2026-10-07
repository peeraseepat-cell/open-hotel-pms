-- Phase 46: Tax Invoice Foundation
-- Adds tax invoice schema inside PMS and invoice number generator.

-- 1) Seller profile columns on hotel_settings (snapshot source at issue time)
ALTER TABLE public.hotel_settings
  ADD COLUMN IF NOT EXISTS company_name text,
  ADD COLUMN IF NOT EXISTS company_name_en text,
  ADD COLUMN IF NOT EXISTS company_tax_id text,
  ADD COLUMN IF NOT EXISTS company_address text,
  ADD COLUMN IF NOT EXISTS company_address_en text,
  ADD COLUMN IF NOT EXISTS company_branch text,
  ADD COLUMN IF NOT EXISTS company_phone text;

-- Seed defaults for OpenHotel (safe: only fill empty fields)
UPDATE public.hotel_settings
SET
  company_name = COALESCE(NULLIF(company_name, ''), 'บริษัท ตัวอย่าง จำกัด'),
  company_name_en = COALESCE(NULLIF(company_name_en, ''), 'Example Co., Ltd.'),
  company_tax_id = COALESCE(NULLIF(company_tax_id, ''), '0000000000000'),
  company_address = COALESCE(NULLIF(company_address, ''), '000/00 ถนนตัวอย่าง13 ต.ตัวอย่าง อ.เมือง จ.ตัวอย่าง 00000'),
  company_address_en = COALESCE(NULLIF(company_address_en, ''), '000/00 Example 13 Road, Example, Mueang, Example Province 00000'),
  company_branch = COALESCE(NULLIF(company_branch, ''), 'สำนักงานใหญ่'),
  company_phone = COALESCE(NULLIF(company_phone, ''), '000-000-0000')
WHERE id = 1;

-- 2) Guest tax profiles
CREATE TABLE IF NOT EXISTS public.guest_tax_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_profile_id uuid REFERENCES public.guest_profiles(id),
  tax_id text NOT NULL,
  company_name text NOT NULL,
  address text,
  branch text NOT NULL DEFAULT 'สำนักงานใหญ่',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_passport boolean NOT NULL DEFAULT false,
  CONSTRAINT guest_tax_profiles_tax_id_check CHECK (
    (is_passport = true AND length(tax_id) >= 1)
    OR (is_passport = false AND tax_id ~ '^[0-9]{13}$')
  )
);

CREATE INDEX IF NOT EXISTS idx_guest_tax_profiles_guest
  ON public.guest_tax_profiles(guest_profile_id);
CREATE INDEX IF NOT EXISTS idx_guest_tax_profiles_tax_id
  ON public.guest_tax_profiles(tax_id);
CREATE INDEX IF NOT EXISTS idx_guest_tax_profiles_company_name
  ON public.guest_tax_profiles(company_name);

-- 3) Invoices
CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no text,
  reservation_id uuid NOT NULL REFERENCES public.reservations(id),
  language text NOT NULL DEFAULT 'th' CHECK (language IN ('th', 'en')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'cancelled')),
  issue_date date NOT NULL DEFAULT (timezone('Asia/Bangkok', now()))::date,

  -- Customer snapshot (frozen at issue time)
  customer_name text NOT NULL,
  customer_tax_id text,
  customer_address text,
  customer_branch text,
  guest_tax_profile_id uuid REFERENCES public.guest_tax_profiles(id),

  -- Booking snapshot
  booking_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Financial (VAT inclusive model)
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  vat_rate numeric(5,4) NOT NULL DEFAULT 0.07,
  vat_amount numeric(12,2) NOT NULL DEFAULT 0,
  grand_total numeric(12,2) NOT NULL DEFAULT 0,
  discount numeric(12,2) NOT NULL DEFAULT 0,

  -- Seller snapshot
  seller_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Audit
  issued_by text,
  cancelled_at timestamptz,
  cancelled_by text,
  cancel_reason text,
  updated_by text,
  update_reason text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  is_passport boolean NOT NULL DEFAULT false,
  CONSTRAINT invoices_customer_tax_id_check CHECK (
    customer_tax_id IS NULL
    OR (is_passport = true AND length(customer_tax_id) >= 1)
    OR (is_passport = false AND customer_tax_id ~ '^[0-9]{13}$')
  )
);

-- Invoice number unique only when assigned (draft has NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_invoice_no_unique
  ON public.invoices(invoice_no)
  WHERE invoice_no IS NOT NULL;

-- One issued invoice per reservation
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_reservation_issued_unique
  ON public.invoices(reservation_id)
  WHERE status = 'issued';

CREATE INDEX IF NOT EXISTS idx_invoices_issue_date
  ON public.invoices(issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status
  ON public.invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_customer_name
  ON public.invoices(customer_name);

-- updated_at triggers
DROP TRIGGER IF EXISTS trg_guest_tax_profiles_updated_at ON public.guest_tax_profiles;
CREATE TRIGGER trg_guest_tax_profiles_updated_at
BEFORE UPDATE ON public.guest_tax_profiles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_invoices_updated_at ON public.invoices;
CREATE TRIGGER trg_invoices_updated_at
BEFORE UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 4) Invoice number generator (IVYY + variable-digit sequence, min 3)
CREATE OR REPLACE FUNCTION public.next_invoice_no(p_yy text)
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
    RAISE EXCEPTION 'next_invoice_no(p_yy) expects 2 digits (YY), got: %', p_yy;
  END IF;

  v_prefix := 'IV' || v_yy;

  SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_no FROM 5) AS bigint)), 0)
    INTO v_last_seq
  FROM public.invoices
  WHERE invoice_no LIKE v_prefix || '%'
    AND invoice_no ~ ('^' || v_prefix || '[0-9]+$');

  v_next_seq := v_last_seq + 1;
  v_width := GREATEST(3, LENGTH(v_next_seq::text));

  RETURN v_prefix || LPAD(v_next_seq::text, v_width, '0');
END;
$$;

-- 5) RLS (service-role friendly; route-level auth remains source of truth)
ALTER TABLE public.guest_tax_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS guest_tax_profiles_service ON public.guest_tax_profiles;
CREATE POLICY guest_tax_profiles_service ON public.guest_tax_profiles
  FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoices_service ON public.invoices;
CREATE POLICY invoices_service ON public.invoices
  FOR ALL USING (true) WITH CHECK (true);
