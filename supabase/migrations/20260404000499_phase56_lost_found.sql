begin;

create table if not exists public.lost_found_items (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id),
  room_number text not null,
  reservation_id uuid null references public.reservations(id) on delete set null,
  guest_profile_id uuid null references public.guest_profiles(id) on delete set null,
  booking_code text null,
  guest_name text null,
  checkin_date date null,
  checkout_date date null,
  description text not null,
  photo_path text null,
  category text not null default 'general',
  status text not null default 'pending',
  found_date date not null default current_date,
  found_by text not null,
  reported_by_user_id uuid null references auth.users(id) on delete set null,
  location_detail text null,
  claim_note text null,
  claimed_at timestamptz null,
  claimed_by text null,
  cleared_at timestamptz null,
  cleared_by text null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint lost_found_items_category_check check (
    category in ('general', 'electronics', 'clothing', 'documents', 'valuables', 'other')
  ),
  constraint lost_found_items_status_check check (
    status in ('pending', 'claimed')
  )
);

create index if not exists idx_lf_guest_profile
  on public.lost_found_items (guest_profile_id)
  where guest_profile_id is not null;

create index if not exists idx_lf_status
  on public.lost_found_items (status);

create index if not exists idx_lf_found_date
  on public.lost_found_items (found_date desc);

create index if not exists idx_lf_room
  on public.lost_found_items (room_id);

create index if not exists idx_lf_cleared_at
  on public.lost_found_items (cleared_at);

drop trigger if exists trg_lost_found_items_updated_at on public.lost_found_items;
create trigger trg_lost_found_items_updated_at
before update on public.lost_found_items
for each row execute function public.set_updated_at();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lost-found-photos',
  'lost-found-photos',
  false,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

commit;
