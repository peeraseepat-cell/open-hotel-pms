begin;

-- Phase 66.3: Rewash flow, monthly reopen audit, and linen edit audit.

-- ─── Rewash Events ────────────────────────────────────────────────────────────
create table if not exists public.laundry_rewash_events (
  id bigserial primary key,
  sent_in_batch_id uuid not null references public.laundry_batches(id) on delete cascade,
  linen_item_id int not null references public.linen_items(id),
  is_dayuse boolean not null default false,
  qty int not null check (qty > 0),
  photo_keys text[] not null default '{}'::text[],
  status text not null default 'pending' check (status in ('pending', 'resolved', 'expired')),
  resolved_batch_id uuid references public.laundry_batches(id),
  resolved_qty int check (resolved_qty is null or resolved_qty >= 0),
  resolved_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default timezone('utc', now()),
  note text,
  check (status <> 'pending' or coalesce(array_length(photo_keys, 1), 0) >= 1)
);

create index if not exists idx_rewash_sent_batch
  on public.laundry_rewash_events(sent_in_batch_id);
create index if not exists idx_rewash_resolved_batch
  on public.laundry_rewash_events(resolved_batch_id);
create index if not exists idx_rewash_status
  on public.laundry_rewash_events(status)
  where status = 'pending';
create index if not exists idx_rewash_created_at
  on public.laundry_rewash_events(created_at);

alter table public.laundry_rewash_events enable row level security;

drop policy if exists rewash_all_auth on public.laundry_rewash_events;
create policy rewash_all_auth on public.laundry_rewash_events
  for all to authenticated
  using (true)
  with check (true);

-- ─── Monthly Reopen Log ───────────────────────────────────────────────────────
create table if not exists public.linen_month_close_reopen_log (
  id bigserial primary key,
  year int not null,
  month int not null check (month between 1 and 12),
  close_id uuid references public.laundry_monthly_close(id),
  reopened_by uuid not null references auth.users(id),
  reopened_at timestamptz not null default timezone('utc', now()),
  reason text not null check (char_length(trim(reason)) >= 10),
  reclosed_at timestamptz,
  reclosed_by uuid references auth.users(id)
);

create index if not exists idx_reopen_log_ym
  on public.linen_month_close_reopen_log(year, month);
create index if not exists idx_reopen_log_close
  on public.linen_month_close_reopen_log(close_id);

alter table public.linen_month_close_reopen_log enable row level security;

drop policy if exists reopen_log_all_auth on public.linen_month_close_reopen_log;
create policy reopen_log_all_auth on public.linen_month_close_reopen_log
  for all to authenticated
  using (true)
  with check (true);

-- ─── Edit Audit Log ───────────────────────────────────────────────────────────
create table if not exists public.linen_edit_audit_log (
  id bigserial primary key,
  batch_id uuid references public.laundry_batches(id) on delete cascade,
  rate_id uuid references public.linen_item_rates(id),
  entity_type text not null check (entity_type in ('batch_item', 'return_item', 'extra_item', 'rewash_event', 'rate', 'note')),
  entity_id text,
  field_name text not null,
  old_value text,
  new_value text,
  reason text,
  edited_by uuid not null references auth.users(id),
  edited_at timestamptz not null default timezone('utc', now()),
  check (batch_id is not null or rate_id is not null or entity_type = 'note')
);

create index if not exists idx_edit_log_batch
  on public.linen_edit_audit_log(batch_id);
create index if not exists idx_edit_log_rate
  on public.linen_edit_audit_log(rate_id);
create index if not exists idx_edit_log_edited_at
  on public.linen_edit_audit_log(edited_at);

alter table public.linen_edit_audit_log enable row level security;

drop policy if exists edit_log_all_auth on public.linen_edit_audit_log;
create policy edit_log_all_auth on public.linen_edit_audit_log
  for all to authenticated
  using (true)
  with check (true);

-- ─── Reopen Count on Existing Monthly Close Table ─────────────────────────────
alter table public.laundry_monthly_close
  add column if not exists reopen_count int not null default 0,
  add column if not exists last_reopened_at timestamptz,
  add column if not exists last_reopen_reason text;

-- Allow rewash events to be visible in the existing batch event timeline.
alter table public.laundry_batch_events
  drop constraint if exists laundry_batch_events_event_type_check;

