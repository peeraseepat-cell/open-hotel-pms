-- =============================================================
-- Hotfix: Merge profile RPC should not fail when optional modules
--         do not yet have guest_profile_id columns.
-- Date: 2026-03-05
-- =============================================================

create or replace function public.merge_guest_profiles(
  p_master_id uuid,
  p_source_id uuid,
  p_reason text default 'manual_merge'
) returns jsonb
language plpgsql
as $$
declare
  v_master public.guest_profiles%rowtype;
  v_source public.guest_profiles%rowtype;

  v_has_transfers_guest_profile boolean;
  v_has_transfer_tx_guest_profile boolean;
  v_has_commission_guest_profile boolean;
  v_has_tip_guest_profile boolean;
  v_has_reservation_guests boolean;
begin
  select * into v_master
  from public.guest_profiles
  where id = p_master_id
  for update;

  select * into v_source
  from public.guest_profiles
  where id = p_source_id
  for update;

  if v_master.id is null then
    raise exception 'Master profile not found';
  end if;
  if v_source.id is null then
    raise exception 'Source profile not found';
  end if;
  if p_master_id = p_source_id then
    raise exception 'Cannot merge profile with itself';
  end if;
  if v_master.do_not_merge or v_source.do_not_merge then
    raise exception 'Profile has do_not_merge flag';
  end if;
  if v_source.profile_status = 'merged' then
    raise exception 'Source already merged';
  end if;

  -- Core link: reservations must always repoint.
  update public.reservations
  set guest_profile_id = p_master_id
  where guest_profile_id = p_source_id;

  -- Optional modules: guard by real column existence before updating.
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'transfers'
      and column_name = 'guest_profile_id'
  ) into v_has_transfers_guest_profile;

  if v_has_transfers_guest_profile then
    execute 'update public.transfers set guest_profile_id = $1 where guest_profile_id = $2'
      using p_master_id, p_source_id;
  end if;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'transfer_transactions'
      and column_name = 'guest_profile_id'
  ) into v_has_transfer_tx_guest_profile;

  if v_has_transfer_tx_guest_profile then
    execute 'update public.transfer_transactions set guest_profile_id = $1 where guest_profile_id = $2'
      using p_master_id, p_source_id;
  end if;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'commission_ledger'
      and column_name = 'guest_profile_id'
  ) into v_has_commission_guest_profile;

  if v_has_commission_guest_profile then
    execute 'update public.commission_ledger set guest_profile_id = $1 where guest_profile_id = $2'
      using p_master_id, p_source_id;
  end if;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tip_ledger'
      and column_name = 'guest_profile_id'
  ) into v_has_tip_guest_profile;

  if v_has_tip_guest_profile then
    execute 'update public.tip_ledger set guest_profile_id = $1 where guest_profile_id = $2'
      using p_master_id, p_source_id;
  end if;

  select exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'reservation_guests'
  ) into v_has_reservation_guests;

  if v_has_reservation_guests then
    -- Remove rows that would break unique constraints after repoint.
    execute $q$
      delete from public.reservation_guests src
      using public.reservation_guests other_row
      where src.guest_profile_id = $1
        and src.reservation_id = other_row.reservation_id
        and other_row.guest_profile_id <> $1
        and (
          other_row.guest_profile_id = $2
          or (
            src.role = 'accompanying'
            and other_row.role = 'accompanying'
            and src.display_order = other_row.display_order
          )
          or (src.role = 'primary' and other_row.role = 'primary')
        )
    $q$ using p_source_id, p_master_id;

    execute 'update public.reservation_guests set guest_profile_id = $1 where guest_profile_id = $2'
      using p_master_id, p_source_id;
  end if;

  update public.guest_profiles
  set
    profile_status = 'merged',
    merged_into = p_master_id,
    updated_at = now()
  where id = p_source_id;

  update public.guest_profiles
  set
    stay_count = (
      select count(*)
      from public.reservations
      where guest_profile_id = p_master_id
        and status <> 'cancelled'
    ),
    updated_at = now()
  where id = p_master_id;

  update public.profile_match_scores
  set status = 'merged'
  where (profile_a = p_source_id or profile_b = p_source_id)
    and status = 'pending';

  insert into public.audit_logs (action, entity_type, entity_id, before_json, after_json, change_reason)
  values (
    'profile_merged',
    'guest_profiles',
    p_master_id::text,
    jsonb_build_object('source_id', p_source_id, 'source_name', concat(v_source.first_name, ' ', v_source.last_name)),
    jsonb_build_object('master_id', p_master_id, 'master_name', concat(v_master.first_name, ' ', v_master.last_name)),
    p_reason
  );

  return jsonb_build_object(
    'success', true,
    'master_id', p_master_id,
    'source_id', p_source_id
  );
end;
$$;
