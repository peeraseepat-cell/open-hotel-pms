create table if not exists public.guest_profile_booking_names (
  id uuid primary key default gen_random_uuid(),
  guest_profile_id uuid not null references public.guest_profiles(id) on delete cascade,
  booking_name text not null,
  normalized_booking_name text not null,
  source_reservation_id uuid null references public.reservations(id) on delete set null,
  first_seen_at timestamptz null default now(),
  last_seen_at timestamptz null default now(),
  seen_count integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guest_profile_booking_names_profile_normalized_unique unique (guest_profile_id, normalized_booking_name)
);

create index if not exists guest_profile_booking_names_normalized_idx
  on public.guest_profile_booking_names (normalized_booking_name);

create index if not exists guest_profile_booking_names_profile_idx
  on public.guest_profile_booking_names (guest_profile_id, last_seen_at desc);

create or replace function public.set_guest_profile_booking_names_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_guest_profile_booking_names_updated_at on public.guest_profile_booking_names;
create trigger trg_guest_profile_booking_names_updated_at
before update on public.guest_profile_booking_names
for each row
execute function public.set_guest_profile_booking_names_updated_at();

insert into public.guest_profile_booking_names (
  guest_profile_id,
  booking_name,
  normalized_booking_name,
  first_seen_at,
  last_seen_at,
  seen_count
)
select
  gp.id,
  trim(regexp_replace(note_line, '^จองมาในชื่อ\\s*', '', 'g')) as booking_name,
  lower(trim(regexp_replace(regexp_replace(note_line, '^จองมาในชื่อ\\s*', '', 'g'), '\\s+', ' ', 'g'))) as normalized_booking_name,
  gp.created_at,
  gp.updated_at,
  1
from public.guest_profiles gp
cross join lateral regexp_split_to_table(coalesce(gp.notes, ''), E'\\r?\\n') as note_line
where trim(note_line) like 'จองมาในชื่อ %'
  and trim(regexp_replace(note_line, '^จองมาในชื่อ\\s*', '', 'g')) <> ''
on conflict (guest_profile_id, normalized_booking_name) do nothing;
