begin;

create or replace function public.increment_driver_total_trips(p_driver_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_driver_id is null then
    raise exception 'driver_id is required';
  end if;

  update public.drivers
  set total_trips = coalesce(total_trips, 0) + 1
  where id = p_driver_id;

  if not found then
    raise exception 'Driver not found';
  end if;
end;
$$;

grant execute on function public.increment_driver_total_trips(uuid) to anon, authenticated;

commit;
