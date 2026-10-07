begin;

alter table public.logbook_note_links
  add column if not exists room_link_mode text not null default 'static';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_logbook_note_links_room_link_mode'
  ) then
    alter table public.logbook_note_links
      add constraint chk_logbook_note_links_room_link_mode
      check (room_link_mode in ('static', 'dynamic'));
  end if;
end $$;

update public.logbook_note_links
set room_link_mode = 'static'
where room_link_mode is null
   or trim(room_link_mode) = '';

create index if not exists idx_logbook_note_links_room_link_mode
  on public.logbook_note_links (room_link_mode);

commit;
