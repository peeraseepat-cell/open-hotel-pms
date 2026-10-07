BEGIN;

alter table public.folio_payments enable row level security;
drop policy if exists folio_payments_service_role_full_access on public.folio_payments;
create policy folio_payments_service_role_full_access on public.folio_payments
  for all to service_role using (true) with check (true);

COMMIT;
