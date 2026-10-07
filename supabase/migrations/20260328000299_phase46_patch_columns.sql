-- Phase 46 Patch: Add missing columns for existing installs
-- Adds is_passport to guest_tax_profiles + invoices
-- Adds company_name_en + company_address_en to hotel_settings

-- 1) hotel_settings: English seller columns
ALTER TABLE public.hotel_settings
  ADD COLUMN IF NOT EXISTS company_name_en text,
  ADD COLUMN IF NOT EXISTS company_address_en text;

-- Seed English values (only fill if empty)
UPDATE public.hotel_settings
SET
  company_name_en = COALESCE(NULLIF(company_name_en, ''), 'Example Co., Ltd.'),
  company_address_en = COALESCE(NULLIF(company_address_en, ''), '000/00 Example 13 Road, Example, Mueang, Example Province 00000')
WHERE id = 1;

-- 2) guest_tax_profiles: passport flag
ALTER TABLE public.guest_tax_profiles
  ADD COLUMN IF NOT EXISTS is_passport boolean NOT NULL DEFAULT false;

-- Drop old strict 13-digit constraint if it exists, replace with passport-aware one
ALTER TABLE public.guest_tax_profiles
  DROP CONSTRAINT IF EXISTS guest_tax_profiles_tax_id_digits,
  DROP CONSTRAINT IF EXISTS guest_tax_profiles_tax_id_check;

ALTER TABLE public.guest_tax_profiles
  ADD CONSTRAINT guest_tax_profiles_tax_id_check CHECK (
    (is_passport = true AND length(tax_id) >= 1)
    OR (is_passport = false AND tax_id ~ '^[0-9]{13}$')
  );

-- 3) invoices: passport flag
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS is_passport boolean NOT NULL DEFAULT false;

-- Drop old strict constraint, replace with passport-aware one
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_customer_tax_id_digits,
  DROP CONSTRAINT IF EXISTS invoices_customer_tax_id_check;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_customer_tax_id_check CHECK (
    customer_tax_id IS NULL
    OR (is_passport = true AND length(customer_tax_id) >= 1)
    OR (is_passport = false AND customer_tax_id ~ '^[0-9]{13}$')
  );
