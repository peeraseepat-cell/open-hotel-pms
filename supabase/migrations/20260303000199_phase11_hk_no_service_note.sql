begin;

alter table public.housekeeping_tasks
  add column if not exists no_service_note text,
  add column if not exists no_service_marked_at timestamptz,
  add column if not exists no_service_marked_by text;

comment on column public.housekeeping_tasks.no_service_note is
  'Optional operational note for no-service requests set by Front Desk or housekeeper';

comment on column public.housekeeping_tasks.no_service_marked_at is
  'Timestamp when no-service flag was set from Room Diary or maid flow';

comment on column public.housekeeping_tasks.no_service_marked_by is
  'Actor label who marked no-service (e.g., Front Desk)';

commit;
