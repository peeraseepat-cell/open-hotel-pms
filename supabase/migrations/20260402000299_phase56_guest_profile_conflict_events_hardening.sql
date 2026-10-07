begin;

alter table public.guest_profile_conflict_events
  alter column resolved_profile_id drop not null;

alter table public.guest_profile_conflict_events
  drop constraint if exists guest_profile_conflict_events_resolved_profile_id_fkey;

alter table public.guest_profile_conflict_events
  add constraint guest_profile_conflict_events_resolved_profile_id_fkey
  foreign key (resolved_profile_id)
  references public.guest_profiles (id)
  on delete set null;

create index if not exists idx_guest_profile_conflict_events_business_date
  on public.guest_profile_conflict_events (business_date desc);

drop policy if exists guest_profile_conflict_events_no_client_insert on public.guest_profile_conflict_events;
create policy guest_profile_conflict_events_no_client_insert
  on public.guest_profile_conflict_events
  for insert
  to authenticated
  with check (false);

commit;
