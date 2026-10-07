begin;

-- Return authoritative positive remainder for the receive screen and retain
-- active-event dictionary rows after that step. The recent lane is the newest
-- pair in the final status-conditional emitted rowset.
create or replace function public.fn_laundry_return_partition(
  p_current_batch_id uuid
)
returns table (
  id uuid,
  source_batch_id uuid,
  linen_item_id int,
  is_dayuse boolean,
  sent_by_hotel int,
  received_back int,
  remaining_qty int,
  source_business_date date,
  source_pickup_round int,
  lane text,
  item_number int,
  name_th text
)
language sql
stable
set search_path = public
as $function$
  with current_batch as (
    select
      b.business_date,
      b.pickup_round,
      b.status as current_status
    from public.laundry_batches b
    where b.id = p_current_batch_id
  ),
  predecessor_batches as (
    select
      b.id as source_batch_id,
      b.business_date as source_business_date,
      b.pickup_round::int as source_pickup_round
    from public.laundry_batches b
    cross join current_batch c
    where (b.business_date, b.pickup_round)
      < (c.business_date, c.pickup_round)
  ),
  latest_reopen as (
    select max(e.created_at) as reopened_at
    from public.laundry_batch_events e
    where e.batch_id = p_current_batch_id
      and e.event_type = 'reopened'
  ),
  active_return_events as (
    select e.data
    from public.laundry_batch_events e
    cross join latest_reopen r
    where e.batch_id = p_current_batch_id
      and e.event_type = 'fo_return_counted'
      and e.created_at > coalesce(r.reopened_at, '-infinity'::timestamptz)
  ),
  active_return_keys as (
    select distinct
      (entry.item ->> 'source_batch_id')::uuid as source_batch_id,
      (entry.item ->> 'linen_item_id')::int as linen_item_id,
      coalesce((entry.item ->> 'is_dayuse')::boolean, false) as is_dayuse
    from active_return_events e
    cross join lateral (
      select return_item as item
      from jsonb_array_elements(
        coalesce(e.data -> 'returns', '[]'::jsonb)
      ) as return_rows(return_item)
      union all
      select resolved_item as item
      from jsonb_array_elements(
        coalesce(e.data -> 'resolved', '[]'::jsonb)
      ) as resolved_rows(resolved_item)
    ) entry
    where nullif(entry.item ->> 'source_batch_id', '') is not null
      and nullif(entry.item ->> 'linen_item_id', '') is not null
  ),
  remaining_items as (
    select
      i.id,
      p.source_batch_id,
      i.linen_item_id,
      i.is_dayuse,
      i.sent_by_hotel::int as sent_by_hotel,
      i.received_back::int as received_back,
      greatest(0, i.sent_by_hotel - i.received_back)::int as remaining_qty,
      p.source_business_date,
      p.source_pickup_round,
      li.item_number::int as item_number,
      li.name_th
    from predecessor_batches p
    join public.laundry_batch_items i
      on i.batch_id = p.source_batch_id
    join public.linen_items li
      on li.id = i.linen_item_id
    cross join current_batch c
    where i.sent_by_hotel > 0
      and (
        (
          c.current_status = 'fo_dirty_counted'
          and i.sent_by_hotel > i.received_back
        ) or (
          c.current_status <> 'fo_dirty_counted'
          and (
            i.sent_by_hotel > i.received_back
            or exists (
              select 1
              from active_return_keys k
              where k.source_batch_id = p.source_batch_id
                and k.linen_item_id = i.linen_item_id
                and k.is_dayuse = i.is_dayuse
            )
          )
        )
      )
  ),
  latest_emitted_pair as (
    select
      r.source_business_date,
      r.source_pickup_round
    from remaining_items r
    order by
      r.source_business_date desc,
      r.source_pickup_round desc
    limit 1
  ),
  labeled_items as (
    select
      r.*,
      case
        when r.source_business_date = p.source_business_date
          and r.source_pickup_round = p.source_pickup_round
          then 'recent'
        else 'overdue'
      end as lane,
      case
        when r.source_business_date = p.source_business_date
          and r.source_pickup_round = p.source_pickup_round
          then 1
        else 2
      end as lane_order
    from remaining_items r
    left join latest_emitted_pair p on true
  )
  select
    l.id,
    l.source_batch_id,
    l.linen_item_id,
    l.is_dayuse,
    l.sent_by_hotel,
    l.received_back,
    l.remaining_qty,
    l.source_business_date,
    l.source_pickup_round,
    l.lane,
    l.item_number,
    l.name_th
  from labeled_items l
  order by
    l.lane_order,
    l.source_business_date desc,
    l.source_pickup_round desc,
    l.item_number asc,
    l.is_dayuse asc;
