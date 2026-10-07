alter table public.reservations
  add column if not exists discount_type text not null default 'percent',
  add column if not exists discount_value numeric(10,2) not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'reservations_discount_type_check'
  ) then
    alter table public.reservations
      add constraint reservations_discount_type_check
      check (discount_type in ('percent', 'fixed_total', 'fixed_per_night'));
  end if;
end $$;

update public.reservations
set
  discount_type = 'percent',
  discount_value = coalesce(discount_percent, 0)
where coalesce(discount_type, '') not in ('percent', 'fixed_total', 'fixed_per_night')
   or coalesce(discount_value, 0) = 0;
