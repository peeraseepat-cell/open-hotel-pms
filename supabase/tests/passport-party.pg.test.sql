begin;
do $test$
declare
  reservation uuid := gen_random_uuid();
  primary_guest uuid := gen_random_uuid();
  first_guest uuid := gen_random_uuid();
  second_guest uuid := gen_random_uuid();
  replacement_guest uuid := gen_random_uuid();
  first_scan uuid := gen_random_uuid();
  second_scan uuid := gen_random_uuid();
  failed boolean;
begin
  insert into public.guest_profiles(id,last_name) values
    (primary_guest,'Fixture Main'),(first_guest,'Fixture First'),(second_guest,'Fixture Second'),(replacement_guest,'Fixture Replacement');
  insert into public.reservations(id,booking_code,guest_name,guest_profile_id,checkin_date,checkout_date)
    values(reservation,'TEST-'||reservation::text,'Fixture Main',primary_guest,'2026-01-01','2026-01-02');
  insert into public.reservation_guests(reservation_id,guest_profile_id,role,display_order)
    values(reservation,first_guest,'accompanying',2),(reservation,second_guest,'accompanying',3);
  insert into public.passport_scans(id,reservation_id,guest_index,image_path)
    values(first_scan,reservation,1,'fixture/first.jpg'),(second_scan,reservation,2,'fixture/second.jpg');

  delete from public.reservation_guests where reservation_id=reservation and guest_profile_id=first_guest;
  if (select guest_index from public.passport_scans where id=first_scan) <> -2 then
    raise exception 'ASSERTION: deleting companion must detach its old passport slot';
  end if;
  if (select guest_index from public.passport_scans where id=second_scan) <> 2 then
    raise exception 'ASSERTION: deleting first companion must preserve survivor slot';
  end if;
  raise notice 'PASS removal detaches only vacated slot';

  update public.reservation_guests set display_order=4 where reservation_id=reservation and guest_profile_id=second_guest;
  if (select guest_index from public.passport_scans where id=second_scan) <> -3 then
    raise exception 'ASSERTION: changing display order must detach the old slot';
  end if;
  raise notice 'PASS slot movement detaches old binding';

  update public.passport_scans set guest_index=3 where id=second_scan;
  failed := false;
  begin
    perform public.sync_accompanying_party(reservation,jsonb_build_array(
      jsonb_build_object('guest_profile_id',gen_random_uuid(),'display_order',2)));
  exception when foreign_key_violation then failed := true;
  end;
  if not failed then raise exception 'ASSERTION: invalid replacement must fail'; end if;
  if not exists(select 1 from public.reservation_guests where reservation_id=reservation and guest_profile_id=second_guest and display_order=4)
    or (select guest_index from public.passport_scans where id=second_scan) <> 3 then
    raise exception 'ASSERTION: failed atomic replacement must preserve party and scan';
  end if;
  raise notice 'PASS invalid replacement rolls back party and scan mutation';

  perform public.sync_accompanying_party(reservation,jsonb_build_array(
    jsonb_build_object('guest_profile_id',second_guest,'display_order',4),
    jsonb_build_object('guest_profile_id',replacement_guest,'display_order',2)));
  if (select guest_index from public.passport_scans where id=second_scan) <> 3
    or (select guest_index from public.passport_scans where id=first_scan) <> -2 then
    raise exception 'ASSERTION: reusing vacant slot must not revive removed occupant scan';
  end if;
  raise notice 'PASS slot reuse preserves survivor and leaves old scan detached';

  -- Existing merge first removes a duplicate party row, then relinks the profile.
  insert into public.passport_scans(reservation_id,guest_index,image_path) values(reservation,1,'fixture/replacement.jpg');
  perform public.merge_guest_profiles(second_guest,replacement_guest,'fixture');
  if exists(select 1 from public.passport_scans where reservation_id=reservation and image_path='fixture/replacement.jpg' and guest_index=1)
    or (select guest_index from public.passport_scans where id=second_scan) <> 3 then
    raise exception 'ASSERTION: composed merge must detach deleted duplicate slot only';
  end if;
  raise notice 'PASS existing merge duplicate deletion composes with detachment';

  insert into public.reservation_guests(reservation_id,guest_profile_id,role,display_order) values(reservation,first_guest,'accompanying',2);
  update public.passport_scans set guest_index=1 where id=first_scan;
  perform public.merge_guest_profiles(primary_guest,first_guest,'fixture');
  if (select guest_index from public.passport_scans where id=first_scan) <> 1 then
    raise exception 'ASSERTION: profile-id-only merge at same role/slot must retain scan';
  end if;
  raise notice 'PASS profile-id-only merge retains same-slot scan';

  perform public.remove_accompanying_guest(reservation,second_guest);
  if (select guest_index from public.passport_scans where id=second_scan) <> -4 then
    raise exception 'ASSERTION: removal RPC must detach scan atomically';
  end if;
  raise notice 'PASS removal RPC detaches scan';
end;
$test$;
rollback;