$function$;


create or replace function public.fn_laundry_apply_return_step(
  p_current_batch_id uuid,
  p_submission jsonb,
  p_actor_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_current_batch record;
  v_source_item record;
  v_pending_item record;
  v_rewash_item record;
  v_entry jsonb;
  v_ordinality bigint;
  v_return_items jsonb;
  v_pending_resolved jsonb;
  v_rewash_resolved jsonb;
  v_returns jsonb := '[]'::jsonb;
  v_resolved jsonb := '[]'::jsonb;
  v_rewash_results jsonb := '[]'::jsonb;
  v_photo_cleanup jsonb := '[]'::jsonb;
  v_affected_source_ids uuid[] := array[]::uuid[];
  v_source_batch_id uuid;
  v_linen_item_id int;
  v_is_dayuse boolean;
  v_received_qty int;
  v_old_pending_qty int;
  v_pending_qty int;
  v_remaining_to_allocate int;
  v_available_qty int;
  v_allocation_qty int;
  v_pending_item_id uuid;
  v_rewash_event_id bigint;
  v_rewash_qty int;
  v_next_rewash_qty int;
  v_rewash_fully_resolved boolean;
  v_photo_key text;
  v_event_at timestamptz;
  v_last_event_at timestamptz;
begin
  if p_submission is null or jsonb_typeof(p_submission) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'submission must be a JSON object';
  end if;

  v_return_items := coalesce(p_submission -> 'return_items', '[]'::jsonb);
  v_pending_resolved := coalesce(p_submission -> 'pending_resolved', '[]'::jsonb);
  v_rewash_resolved := coalesce(p_submission -> 'rewash_resolved', '[]'::jsonb);

  if jsonb_typeof(v_return_items) <> 'array'
    or jsonb_typeof(v_pending_resolved) <> 'array'
    or jsonb_typeof(v_rewash_resolved) <> 'array'
  then
    raise exception using
      errcode = '22023',
      message = 'return_items, pending_resolved, and rewash_resolved must be arrays';
  end if;

  select
    b.id,
    b.status,
    b.business_date,
    b.pickup_round
  into v_current_batch
  from public.laundry_batches b
  where b.id = p_current_batch_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Batch not found.';
  end if;
  if v_current_batch.status <> 'fo_dirty_counted' then
    raise exception using
      errcode = 'P0001',
      message = format(
        'Invalid status transition: %s -> fo_return_counted.',
        v_current_batch.status
      );
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_return_items) as e(item)
    group by
      e.item ->> 'source_batch_id',
      e.item ->> 'linen_item_id',
      coalesce(e.item ->> 'is_dayuse', 'false')
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Duplicate return item identity.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_pending_resolved) as e(item)
    group by e.item ->> 'pending_item_id'
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Duplicate pending item id.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_rewash_resolved) as e(item)
    group by e.item ->> 'rewash_event_id'
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Duplicate rewash event id.';
  end if;

  -- Lock selected pending markers before reading their source identities.
  perform 1
  from public.laundry_pending_items p
  where p.id in (
    select (e.item ->> 'pending_item_id')::uuid
    from jsonb_array_elements(v_pending_resolved) as e(item)
  )
    and p.resolved_at is null
  order by p.id
  for update;

  -- All source inventory locks use one deterministic id order. This includes
  -- both normal/day-use variants behind a merged pending ledger marker.
  perform 1
  from public.laundry_batch_items i
  where exists (
    select 1
    from jsonb_array_elements(v_return_items) as e(item)
    where i.batch_id = (e.item ->> 'source_batch_id')::uuid
      and i.linen_item_id = (e.item ->> 'linen_item_id')::int
      and i.is_dayuse = coalesce((e.item ->> 'is_dayuse')::boolean, false)
  )
  or exists (
    select 1
    from public.laundry_pending_items p
    join jsonb_array_elements(v_pending_resolved) as e(item)
      on p.id = (e.item ->> 'pending_item_id')::uuid
    where p.resolved_at is null
      and i.batch_id = p.source_batch_id
      and i.linen_item_id = p.linen_item_id
  )
  order by i.id
  for update;

  perform 1
  from public.laundry_rewash_events r
  where r.id in (
    select (e.item ->> 'rewash_event_id')::bigint
    from jsonb_array_elements(v_rewash_resolved) as e(item)
  )
  order by r.id
  for update;

  -- Direct return items preserve input order and the rollback/summary payload.
  for v_entry, v_ordinality in
    select e.item, e.ordinality
    from jsonb_array_elements(v_return_items) with ordinality as e(item, ordinality)
    order by e.ordinality
  loop
    if jsonb_typeof(v_entry) <> 'object' then
      raise exception using errcode = '22023', message = 'return_items entries must be objects';
    end if;

    v_source_batch_id := (v_entry ->> 'source_batch_id')::uuid;
    v_linen_item_id := (v_entry ->> 'linen_item_id')::int;
    v_is_dayuse := coalesce((v_entry ->> 'is_dayuse')::boolean, false);
    v_received_qty := (v_entry ->> 'received_qty')::int;

    if v_received_qty < 0 then
      raise exception using errcode = '22023', message = 'received_qty must be a non-negative integer';
    end if;

    select
      i.id,
      i.sent_by_hotel::int as sent_by_hotel,
      i.received_back::int as received_back,
      i.is_dayuse,
      b.business_date,
      b.pickup_round
    into v_source_item
    from public.laundry_batch_items i
    join public.laundry_batches b on b.id = i.batch_id
    where i.batch_id = v_source_batch_id
      and i.linen_item_id = v_linen_item_id
      and i.is_dayuse = v_is_dayuse;

    if not found then
      raise exception using errcode = 'P0002', message = 'Source batch item not found.';
    end if;
    if (v_source_item.business_date, v_source_item.pickup_round)
      >= (v_current_batch.business_date, v_current_batch.pickup_round)
    then
      raise exception using
        errcode = '22023',
        message = 'Return source must be a strict predecessor of the current batch.';
    end if;
    if v_source_item.received_back + v_received_qty > v_source_item.sent_by_hotel then
      raise exception using
        errcode = '22023',
        message = 'received_qty exceeds authoritative remaining linen.';
    end if;

    select coalesce(sum(p.pending_qty), 0)::int
    into v_old_pending_qty
    from public.laundry_pending_items p
    where p.source_batch_id = v_source_batch_id
      and p.linen_item_id = v_linen_item_id
      and p.resolved_at is null;

    update public.laundry_batch_items
    set received_back = v_source_item.received_back + v_received_qty
    where id = v_source_item.id;

    v_pending_qty := greatest(
      0,
      v_source_item.sent_by_hotel - v_source_item.received_back - v_received_qty
    );
    v_returns := v_returns || jsonb_build_array(jsonb_build_object(
      'source_batch_id', v_source_batch_id,
      'linen_item_id', v_linen_item_id,
      'received_qty', v_received_qty,
      'returned_pending_qty', least(v_received_qty, v_old_pending_qty),
      'pending_qty', v_pending_qty,
      'is_dayuse', v_is_dayuse
    ));

    if not (v_source_batch_id = any(v_affected_source_ids)) then
      v_affected_source_ids := array_append(v_affected_source_ids, v_source_batch_id);
    end if;
  end loop;

  -- One merged ledger marker can represent both source variants. Resolve its
  -- quantity against authoritative gaps, normal first then day-use, and emit
  -- one rollback record for every variant that changed.
  for v_entry, v_ordinality in
    select e.item, e.ordinality
    from jsonb_array_elements(v_pending_resolved) with ordinality as e(item, ordinality)
    order by e.ordinality
  loop
    if jsonb_typeof(v_entry) <> 'object' then
      raise exception using errcode = '22023', message = 'pending_resolved entries must be objects';
    end if;
    v_pending_item_id := (v_entry ->> 'pending_item_id')::uuid;

    select
      p.id,
      p.source_batch_id,
      p.linen_item_id,
      p.pending_qty::int as pending_qty
    into v_pending_item
    from public.laundry_pending_items p
    where p.id = v_pending_item_id
      and p.resolved_at is null;

    if not found then
      continue;
    end if;

    v_remaining_to_allocate := v_pending_item.pending_qty;
    for v_source_item in
      select
        i.id,
        i.sent_by_hotel::int as sent_by_hotel,
        i.received_back::int as received_back,
        i.is_dayuse
      from public.laundry_batch_items i
      where i.batch_id = v_pending_item.source_batch_id
        and i.linen_item_id = v_pending_item.linen_item_id
      order by i.is_dayuse asc
    loop
      v_available_qty := greatest(
        0,
        v_source_item.sent_by_hotel - v_source_item.received_back
      );
      v_allocation_qty := least(v_remaining_to_allocate, v_available_qty);
      if v_allocation_qty > 0 then
        update public.laundry_batch_items
        set received_back = v_source_item.received_back + v_allocation_qty
        where id = v_source_item.id;

        v_resolved := v_resolved || jsonb_build_array(jsonb_build_object(
          'pending_item_id', v_pending_item.id,
          'source_batch_id', v_pending_item.source_batch_id,
          'linen_item_id', v_pending_item.linen_item_id,
          'qty', v_allocation_qty,
          'is_dayuse', v_source_item.is_dayuse
        ));
        v_remaining_to_allocate := v_remaining_to_allocate - v_allocation_qty;
      end if;
      exit when v_remaining_to_allocate = 0;
    end loop;

    if v_remaining_to_allocate > 0 then
      raise exception using
        errcode = '22023',
        message = 'Pending quantity exceeds authoritative remaining linen.';
    end if;

    update public.laundry_pending_items
    set
      resolved_batch_id = p_current_batch_id,
      resolved_at = timezone('utc', now())
    where id = v_pending_item.id;

    if not (v_pending_item.source_batch_id = any(v_affected_source_ids)) then
      v_affected_source_ids := array_append(
        v_affected_source_ids,
        v_pending_item.source_batch_id
      );
    end if;
  end loop;

  -- Rewash stays inside the DB transaction. Full resolution leaves DB keys
  -- intact; the returned cleanup list is processed strictly after commit by
  -- the server.
  for v_entry, v_ordinality in
    select e.item, e.ordinality
    from jsonb_array_elements(v_rewash_resolved) with ordinality as e(item, ordinality)
    order by e.ordinality
  loop
    if jsonb_typeof(v_entry) <> 'object' then
      raise exception using errcode = '22023', message = 'rewash_resolved entries must be objects';
    end if;
    v_rewash_event_id := (v_entry ->> 'rewash_event_id')::bigint;
    v_rewash_qty := (v_entry ->> 'resolved_qty')::int;
    if v_rewash_qty <= 0 then
      raise exception using errcode = '22023', message = 'resolved_qty must be greater than zero.';
    end if;

    select
      r.id,
      r.qty,
      coalesce(r.resolved_qty, 0) as resolved_qty,
      r.status,
      r.photo_keys
    into v_rewash_item
    from public.laundry_rewash_events r
    where r.id = v_rewash_event_id;

    if not found then
      raise exception using errcode = 'P0002', message = 'Rewash event not found.';
    end if;
    if v_rewash_item.status <> 'pending' then
      raise exception using errcode = 'P0001', message = 'Rewash event is not pending.';
    end if;

    v_next_rewash_qty := v_rewash_item.resolved_qty + v_rewash_qty;
    if v_next_rewash_qty > v_rewash_item.qty then
      raise exception using errcode = '22023', message = 'resolved_qty cannot exceed rewash qty.';
    end if;
    v_rewash_fully_resolved := v_next_rewash_qty >= v_rewash_item.qty;

    if v_rewash_fully_resolved then
      foreach v_photo_key in array coalesce(v_rewash_item.photo_keys, '{}'::text[])
      loop
        v_photo_cleanup := v_photo_cleanup || jsonb_build_array(jsonb_build_object(
          'rewash_event_id', v_rewash_event_id,
          'key', v_photo_key
        ));
      end loop;
    end if;

    update public.laundry_rewash_events
    set
      status = case when v_rewash_fully_resolved then 'resolved' else 'pending' end,
      resolved_batch_id = p_current_batch_id,
      resolved_qty = v_next_rewash_qty,
      resolved_at = timezone('utc', now())
    where id = v_rewash_event_id;

    v_event_at := clock_timestamp();
    if v_last_event_at is not null and v_event_at <= v_last_event_at then
      v_event_at := v_last_event_at + interval '1 microsecond';
    end if;
    v_last_event_at := v_event_at;

    insert into public.laundry_batch_events (
      batch_id,
      event_type,
      actor_role,
      data,
      created_at
    )
    values (
      p_current_batch_id,
      'rewash_resolved',
      'fo',
      jsonb_build_object(
        'rewash_event_id', v_rewash_event_id,
        'resolved_qty', v_rewash_qty,
        'total_resolved_qty', v_next_rewash_qty,
        'remaining_qty', greatest(0, v_rewash_item.qty - v_next_rewash_qty),
        'photos_cleanup_requested', v_rewash_fully_resolved
          and coalesce(cardinality(v_rewash_item.photo_keys), 0) > 0
      ),
      v_event_at
    );

    v_rewash_results := v_rewash_results || jsonb_build_array(jsonb_build_object(
      'rewash_event_id', v_rewash_event_id,
      'resolved_qty', v_rewash_qty,
      'total_resolved_qty', v_next_rewash_qty,
      'remaining_qty', greatest(0, v_rewash_item.qty - v_next_rewash_qty)
    ));
  end loop;

  -- Rebuild the merged audit ledger once, from final authoritative state.
  delete from public.laundry_pending_items
  where resolved_at is null
    and (
      created_by_batch_id = p_current_batch_id
      or source_batch_id = any(v_affected_source_ids)
    );

  insert into public.laundry_pending_items (
    source_batch_id,
    linen_item_id,
    pending_qty,
    created_by_batch_id,
    reason
  )
  select
    i.batch_id,
    i.linen_item_id,
    sum(greatest(0, i.sent_by_hotel - i.received_back))::smallint,
    p_current_batch_id,
    'return_short'
  from public.laundry_batch_items i
  where i.batch_id = any(v_affected_source_ids)
  group by i.batch_id, i.linen_item_id
  having sum(greatest(0, i.sent_by_hotel - i.received_back)) > 0;

  update public.laundry_batches
  set
    status = 'fo_return_counted',
    vendor_name = case
      when p_submission ? 'vendor_name' then p_submission ->> 'vendor_name'
      else vendor_name
    end
  where id = p_current_batch_id;

  v_event_at := clock_timestamp();
  if v_last_event_at is not null and v_event_at <= v_last_event_at then
    v_event_at := v_last_event_at + interval '1 microsecond';
  end if;

  insert into public.laundry_batch_events (
    batch_id,
    event_type,
    actor_name,
    actor_role,
    data,
    created_at
  )
  values (
    p_current_batch_id,
    'fo_return_counted',
    p_actor_name,
    'fo',
    jsonb_build_object(
      'returns', v_returns,
      'resolved', v_resolved
    ),
    v_event_at
  );

  return jsonb_build_object(
    'batch_id', p_current_batch_id,
    'status', 'fo_return_counted',
    'returns', v_returns,
    'resolved', v_resolved,
    'rewash_resolved', v_rewash_results,
    'photo_cleanup', v_photo_cleanup
  );
end;
$function$;

revoke all on function public.fn_laundry_apply_return_step(uuid, jsonb, text) from public;
revoke all on function public.fn_laundry_apply_return_step(uuid, jsonb, text) from anon;
revoke all on function public.fn_laundry_apply_return_step(uuid, jsonb, text) from authenticated;
grant execute on function public.fn_laundry_apply_return_step(uuid, jsonb, text) to service_role;

revoke execute on function public.fn_laundry_return_partition(uuid) from public, anon, authenticated;
grant execute on function public.fn_laundry_return_partition(uuid) to service_role;
revoke execute on function public.fn_laundry_apply_return_step(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.fn_laundry_apply_return_step(uuid, jsonb, text) to service_role;
commit;