alter table public.laundry_batch_events
  add constraint laundry_batch_events_event_type_check
  check (event_type in (
    'created',
    'fo_dirty_counted',
    'fo_return_counted',
    'vendor_signed',
    'fo_return_signed',
    'vendor_shop_confirmed',
    'closed',
    'partial_closed',
    'disputed',
    'reopened',
    'dayuse_added',
    'pending_resolved',
    'rewash_created',
    'rewash_resolved',
    'rewash_expired',
    'edit_applied'
  ));

-- ─── Atomic Batch Create + Rewash RPC ─────────────────────────────────────────
create or replace function public.fn_create_laundry_batch_with_rewash(
  p_batch jsonb,
  p_items jsonb,
  p_rewash jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.laundry_batches%rowtype;
  v_item jsonb;
  v_rewash jsonb;
  v_rewash_event_ids bigint[] := array[]::bigint[];
  v_rewash_event_id bigint;
  v_created_by uuid := nullif(p_batch->>'created_by', '')::uuid;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'items are required';
  end if;

  if p_rewash is null then
    p_rewash := '[]'::jsonb;
  end if;

  if jsonb_typeof(p_rewash) <> 'array' then
    raise exception 'rewash must be an array';
  end if;

  insert into public.laundry_batches (
    business_date,
    pickup_round,
    vendor_name,
    status,
    created_by,
    notes
  )
  values (
    (p_batch->>'business_date')::date,
    coalesce((p_batch->>'pickup_round')::smallint, 1),
    nullif(p_batch->>'vendor_name', ''),
    'fo_dirty_counted',
    v_created_by,
    nullif(p_batch->>'notes', '')
  )
  returning * into v_batch;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.laundry_batch_items (
      batch_id,
      linen_item_id,
      is_dayuse,
      estimated_qty,
      sent_by_hotel
    )
    values (
      v_batch.id,
      (v_item->>'linen_item_id')::int,
      coalesce((v_item->>'is_dayuse')::boolean, false),
      greatest(coalesce((v_item->>'estimated_qty')::int, 0), 0),
      greatest(coalesce((v_item->>'sent_by_hotel')::int, 0), 0)
    );
  end loop;

  for v_rewash in select * from jsonb_array_elements(p_rewash)
  loop
    if coalesce(array_length(array(select jsonb_array_elements_text(v_rewash->'photo_keys')), 1), 0) < 1 then
      raise exception 'rewash photo_keys are required';
    end if;

    insert into public.laundry_rewash_events (
      sent_in_batch_id,
      linen_item_id,
      is_dayuse,
      qty,
      photo_keys,
      created_by,
      note
    )
    values (
      v_batch.id,
      (v_rewash->>'linen_item_id')::int,
      coalesce((v_rewash->>'is_dayuse')::boolean, false),
      (v_rewash->>'qty')::int,
      array(select jsonb_array_elements_text(v_rewash->'photo_keys')),
      v_created_by,
      nullif(v_rewash->>'note', '')
    )
    returning id into v_rewash_event_id;

    v_rewash_event_ids := array_append(v_rewash_event_ids, v_rewash_event_id);
  end loop;

  insert into public.laundry_batch_events (batch_id, event_type, actor_role, data)
  values
    (v_batch.id, 'created', 'fo', jsonb_build_object('pickup_round', v_batch.pickup_round)),
    (
      v_batch.id,
      'fo_dirty_counted',
      'fo',
      jsonb_build_object(
        'item_count',
        jsonb_array_length(p_items),
        'rewash_event_ids',
        to_jsonb(v_rewash_event_ids)
      )
    );

  if array_length(v_rewash_event_ids, 1) is not null then
    insert into public.laundry_batch_events (batch_id, event_type, actor_role, data)
    values (
      v_batch.id,
      'rewash_created',
      'fo',
      jsonb_build_object('rewash_event_ids', to_jsonb(v_rewash_event_ids))
    );
  end if;

  return jsonb_build_object(
    'batch_id',
    v_batch.id,
    'rewash_event_ids',
    to_jsonb(v_rewash_event_ids)
  );
end;
$$;

-- ─── Reclose/Reopen Functions (preserve reopened_at status model) ─────────────
create or replace function public.fn_linen_monthly_close(p_year int, p_month int, p_actor uuid default auth.uid())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start date := make_date(p_year, p_month, 1);
  v_end date := (make_date(p_year, p_month, 1) + interval '1 month')::date;
  v_disputed jsonb;
  v_pending jsonb;
  v_open jsonb;
  v_errors text[] := array[]::text[];
  v_total_pieces int := 0;
  v_total_baht numeric(12, 2) := 0;
  v_close public.laundry_monthly_close%rowtype;
begin
  select coalesce(jsonb_agg(b.id::text order by b.business_date, b.pickup_round), '[]'::jsonb)
  into v_disputed
  from public.laundry_batches b
  where b.business_date >= v_start
    and b.business_date < v_end
    and b.status = 'disputed';

  if jsonb_array_length(v_disputed) > 0 then
    v_errors := array_append(v_errors, 'dispute_exists');
  end if;

  select coalesce(jsonb_agg(p.id::text order by b.business_date, b.pickup_round), '[]'::jsonb)
  into v_pending
  from public.laundry_pending_items p
  join public.laundry_batches b on b.id = p.source_batch_id
  where p.resolved_batch_id is null
    and b.business_date >= v_start
    and b.business_date < v_end;

  if jsonb_array_length(v_pending) > 0 then
    v_errors := array_append(v_errors, 'pending_exists');
  end if;

  select coalesce(jsonb_agg(b.id::text order by b.business_date, b.pickup_round), '[]'::jsonb)
  into v_open
  from public.laundry_batches b
  where b.business_date >= v_start
    and b.business_date < v_end
    and b.status not in ('closed', 'partial');

  if jsonb_array_length(v_open) > 0 then
    v_errors := array_append(v_errors, 'open_batch_exists');
  end if;

  if array_length(v_errors, 1) is not null then
    return jsonb_build_object(
      'success', false,
      'close', null,
      'errors', to_jsonb(v_errors),
      'error_details', jsonb_build_object(
        'disputed_batch_ids', v_disputed,
        'pending_item_ids', v_pending,
        'open_batch_ids', v_open
      )
    );
  end if;

  select
    coalesce(sum(i.sent_by_hotel), 0)::int,
    coalesce(sum(i.sent_by_hotel * public.fn_linen_rate(i.linen_item_id, b.business_date)), 0)::numeric(12, 2)
  into v_total_pieces, v_total_baht
  from public.laundry_batches b
  join public.laundry_batch_items i on i.batch_id = b.id
  where b.business_date >= v_start
    and b.business_date < v_end;

  insert into public.laundry_monthly_close (
    year, month, closed_at, closed_by, total_pieces, total_baht,
    reopened_at, reopened_by, reopen_reason
  )
  values (p_year, p_month, timezone('utc', now()), p_actor, v_total_pieces, v_total_baht, null, null, null)
  on conflict (year, month) do update set
    closed_at = excluded.closed_at,
    closed_by = excluded.closed_by,
    total_pieces = excluded.total_pieces,
    total_baht = excluded.total_baht,
    reopened_at = null,
    reopened_by = null,
    reopen_reason = null
  returning * into v_close;

  update public.linen_month_close_reopen_log
  set reclosed_at = timezone('utc', now()),
      reclosed_by = p_actor
  where close_id = v_close.id
    and reclosed_at is null;

  return jsonb_build_object('success', true, 'close', to_jsonb(v_close));
end;
$$;

create or replace function public.fn_linen_monthly_reopen(p_year int, p_month int, p_reason text, p_actor uuid default auth.uid())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_close public.laundry_monthly_close%rowtype;
  v_reason text := trim(coalesce(p_reason, ''));
  v_log_id bigint;
begin
  if char_length(v_reason) < 10 then
    return jsonb_build_object('success', false, 'close', null, 'error', 'reason_too_short');
  end if;

  update public.laundry_monthly_close
  set reopened_at = timezone('utc', now()),
      reopened_by = p_actor,
      reopen_reason = v_reason,
      reopen_count = reopen_count + 1,
      last_reopened_at = timezone('utc', now()),
      last_reopen_reason = v_reason
  where year = p_year
    and month = p_month
    and reopened_at is null
  returning * into v_close;

  if v_close.id is null then
    return jsonb_build_object('success', false, 'close', null, 'error', 'month_not_closed');
  end if;

  insert into public.linen_month_close_reopen_log (
    year,
    month,
    close_id,
    reopened_by,
    reason
  )
  values (
    p_year,
    p_month,
    v_close.id,
    p_actor,
    v_reason
  )
  returning id into v_log_id;

  insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, after_json)
  values (
    p_actor,
    'linen_monthly_reopened',
    'laundry_monthly_close',
    v_close.id::text,
    jsonb_build_object('year', p_year, 'month', p_month, 'reason', v_reason, 'log_id', v_log_id)
  );

  return jsonb_build_object('success', true, 'close', to_jsonb(v_close), 'log_id', v_log_id);
end;
$$;

commit;
