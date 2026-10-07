begin;

-- Phase 50: Group OCR via Mobile
-- Lead lock:
-- - passport_scans links to booking_groups + guest_profiles
-- - pool_status lifecycle: ready | ocr_failed | assigned (or NULL for non-group scans)

alter table public.passport_scans
  add column if not exists booking_group_id uuid
    references public.booking_groups(id) on delete set null;

create index if not exists idx_passport_scans_group
  on public.passport_scans (booking_group_id)
  where booking_group_id is not null;

alter table public.passport_scans
  add column if not exists guest_profile_id uuid
    references public.guest_profiles(id) on delete set null;

create index if not exists idx_passport_scans_guest_profile
  on public.passport_scans (guest_profile_id)
  where guest_profile_id is not null;

alter table public.passport_scans
  add column if not exists pool_status text default null;

-- Backward compatibility if a previous draft used ready_low_confidence
update public.passport_scans
set pool_status = 'ready'
where pool_status = 'ready_low_confidence';

alter table public.passport_scans
  drop constraint if exists chk_pool_status;

alter table public.passport_scans
  add constraint chk_pool_status
  check (
    pool_status is null
    or pool_status in ('ready', 'ocr_failed', 'assigned')
  );

create index if not exists idx_passport_scans_group_pool_created
  on public.passport_scans (booking_group_id, pool_status, created_at desc)
  where booking_group_id is not null;

commit;
