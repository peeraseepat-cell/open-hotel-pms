alter table public.hotel_settings
add column if not exists ui_event_log_capture_emails text not null default 'ops@example.com';

update public.hotel_settings
set ui_event_log_capture_emails = coalesce(nullif(trim(ui_event_log_capture_emails), ''), 'ops@example.com')
where id = 1;

alter table public.ui_event_logs
add column if not exists actor_email text;
