alter table public.hotel_settings
  add column if not exists identity_alert_under18_thai_id_enabled boolean not null default true,
  add column if not exists identity_alert_under18_passport_enabled boolean not null default true,
  add column if not exists identity_alert_over18_thai_id_enabled boolean not null default true,
  add column if not exists identity_alert_over18_passport_enabled boolean not null default true,
  add column if not exists identity_alert_birthday_enabled boolean not null default true;

update public.hotel_settings
set
  identity_alert_under18_thai_id_enabled = coalesce(identity_alert_under18_thai_id_enabled, true),
  identity_alert_under18_passport_enabled = coalesce(identity_alert_under18_passport_enabled, true),
  identity_alert_over18_thai_id_enabled = coalesce(identity_alert_over18_thai_id_enabled, true),
  identity_alert_over18_passport_enabled = coalesce(identity_alert_over18_passport_enabled, true),
  identity_alert_birthday_enabled = coalesce(identity_alert_birthday_enabled, true)
where id = 1;
