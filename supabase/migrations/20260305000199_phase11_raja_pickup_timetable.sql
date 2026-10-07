begin;

-- Raja Ferry pickup timetable from OpenHotel
-- Source: provided schedule photo (Pickup from Hotel)

insert into public.boat_companies (name, website)
values ('Raja Ferry Port', 'https://www.rajaferryport.com/')
on conflict (name) do nothing;

insert into public.boat_piers (company_id, name, location_note)
values
  (
    (select id from public.boat_companies where name = 'Raja Ferry Port' limit 1),
    'Pier A',
    'Island A'
  ),
  (
    (select id from public.boat_companies where name = 'Raja Ferry Port' limit 1),
    'Pier B',
    'Island B'
  )
on conflict (company_id, name) do nothing;

do $$
declare
  v_company_id uuid;
  v_route_id uuid;
begin
  select id into v_company_id
  from public.boat_companies
  where name = 'Raja Ferry Port'
  limit 1;

  -- Route 1: OpenHotel -> Island A (Pier A)
  select id into v_route_id
  from public.boat_routes
  where company_id = v_company_id
    and lower(origin) = lower('OpenHotel')
    and lower(destination) = lower('Island A (Pier A)')
  order by created_at desc
  limit 1;

  if v_route_id is null then
    insert into public.boat_routes (
      company_id,
      departure_pier_id,
      origin,
      destination,
      boat_type,
      departure_times,
      duration_minutes,
      ticket_price,
      cost_price,
      includes_pickup,
      pickup_fee,
      season_label,
      notes,
      is_active
    ) values (
      v_company_id,
      null,
      'OpenHotel',
      'Island A (Pier A)',
      'car_ferry',
      array['06:30','09:00','11:00','12:00','14:00','16:00','17:00'],
      null,
      null,
      null,
      true,
      null,
      'Raja Pickup from Hotel',
      'Pickup->Arrive: 06:30->09:30, 09:00->12:30, 11:00->14:30, 12:00->15:30, 14:00->17:30, 16:00->19:30, 17:00->20:30',
      true
    );
  else
    update public.boat_routes
    set boat_type = 'car_ferry',
        departure_times = array['06:30','09:00','11:00','12:00','14:00','16:00','17:00'],
        includes_pickup = true,
        season_label = 'Raja Pickup from Hotel',
        notes = 'Pickup->Arrive: 06:30->09:30, 09:00->12:30, 11:00->14:30, 12:00->15:30, 14:00->17:30, 16:00->19:30, 17:00->20:30',
        is_active = true,
        updated_at = now()
    where id = v_route_id;
  end if;

  -- Route 2: OpenHotel -> Island B (Pier B)
  v_route_id := null;
  select id into v_route_id
  from public.boat_routes
  where company_id = v_company_id
    and lower(origin) = lower('OpenHotel')
    and lower(destination) = lower('Island B (Pier B)')
  order by created_at desc
  limit 1;

  if v_route_id is null then
    insert into public.boat_routes (
      company_id,
      departure_pier_id,
      origin,
      destination,
      boat_type,
      departure_times,
      duration_minutes,
      ticket_price,
      cost_price,
      includes_pickup,
      pickup_fee,
      season_label,
      notes,
      is_active
    ) values (
      v_company_id,
      null,
      'OpenHotel',
      'Island B (Pier B)',
      'car_ferry',
      array['06:30','08:00','09:00','11:00','12:00','14:00','16:00'],
      null,
      null,
      null,
      true,
      null,
      'Raja Pickup from Hotel',
      'Pickup->Arrive: 06:30->10:30, 08:00->13:30, 09:00->13:30, 11:00->16:30, 12:00->16:30, 14:00->20:30, 16:00->20:30',
      true
    );
  else
    update public.boat_routes
    set boat_type = 'car_ferry',
        departure_times = array['06:30','08:00','09:00','11:00','12:00','14:00','16:00'],
        includes_pickup = true,
        season_label = 'Raja Pickup from Hotel',
        notes = 'Pickup->Arrive: 06:30->10:30, 08:00->13:30, 09:00->13:30, 11:00->16:30, 12:00->16:30, 14:00->20:30, 16:00->20:30',
        is_active = true,
        updated_at = now()
    where id = v_route_id;
  end if;
end $$;

commit;
