begin;

alter table public.logbook_notes
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.staff(id) on delete set null,
  add column if not exists body_rich jsonb,
  add column if not exists board_mode text;

update public.logbook_notes
set board_mode = case when is_minimized then 'minimized' else 'middle' end
where board_mode is null;

alter table public.logbook_notes
  alter column board_mode set default 'middle';

alter table public.logbook_notes
  alter column board_mode set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_logbook_notes_board_mode'
      and conrelid = 'public.logbook_notes'::regclass
  ) then
    alter table public.logbook_notes
      add constraint chk_logbook_notes_board_mode
      check (board_mode in ('minimized', 'middle'));
  end if;
end $$;

create index if not exists idx_logbook_notes_archived_at
  on public.logbook_notes (archived_at desc);

create index if not exists idx_logbook_notes_board_mode
  on public.logbook_notes (board_mode);

create index if not exists idx_logbook_notes_remind_at
  on public.logbook_notes (remind_at);

commit;
