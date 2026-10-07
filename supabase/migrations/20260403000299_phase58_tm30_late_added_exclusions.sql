create table if not exists public.tm30_report_exclusions (
  id uuid primary key default gen_random_uuid(),
  report_date date not null,
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  guest_profile_id uuid not null references public.guest_profiles(id) on delete cascade,
  exclusion_type text not null default 'late_added_duplicate',
  created_by uuid null,
  created_at timestamptz not null default now(),
  constraint tm30_report_exclusions_type_check check (exclusion_type in ('late_added_duplicate')),
  constraint tm30_report_exclusions_unique unique (report_date, reservation_id, guest_profile_id, exclusion_type)
);

create index if not exists tm30_report_exclusions_report_date_idx
  on public.tm30_report_exclusions(report_date);

comment on table public.tm30_report_exclusions is
  'Persistent TM.30 exclusions for late-added duplicate guests so users can avoid re-exporting the same guest on the later report date.';

comment on column public.tm30_report_exclusions.report_date is
  'The TM.30 report date whose export should exclude this guest.';
