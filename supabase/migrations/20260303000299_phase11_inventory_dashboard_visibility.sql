begin;

alter table public.products
  add column if not exists show_on_inventory_dashboard boolean not null default true;

create index if not exists idx_products_show_on_inventory_dashboard
  on public.products (show_on_inventory_dashboard);

comment on column public.products.show_on_inventory_dashboard is
  'When true, product is shown in Inventory Dashboard Floor Stock detail section.';

commit;
