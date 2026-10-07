alter table public.reservations
  add column if not exists original_checkout_date date;

