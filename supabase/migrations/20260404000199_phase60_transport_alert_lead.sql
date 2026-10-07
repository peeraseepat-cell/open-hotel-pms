alter table public.hotel_settings
add column if not exists transport_alert_lead_min integer not null default 60;

update public.hotel_settings
set transport_alert_lead_min = coalesce(transport_alert_lead_min, 60)
where id = 1;
