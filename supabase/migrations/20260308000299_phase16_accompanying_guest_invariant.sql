begin;

comment on table public.reservation_guests is
  'Reservation party members. Primary guest is persisted with role=primary, display_order=1. Accompanying guest slots use display_order 2..4.';

comment on column public.reservation_guests.display_order is
  'Slot convention: 1=primary, 2..4=accompanying. Max occupancy is enforced in API/business layer.';

insert into public.reservation_guests (reservation_id, guest_profile_id, role, display_order)
select r.id, r.guest_profile_id, 'primary', 1
from public.reservations r
where r.guest_profile_id is not null
  and not exists (
    select 1
    from public.reservation_guests rg
    where rg.reservation_id = r.id
      and rg.role = 'primary'
  );

create or replace function public.link_primary_guest(
  p_reservation_id uuid,
  p_guest_profile_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations%rowtype;
  v_profile public.guest_profiles%rowtype;
  v_existing_role text;
begin
  if p_reservation_id is null then
    raise exception 'reservation_id is required';
  end if;
  if p_guest_profile_id is null then
    raise exception 'guest_profile_id is required';
  end if;

  select *
  into v_reservation
  from public.reservations
  where id = p_reservation_id
  for update;

  if v_reservation.id is null then
    raise exception 'Reservation not found';
  end if;

  select *
  into v_profile
  from public.guest_profiles
  where id = p_guest_profile_id
  for update;

  if v_profile.id is null then
    raise exception 'Guest profile not found';
  end if;

  if v_profile.profile_status = 'merged' then
    raise exception 'Cannot link merged guest profile';
  end if;

  update public.reservations
  set guest_profile_id = p_guest_profile_id
  where id = p_reservation_id;

  delete from public.reservation_guests
  where reservation_id = p_reservation_id
    and role = 'primary'
    and guest_profile_id <> p_guest_profile_id;

  select role
  into v_existing_role
  from public.reservation_guests
  where reservation_id = p_reservation_id
    and guest_profile_id = p_guest_profile_id
  limit 1;

  if v_existing_role is null then
    insert into public.reservation_guests (reservation_id, guest_profile_id, role, display_order)
    values (p_reservation_id, p_guest_profile_id, 'primary', 1);
  else
    update public.reservation_guests
    set role = 'primary',
        display_order = 1
    where reservation_id = p_reservation_id
      and guest_profile_id = p_guest_profile_id;
  end if;

  return jsonb_build_object(
    'success', true,
    'reservation_id', p_reservation_id,
    'guest_profile_id', p_guest_profile_id,
    'role', 'primary',
    'display_order', 1
  );
end;
$$;

create or replace function public.unlink_primary_guest(
  p_reservation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations%rowtype;
begin
  if p_reservation_id is null then
    raise exception 'reservation_id is required';
  end if;

  select *
  into v_reservation
  from public.reservations
  where id = p_reservation_id
  for update;

  if v_reservation.id is null then
    raise exception 'Reservation not found';
  end if;

  update public.reservations
  set guest_profile_id = null
  where id = p_reservation_id;

  delete from public.reservation_guests
  where reservation_id = p_reservation_id
    and role = 'primary';

  return jsonb_build_object(
    'success', true,
    'reservation_id', p_reservation_id,
    'guest_profile_id', null
  );
end;
$$;

grant execute on function public.link_primary_guest(uuid, uuid) to authenticated, service_role;
grant execute on function public.unlink_primary_guest(uuid) to authenticated, service_role;

commit;
