-- ============================================================
-- Migration: OTA Reference Number
-- Date:      2026-02-24
-- Purpose:
--   Add ota_ref to reservations — stores the OTA confirmation
--   code (e.g. Booking.com "1234567890") for reconciliation.
-- ============================================================

alter table public.reservations
  add column if not exists ota_ref text;

-- Index for quick lookup by OTA reference number
create index if not exists idx_reservations_ota_ref
  on public.reservations (ota_ref)
  where ota_ref is not null;

-- ============================================================
-- VERIFY:
--   SELECT id, booking_code, source, ota_ref
--   FROM public.reservations
--   WHERE source = 'ota'
--   ORDER BY created_at DESC LIMIT 5;
-- ============================================================
