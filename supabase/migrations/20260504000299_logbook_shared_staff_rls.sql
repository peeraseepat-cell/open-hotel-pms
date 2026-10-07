begin;

-- Logbook is a shared hotel surface: any active authenticated staff member
-- can edit, close, archive, restore, link, mention, or delete notes.

drop policy if exists logbook_notes_insert_self on public.logbook_notes;
drop policy if exists logbook_notes_update_owner_or_admin on public.logbook_notes;
drop policy if exists logbook_notes_delete_owner_or_admin on public.logbook_notes;
drop policy if exists logbook_notes_insert_authenticated_staff on public.logbook_notes;
drop policy if exists logbook_notes_update_authenticated_staff on public.logbook_notes;
drop policy if exists logbook_notes_delete_authenticated_staff on public.logbook_notes;

create policy logbook_notes_insert_authenticated_staff
on public.logbook_notes
for insert
to authenticated
with check (
  created_by = auth.uid()
  and
  exists (
    select 1
    from public.staff s
    where s.id = auth.uid()
      and coalesce(s.is_active, true) = true
  )
);

create policy logbook_notes_update_authenticated_staff
on public.logbook_notes
for update
to authenticated
using (
  exists (
    select 1
    from public.staff s
    where s.id = auth.uid()
      and coalesce(s.is_active, true) = true
  )
)
with check (
  exists (
    select 1
    from public.staff s
    where s.id = auth.uid()
      and coalesce(s.is_active, true) = true
  )
);

create policy logbook_notes_delete_authenticated_staff
on public.logbook_notes
for delete
to authenticated
using (
  exists (
    select 1
    from public.staff s
    where s.id = auth.uid()
      and coalesce(s.is_active, true) = true
  )
);

drop policy if exists logbook_note_links_insert_manage_note on public.logbook_note_links;
drop policy if exists logbook_note_links_delete_manage_note on public.logbook_note_links;
drop policy if exists logbook_note_links_insert_authenticated_staff on public.logbook_note_links;
drop policy if exists logbook_note_links_delete_authenticated_staff on public.logbook_note_links;

create policy logbook_note_links_insert_authenticated_staff
on public.logbook_note_links
for insert
to authenticated
with check (
  exists (
    select 1
    from public.staff s
    where s.id = auth.uid()
      and coalesce(s.is_active, true) = true
  )
);

create policy logbook_note_links_delete_authenticated_staff
on public.logbook_note_links
for delete
to authenticated
using (
  exists (
    select 1
    from public.staff s
    where s.id = auth.uid()
      and coalesce(s.is_active, true) = true
  )
);

drop policy if exists logbook_note_mentions_insert_manage_note on public.logbook_note_mentions;
drop policy if exists logbook_note_mentions_update_manage_note on public.logbook_note_mentions;
drop policy if exists logbook_note_mentions_delete_manage_note on public.logbook_note_mentions;
drop policy if exists logbook_note_mentions_insert_authenticated_staff on public.logbook_note_mentions;
drop policy if exists logbook_note_mentions_update_authenticated_staff on public.logbook_note_mentions;
drop policy if exists logbook_note_mentions_delete_authenticated_staff on public.logbook_note_mentions;

create policy logbook_note_mentions_insert_authenticated_staff
on public.logbook_note_mentions
for insert
to authenticated
with check (
  exists (
    select 1
    from public.staff s
    where s.id = auth.uid()
      and coalesce(s.is_active, true) = true
  )
);

create policy logbook_note_mentions_update_authenticated_staff
on public.logbook_note_mentions
for update
to authenticated
using (
  exists (
    select 1
    from public.staff s
    where s.id = auth.uid()
      and coalesce(s.is_active, true) = true
  )
)
with check (
  exists (
    select 1
    from public.staff s
    where s.id = auth.uid()
      and coalesce(s.is_active, true) = true
  )
);

create policy logbook_note_mentions_delete_authenticated_staff
on public.logbook_note_mentions
for delete
to authenticated
using (
  exists (
    select 1
    from public.staff s
    where s.id = auth.uid()
      and coalesce(s.is_active, true) = true
  )
);

commit;
