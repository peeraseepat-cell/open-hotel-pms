-- Add Google Sheet Sync toggle to hotel_settings
ALTER TABLE public.hotel_settings
  ADD COLUMN IF NOT EXISTS google_sheet_sync_enabled boolean NOT NULL DEFAULT true;
