begin;

-- Keep removed scans as evidence without attaching them to a reusable guest slot.

      create or replace function public.sync_accompanying_party(p_reservation_id uuid, p_guests jsonb)
      returns jsonb language plpgsql security invoker set search_path = pg_catalog as $fn$
      declare
        kept_scans jsonb;
      begin
        perform 1 from public.reservations where id = p_reservation_id for update;
        if not found then raise exception 'Reservation not found'; end if;
        if p_guests is null or jsonb_typeof(p_guests) <> 'array' or jsonb_array_length(p_guests) > 3 then
          raise exception 'Invalid accompanying guests';
        end if;
        if exists (select 1 from jsonb_to_recordset(p_guests) as g(guest_profile_id uuid, display_order integer)
                   where guest_profile_id is null or display_order is null or display_order not between 2 and 4)
          or exists (select 1 from jsonb_to_recordset(p_guests) as g(guest_profile_id uuid, display_order integer)
                     group by display_order having count(*) > 1)
          or exists (select 1 from jsonb_to_recordset(p_guests) as g(guest_profile_id uuid, display_order integer)
                     group by guest_profile_id having count(*) > 1) then
          raise exception 'Invalid accompanying slots';
        end if;

        -- Only current, explicitly supplied replacement scans can survive a
        -- changed slot. A historic detached ID cannot be reattached this way.
        select coalesce(jsonb_agg(jsonb_build_object('id',ps.id,'guest_index',ps.guest_index)), '[]'::jsonb)
        into kept_scans
        from public.passport_scans ps
        where ps.reservation_id = p_reservation_id
          and exists (select 1 from jsonb_to_recordset(p_guests) as next(passport_scan_id uuid, display_order integer)
                      where next.passport_scan_id = ps.id and next.display_order = ps.guest_index + 1);

        -- Reconcile before/after tuples, retaining survivors rather than
        -- deleting/reinserting the whole party. DELETE's trigger handles every
        -- actual vacated slot, including the duplicate-profile merge corridor.
        delete from public.reservation_guests old
        where old.reservation_id = p_reservation_id and old.role = 'accompanying'
          and not exists (select 1 from jsonb_to_recordset(p_guests) as next(guest_profile_id uuid, display_order integer)
                          where next.guest_profile_id = old.guest_profile_id and next.display_order = old.display_order);
        insert into public.reservation_guests(reservation_id, guest_profile_id, role, display_order)
        select p_reservation_id, g.guest_profile_id, 'accompanying', g.display_order
        from jsonb_to_recordset(p_guests) as g(guest_profile_id uuid, display_order integer)
        where not exists (select 1 from public.reservation_guests current
                          where current.reservation_id = p_reservation_id and current.role = 'accompanying'
                            and current.guest_profile_id = g.guest_profile_id and current.display_order = g.display_order);
        update public.passport_scans ps set guest_index = kept.guest_index
        from jsonb_to_recordset(kept_scans) as kept(id uuid, guest_index integer)
        where ps.id = kept.id and ps.reservation_id = p_reservation_id
          and ps.guest_index = -(kept.guest_index + 1);
        return jsonb_build_object('success', true);
      end;
      $fn$;

      create or replace function public.remove_accompanying_guest(p_reservation_id uuid, p_guest_profile_id uuid)
      returns jsonb language plpgsql security invoker set search_path = pg_catalog as $fn$
      declare
        removed integer;
      begin
        perform 1 from public.reservations where id = p_reservation_id for update;
        if not found then raise exception 'Reservation not found'; end if;
        delete from public.reservation_guests
        where reservation_id = p_reservation_id and guest_profile_id = p_guest_profile_id and role = 'accompanying';
        get diagnostics removed = row_count;
        return jsonb_build_object('removed', removed);
      end;
      $fn$;

      -- Promotion/moving an accompanying row also vacates its previous slot.
      -- Ordinary profile-id merges at the same role/slot do not detach scans.
      create or replace function public.detach_vacated_accompanying_slot()
      returns trigger language plpgsql security invoker set search_path = pg_catalog as $fn$
      begin
        update public.passport_scans set guest_index = -old.display_order
        where reservation_id = old.reservation_id and guest_index = old.display_order - 1;
        if tg_op = 'DELETE' then return old; end if;
        return new;
      end;
      $fn$;
      drop trigger if exists detach_vacated_accompanying_slot on public.reservation_guests;
      create trigger detach_vacated_accompanying_slot after update on public.reservation_guests
      for each row when (old.role = 'accompanying' and
        (old.role is distinct from new.role or old.display_order is distinct from new.display_order
         or old.reservation_id is distinct from new.reservation_id))
      execute function public.detach_vacated_accompanying_slot();
      drop trigger if exists detach_removed_accompanying_slot on public.reservation_guests;
      create trigger detach_removed_accompanying_slot after delete on public.reservation_guests
      for each row when (old.role = 'accompanying')
      execute function public.detach_vacated_accompanying_slot();

revoke all on function public.sync_accompanying_party(uuid,jsonb) from public, anon, authenticated;
revoke all on function public.remove_accompanying_guest(uuid,uuid) from public, anon, authenticated;
grant execute on function public.sync_accompanying_party(uuid,jsonb) to service_role;
grant execute on function public.remove_accompanying_guest(uuid,uuid) to service_role;
commit;
