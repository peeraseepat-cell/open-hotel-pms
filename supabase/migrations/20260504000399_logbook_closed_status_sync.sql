-- Keep legacy status aligned with the close marker for existing Logbook rows.
-- UI uses closed_at/archived_at as the source of truth, but status should not
-- continue to show "open" for notes that staff already closed.

update public.logbook_notes
set status = 'resolved'
where closed_at is not null
  and status <> 'resolved';
