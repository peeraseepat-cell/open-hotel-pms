begin;

alter table public.lost_found_items
  alter column room_id drop not null,
  alter column room_number drop not null;

commit;
