begin;

create or replace function public.fn_laundry_replace_dirty_items(
  p_batch_id uuid,
  p_items jsonb,
  p_rewash jsonb default '[]'::jsonb,
  p_created_by uuid default null,
  p_consume_dayuse_accumulator boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_batch public.laundry_batches%rowtype;
  v_item jsonb;
  v_rewash jsonb;
  v_item_count integer := 0;
  v_rewash_ids bigint[] := array[]::bigint[];
  v_rewash_id bigint;
  v_dayuse_ids uuid[] := array[]::uuid[];
  v_dayuse record;
  v_linen_item_id integer;
  v_is_dayuse boolean;
  v_estimated_qty integer;
  v_sent_by_hotel integer;
  v_photo_keys text[];
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'items are required.';
  end if;

  if p_rewash is null then
    p_rewash := '[]'::jsonb;
  end if;
  if jsonb_typeof(p_rewash) <> 'array' then
    raise exception using errcode = '22023', message = 'rewash must be an array.';
  end if;

  select * into v_batch
  from public.laundry_batches b
  where b.id = p_batch_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Batch not found.';
  end if;
  if v_batch.status <> 'fo_dirty_counted' then
    raise exception using errcode = 'P0001', message = 'Batch must be reopened to Step 1 before editing sent linen.';
  end if;

  if exists (
    select 1
    from (
      select
        (value->>'linen_item_id')::integer as linen_item_id,
        coalesce((value->>'is_dayuse')::boolean, false) as is_dayuse,
        count(*) as item_count
      from jsonb_array_elements(p_items)
      group by 1, 2
      having count(*) > 1
    ) duplicates
  ) then
    raise exception using errcode = '22023', message = 'Duplicate linen item identity.';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_linen_item_id := nullif(v_item->>'linen_item_id', '')::integer;
    v_is_dayuse := coalesce((v_item->>'is_dayuse')::boolean, false);
    v_estimated_qty := (v_item->>'estimated_qty')::integer;
    v_sent_by_hotel := (v_item->>'sent_by_hotel')::integer;
    if v_linen_item_id is null or v_linen_item_id <= 0
      or v_estimated_qty is null or v_estimated_qty < 0
      or v_sent_by_hotel is null or v_sent_by_hotel < 0
    then
      raise exception using errcode = '22023', message = 'Invalid dirty item quantities.';
    end if;
    v_item_count := v_item_count + 1;
  end loop;

  if p_consume_dayuse_accumulator then
    for v_dayuse in
      select p.id, p.linen_item_id, p.qty_accumulated
      from public.linen_dayuse_pending p
      where p.qty_accumulated > 0
      order by p.id
      for update
    loop
      if not exists (
        select 1
        from jsonb_array_elements(p_items) item
        where coalesce((item->>'is_dayuse')::boolean, false)
          and (item->>'linen_item_id')::integer = v_dayuse.linen_item_id
          and (item->>'sent_by_hotel')::integer = v_dayuse.qty_accumulated
      ) then
        raise exception using errcode = '22023', message = 'Day Use accumulator changed before save.';
      end if;
      v_dayuse_ids := array_append(v_dayuse_ids, v_dayuse.id);
    end loop;

    if exists (
      select 1
      from jsonb_array_elements(p_items) item
      where coalesce((item->>'is_dayuse')::boolean, false)
        and (item->>'sent_by_hotel')::integer > 0
        and not exists (
          select 1
          from public.linen_dayuse_pending p
          where p.linen_item_id = (item->>'linen_item_id')::integer
            and p.qty_accumulated = (item->>'sent_by_hotel')::integer
        )
    ) then
      raise exception using errcode = '22023', message = 'Day Use selection does not match the current accumulator.';
    end if;
  end if;

  delete from public.laundry_batch_items where batch_id = p_batch_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    insert into public.laundry_batch_items (
      batch_id, linen_item_id, is_dayuse, estimated_qty, sent_by_hotel
    )
    values (
      p_batch_id,
      (v_item->>'linen_item_id')::integer,
      coalesce((v_item->>'is_dayuse')::boolean, false),
      (v_item->>'estimated_qty')::integer,
      (v_item->>'sent_by_hotel')::integer
    );
  end loop;

  if jsonb_array_length(p_rewash) > 0 then
    if p_created_by is null then
      raise exception using errcode = '22023', message = 'created_by is required for rewash items.';
    end if;

    for v_rewash in select value from jsonb_array_elements(p_rewash)
    loop
      v_linen_item_id := nullif(v_rewash->>'linen_item_id', '')::integer;
      if v_linen_item_id is null or v_linen_item_id <= 0
        or nullif(v_rewash->>'qty', '')::integer is null
        or (v_rewash->>'qty')::integer <= 0
      then
        raise exception using errcode = '22023', message = 'Invalid rewash item.';
      end if;

      v_photo_keys := array(select jsonb_array_elements_text(v_rewash->'photo_keys'));
      if coalesce(array_length(v_photo_keys, 1), 0) < 1 then
        raise exception using errcode = '22023', message = 'At least one rewash photo is required.';
      end if;
      if exists (select 1 from unnest(v_photo_keys) as photo_key where photo_key not like 'rewash/linen/%') then
        raise exception using errcode = '22023', message = 'Invalid rewash photo key.';
      end if;

      if not exists (
        select 1
        from public.laundry_rewash_events r
        where r.sent_in_batch_id = p_batch_id
          and r.linen_item_id = v_linen_item_id
          and coalesce(r.is_dayuse, false) = coalesce((v_rewash->>'is_dayuse')::boolean, false)
          and r.qty = (v_rewash->>'qty')::integer
          and array(
            select existing_photo_key
            from unnest(r.photo_keys) as existing_keys(existing_photo_key)
            order by existing_photo_key
          ) = array(
            select requested_photo_key
            from unnest(v_photo_keys) as requested_keys(requested_photo_key)
            order by requested_photo_key
          )
          and coalesce(r.note, '') = coalesce(nullif(v_rewash->>'note', ''), '')
      ) then
        insert into public.laundry_rewash_events (
          sent_in_batch_id, linen_item_id, is_dayuse, qty, photo_keys, created_by, note
        )
        values (
          p_batch_id,
          v_linen_item_id,
          coalesce((v_rewash->>'is_dayuse')::boolean, false),
          (v_rewash->>'qty')::integer,
          v_photo_keys,
          p_created_by,
          nullif(v_rewash->>'note', '')
        )
        returning id into v_rewash_id;
        v_rewash_ids := array_append(v_rewash_ids, v_rewash_id);
      end if;
    end loop;
  end if;

  if p_consume_dayuse_accumulator and cardinality(v_dayuse_ids) > 0 then
    update public.linen_dayuse_pending
    set qty_accumulated = 0,
        sent_in_batch_id = p_batch_id,
        sent_at = timezone('utc', now())
    where id = any(v_dayuse_ids);
  end if;

  insert into public.laundry_batch_events (batch_id, event_type, actor_role, data)
  values (
    p_batch_id,
    'fo_dirty_counted',
    'fo',
    jsonb_build_object(
      'item_count', v_item_count,
      'edited', true,
      'rewash_item_count', cardinality(v_rewash_ids),
      'dayuse_consumed', p_consume_dayuse_accumulator and cardinality(v_dayuse_ids) > 0
    )
  );

  if cardinality(v_rewash_ids) > 0 then
    insert into public.laundry_batch_events (batch_id, event_type, actor_role, data)
    values (
      p_batch_id,
      'rewash_created',
      'fo',
      jsonb_build_object(
        'rewash_event_ids', to_jsonb(v_rewash_ids),
        'item_count', cardinality(v_rewash_ids)
      )
    );
  end if;

  return jsonb_build_object(
    'batch_id', p_batch_id,
    'item_count', v_item_count,
    'rewash_event_ids', to_jsonb(v_rewash_ids),
    'dayuse_consumed', p_consume_dayuse_accumulator and cardinality(v_dayuse_ids) > 0
  );
end;
$function$;

revoke all on function public.fn_laundry_replace_dirty_items(uuid, jsonb, jsonb, uuid, boolean) from public, anon, authenticated;
grant execute on function public.fn_laundry_replace_dirty_items(uuid, jsonb, jsonb, uuid, boolean) to service_role;

commit;
