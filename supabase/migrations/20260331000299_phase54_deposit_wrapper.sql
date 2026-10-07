begin;

create or replace function public.apply_deposit_snapshot_lines_v2(
  p_reservation_id uuid,
  p_lines jsonb default '[]'::jsonb,
  p_general_note text default null,
  p_cashier_name text default 'FO',
  p_paid_date date default null
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.apply_deposit_snapshot_lines(
    p_reservation_id,
    p_lines,
    p_general_note,
    p_cashier_name,
    p_paid_date
  );
$$;

grant execute on function public.apply_deposit_snapshot_lines_v2(uuid, jsonb, text, text, date) to authenticated, service_role;

commit;
