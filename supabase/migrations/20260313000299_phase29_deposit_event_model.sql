begin;

alter table public.folio_payments
  add column if not exists is_record_only boolean not null default false;

comment on column public.folio_payments.is_record_only is
  'True = ledger trace only. Visible in folio but excluded from outstanding balance math.';

create index if not exists idx_folio_payments_reservation_record_only
  on public.folio_payments (reservation_id, is_record_only);

create or replace function public.normalize_deposit_method_text(p_raw text)
returns public.payment_method_type
language plpgsql
immutable
as $$
declare
  v_value text := lower(trim(coalesce(p_raw, '')));
begin
  if v_value = 'cash' then return 'cash'; end if;
  if v_value = 'transfer' then return 'transfer'; end if;
  if v_value = 'credit_card' then return 'credit_card'; end if;
  if v_value = 'other' then return 'other'; end if;
  if v_value like '%promptpay%' then return 'transfer'; end if;
  if v_value like '%bank transfer%' then return 'transfer'; end if;
  if v_value like '%transfer%' then return 'transfer'; end if;
  if v_value like '%credit%' then return 'credit_card'; end if;
  if v_value like '%card%' then return 'credit_card'; end if;
  if v_value like '%cash%' then return 'cash'; end if;
  return 'other';
end;
$$;

create or replace function public.parse_deposit_snapshot_lines(
  p_note text,
  p_amount numeric
)
returns table (
  method public.payment_method_type,
  amount numeric(10,2),
  note text
)
language plpgsql
immutable
as $$
declare
  v_total numeric(10,2) := round(coalesce(p_amount, 0)::numeric, 2);
  v_note_text text := nullif(trim(coalesce(p_note, '')), '');
  v_parsed jsonb;
  v_lines_total numeric(10,2);
begin
  if v_total <= 0 then
    return;
  end if;

  if v_note_text is null then
    return query
    select 'other'::public.payment_method_type, v_total, null::text;
    return;
  end if;

  begin
    v_parsed := v_note_text::jsonb;
  exception when others then
    v_parsed := null;
  end;

  if v_parsed is not null and jsonb_typeof(v_parsed) = 'object' and jsonb_typeof(v_parsed -> 'lines') = 'array' then
    select round(coalesce(sum((entry ->> 'amount')::numeric), 0), 2)
    into v_lines_total
    from jsonb_array_elements(v_parsed -> 'lines') entry
    where coalesce((entry ->> 'amount')::numeric, 0) > 0;

    if abs(coalesce(v_lines_total, 0) - v_total) <= 0.01 then
      return query
      select
        public.normalize_deposit_method_text(entry ->> 'method') as method,
        round((entry ->> 'amount')::numeric, 2) as amount,
        nullif(trim(coalesce(entry ->> 'note', '')), '') as note
      from jsonb_array_elements(v_parsed -> 'lines') entry
      where coalesce((entry ->> 'amount')::numeric, 0) > 0;
      return;
    end if;
  end if;

  return query
  select public.normalize_deposit_method_text(v_note_text), v_total, v_note_text;
end;
$$;

insert into public.folio_payments (
  reservation_id,
  tx_type,
  method,
  amount,
  note,
  paid_at,
  paid_date,
  revenue_category,
  cashier_name,
  is_record_only
)
select
  r.id,
  'deposit',
  line.method,
  line.amount,
  line.note,
  coalesce(r.deposit_paid_at, timezone('utc', now())),
  (coalesce(r.deposit_paid_at, timezone('utc', now())) at time zone 'Asia/Bangkok')::date,
  'deposit',
  'FO',
  false
from public.reservations r
cross join lateral public.parse_deposit_snapshot_lines(r.deposit_note, r.deposit_amount) as line
where coalesce(r.deposit_amount, 0) > 0
  and not exists (
    select 1
    from public.folio_payments fp
    where fp.reservation_id = r.id
      and fp.revenue_category = 'deposit'
      and coalesce(fp.is_record_only, false) = false
  );

