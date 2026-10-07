begin;

create table if not exists public.extra_fee_templates (
  code text primary key,
  name text not null,
  default_price numeric(10,2) not null default 0,
  category text not null default 'service',
  icon text,
  is_active boolean not null default true,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint extra_fee_templates_category_check
    check (category in ('service', 'penalty', 'damage', 'policy'))
);

create index if not exists idx_extra_fee_templates_sort
  on public.extra_fee_templates (sort_order, code);

alter table public.extra_fee_templates enable row level security;
drop policy if exists extra_fee_templates_service_role_full_access on public.extra_fee_templates;
create policy extra_fee_templates_service_role_full_access on public.extra_fee_templates
for all to service_role
using (true)
with check (true);

insert into public.extra_fee_templates (code, name, default_price, category, icon, is_active, sort_order)
values
  ('EXTRA_PERSON', 'Extra Person', 300, 'service', '👤', true, 10),
  ('EXTRA_PILLOW', 'Extra Pillow', 50, 'service', '🛏️', true, 20),
  ('EXTRA_TOWEL', 'Extra Towel', 50, 'service', '🪥', true, 30),
  ('EXTRA_BED_CHARGE', 'Extra Bed Charge', 500, 'service', '🛏️', true, 40),
  ('EXTRA_CLEANING', 'Extra Cleaning Fee', 500, 'damage', '🧹', true, 50),
  ('DAMAGE_FEE', 'Damage Fee', 0, 'damage', '⚠️', true, 60),
  ('SHORTEN_FEE', 'Early Departure Fee', 0, 'penalty', '📅', true, 70),
  ('CANCEL_FEE', 'Cancellation Fee', 0, 'penalty', '❌', true, 80),
  ('EARLY_CHECKIN_FEE', 'Early Check-in Fee', 0, 'policy', '🌅', true, 90),
  ('LATE_CHECKOUT_FEE', 'Late Check-out Fee', 0, 'policy', '🕓', true, 100)
on conflict (code) do update
set
  name = excluded.name,
  default_price = excluded.default_price,
  category = excluded.category,
  icon = excluded.icon,
  is_active = excluded.is_active,
  sort_order = excluded.sort_order;

alter table public.folio_payments
  add column if not exists fee_template_code text references public.extra_fee_templates(code) on delete set null;

create index if not exists idx_folio_payments_fee_template_code
  on public.folio_payments (fee_template_code);

alter table public.reservation_traces
  add column if not exists due_date date;

create index if not exists idx_reservation_traces_due_date
  on public.reservation_traces (due_date)
  where due_date is not null;

alter table public.loan_items
  add column if not exists requires_hk_collection boolean not null default false;

update public.loan_items
set requires_hk_collection = true
where code in ('EXTRA_BED', 'EXTRA_PILLOW', 'EXTRA_TOWEL');

commit;
