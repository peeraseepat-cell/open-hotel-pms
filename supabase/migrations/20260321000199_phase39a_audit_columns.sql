begin;

alter table public.audit_logs
  add column if not exists business_date date;

alter table public.audit_logs
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'system', 'api', 'night_audit'));

alter table public.audit_logs
  add column if not exists note text;

create index if not exists idx_audit_logs_business_date
  on public.audit_logs (business_date desc, created_at desc);

create index if not exists idx_audit_logs_entity_lookup
  on public.audit_logs (entity_type, entity_id, created_at desc);

create index if not exists idx_audit_logs_action
  on public.audit_logs (action);

update public.audit_logs
set business_date = (created_at at time zone 'Asia/Bangkok')::date
where business_date is null;

commit;
