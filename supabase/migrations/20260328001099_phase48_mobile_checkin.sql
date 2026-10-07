begin;

-- Phase 48: Mobile Check-in foundation
-- Lead-locked decisions:
-- - reservation.status adds only 'draft_checkin'
-- - passport_scans.created_by references auth.users(id)
-- - FO photo visibility follows Bangkok business date cutoff

create table if not exists public.passport_scans (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid references public.reservations(id) on delete cascade,
  guest_index int not null default 0,
  image_path text not null,
  ocr_raw jsonb,
  ocr_parsed jsonb,
  match_confidence numeric(5,2),
  matched_reservation_id uuid references public.reservations(id),
  created_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null default (timezone('utc', now()) + interval '30 days'),
  created_by uuid references auth.users(id)
);

create index if not exists idx_passport_scans_reservation
  on public.passport_scans (reservation_id);

create index if not exists idx_passport_scans_matched_reservation
  on public.passport_scans (matched_reservation_id);

create index if not exists idx_passport_scans_expires
  on public.passport_scans (expires_at);

create index if not exists idx_passport_scans_created_at
  on public.passport_scans (created_at desc);

alter table public.passport_scans enable row level security;

drop policy if exists passport_scans_admin_full_access on public.passport_scans;
create policy passport_scans_admin_full_access
  on public.passport_scans
  for all
  to authenticated
  using (public.has_any_role(array['admin']::public.user_role[]))
  with check (public.has_any_role(array['admin']::public.user_role[]));

drop policy if exists passport_scans_fo_read_current_day on public.passport_scans;
create policy passport_scans_fo_read_current_day
  on public.passport_scans
  for select
  to authenticated
  using (
    public.has_any_role(array['frontdesk', 'supervisor']::public.user_role[])
    and (created_at at time zone 'Asia/Bangkok')::date >= (
      select hs.business_date
      from public.hotel_settings hs
      where hs.id = 1
    )
  );

drop policy if exists passport_scans_fo_insert on public.passport_scans;
create policy passport_scans_fo_insert
  on public.passport_scans
  for insert
  to authenticated
  with check (public.has_any_role(array['admin', 'frontdesk', 'supervisor']::public.user_role[]));

-- Reservation status enum extension for draft check-in state
alter type public.reservation_status add value if not exists 'draft_checkin';

-- Private storage bucket for passport snapshots (idempotent)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'passport-photos',
  'passport-photos',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

commit;
