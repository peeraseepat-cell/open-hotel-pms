begin;

-- Phase 65 hotfix:
-- daily_snapshots can now hold pre-EOD stock reconcile state, so row existence
-- can no longer mean "Night Audit closed this business date".
alter table public.daily_snapshots
  add column if not exists is_eod_closed boolean not null default false;

update public.daily_snapshots ds
set is_eod_closed = true
where ds.business_date < coalesce(
  (select hs.business_date from public.hotel_settings hs where hs.id = 1),
  current_date
);

comment on column public.daily_snapshots.is_eod_closed is
  'True only when Night Audit/EOD has actually closed the date. Phase 65 stock reconcile may create/update rows before close.';

commit;