create or replace function public.apply_deposit_snapshot_lines(
  p_reservation_id uuid,
  p_lines jsonb default '[]'::jsonb,
  p_general_note text default null,
  p_cashier_name text default 'FO'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations%rowtype;
  v_lines jsonb := coalesce(p_lines, '[]'::jsonb);
  v_general_note text := nullif(trim(coalesce(p_general_note, '')), '');
  v_cashier_name text := nullif(trim(coalesce(p_cashier_name, '')), '');
  v_now timestamptz := timezone('utc', now());
  v_paid_date date := (v_now at time zone 'Asia/Bangkok')::date;
  v_method public.payment_method_type;
  v_current_amount numeric(10,2);
  v_target_amount numeric(10,2);
  v_diff numeric(10,2);
  v_note text;
  v_total numeric(10,2);
  v_snapshot_note text;
  v_last_paid_at timestamptz;
begin
  if p_reservation_id is null then
    raise exception 'reservation_id is required';
  end if;

  if jsonb_typeof(v_lines) is distinct from 'array' then
    raise exception 'deposit lines must be a JSON array';
  end if;

  select *
  into v_reservation
  from public.reservations
  where id = p_reservation_id
  for update;

  if v_reservation.id is null then
    raise exception 'Reservation not found';
  end if;

  for v_method, v_target_amount, v_note in
    select
      public.normalize_deposit_method_text(item ->> 'method') as method,
      round(coalesce((item ->> 'amount')::numeric, 0), 2) as amount,
      nullif(trim(coalesce(item ->> 'note', '')), '') as note
    from jsonb_array_elements(v_lines) as item
  loop
    if v_target_amount <= 0 then
      raise exception 'deposit line amount must be greater than 0';
    end if;
  end loop;

  for v_method in
    select unnest(enum_range(null::public.payment_method_type))
  loop
    select round(
      coalesce(
        sum(
          case
            when fp.tx_type = 'deposit' then fp.amount
            when fp.tx_type = 'refund' then -fp.amount
            else 0
          end
        ),
        0
      ),
      2
    )
    into v_current_amount
    from public.folio_payments fp
    where fp.reservation_id = p_reservation_id
      and fp.revenue_category = 'deposit'
      and coalesce(fp.is_record_only, false) = false
      and fp.method = v_method;

    select round(
      coalesce(sum((item ->> 'amount')::numeric), 0),
      2
    )
    into v_target_amount
    from jsonb_array_elements(v_lines) item
    where public.normalize_deposit_method_text(item ->> 'method') = v_method;

    select nullif(trim(coalesce(item ->> 'note', '')), '')
    into v_note
    from jsonb_array_elements(v_lines) item
    where public.normalize_deposit_method_text(item ->> 'method') = v_method
    order by (item ->> 'amount')::numeric desc
    limit 1;

    v_current_amount := coalesce(v_current_amount, 0);
    v_target_amount := coalesce(v_target_amount, 0);
    v_diff := round(v_target_amount - v_current_amount, 2);

    if v_diff > 0 then
      insert into public.folio_payments (
        reservation_id,
        tx_type,
        method,
        amount,
        note,
        paid_at,
        paid_date,
        revenue_category,
        cashier_name,
        is_record_only
      )
      values (
        p_reservation_id,
        'deposit',
        v_method,
        v_diff,
        coalesce(v_note, 'Deposit collected'),
        v_now,
        v_paid_date,
        'deposit',
        coalesce(v_cashier_name, 'FO'),
        false
      );
    elsif v_diff < 0 then
      insert into public.folio_payments (
        reservation_id,
        tx_type,
        method,
        amount,
        note,
        paid_at,
        paid_date,
        revenue_category,
        cashier_name,
        is_record_only
      )
      values (
        p_reservation_id,
        'refund',
        v_method,
        abs(v_diff),
        coalesce(v_note, 'Deposit refund'),
        v_now,
        v_paid_date,
        'deposit',
        coalesce(v_cashier_name, 'FO'),
        false
      );
    end if;
  end loop;

  select round(
    coalesce(
      sum(
        case
          when fp.tx_type = 'deposit' then fp.amount
          when fp.tx_type = 'refund' then -fp.amount
          else 0
        end
      ),
      0
    ),
    2
  )
  into v_total
  from public.folio_payments fp
  where fp.reservation_id = p_reservation_id
    and fp.revenue_category = 'deposit'
    and coalesce(fp.is_record_only, false) = false;

  select max(fp.paid_at)
  into v_last_paid_at
  from public.folio_payments fp
  where fp.reservation_id = p_reservation_id
    and fp.revenue_category = 'deposit'
    and fp.tx_type = 'deposit'
    and coalesce(fp.is_record_only, false) = false;

  select case
      when jsonb_array_length(v_lines) = 0 and v_general_note is null then null
      else jsonb_strip_nulls(
        jsonb_build_object(
          'lines',
          coalesce(
            (
              select jsonb_agg(
                jsonb_strip_nulls(
                  jsonb_build_object(
                    'method', public.normalize_deposit_method_text(item ->> 'method'),
                    'amount', round((item ->> 'amount')::numeric, 2),
                    'note', nullif(trim(coalesce(item ->> 'note', '')), '')
                  )
                )
              )
              from jsonb_array_elements(v_lines) item
            ),
            '[]'::jsonb
          ),
          'note',
          v_general_note
        )
      )::text
    end
  into v_snapshot_note;

  update public.reservations
  set deposit_amount = coalesce(v_total, 0),
      deposit_paid_at = case when coalesce(v_total, 0) > 0 then coalesce(v_last_paid_at, v_now) else null end,
      deposit_note = v_snapshot_note,
      updated_at = v_now
  where id = p_reservation_id;

  return jsonb_build_object(
    'success', true,
    'reservation_id', p_reservation_id,
    'deposit_amount', coalesce(v_total, 0),
    'deposit_paid_at', case when coalesce(v_total, 0) > 0 then coalesce(v_last_paid_at, v_now) else null end,
    'deposit_note', v_snapshot_note
  );
end;
$$;

grant execute on function public.apply_deposit_snapshot_lines(uuid, jsonb, text, text) to authenticated, service_role;

commit;
