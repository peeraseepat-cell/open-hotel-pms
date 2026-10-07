alter table public.hotel_settings
  add column if not exists night_audit_popup_snooze_min integer not null default 30;

alter table public.hotel_settings
  drop constraint if exists hotel_settings_night_audit_popup_snooze_min_check;

alter table public.hotel_settings
  add constraint hotel_settings_night_audit_popup_snooze_min_check
  check (night_audit_popup_snooze_min between 1 and 1440);
