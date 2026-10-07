begin;

alter table public.reservations
  add column if not exists do_not_move_assigned_room boolean not null default false,
  add column if not exists do_not_move_reason text,
  add column if not exists do_not_move_room_id_snapshot uuid references public.rooms(id) on delete set null,
  add column if not exists do_not_move_set_at timestamptz,
  add column if not exists do_not_move_set_by text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'reservations_do_not_move_assigned_room_check'
  ) then
    alter table public.reservations
      add constraint reservations_do_not_move_assigned_room_check
      check (
        (not do_not_move_assigned_room)
        or (
          do_not_move_reason is not null
          and btrim(do_not_move_reason) <> ''
          and do_not_move_room_id_snapshot is not null
        )
      );
  end if;
end $$;

create index if not exists reservations_do_not_move_assigned_room_idx
  on public.reservations (do_not_move_assigned_room)
  where do_not_move_assigned_room = true;

create index if not exists reservations_do_not_move_room_snapshot_idx
  on public.reservations (do_not_move_room_id_snapshot)
  where do_not_move_assigned_room = true;

comment on column public.reservations.do_not_move_assigned_room
  is 'Pre-check-in assigned room lock. Auto-clears after successful check-in or successful override room change.';

comment on column public.reservations.do_not_move_room_id_snapshot
  is 'Room id that was assigned when the Do Not Move lock was created.';

commit;
