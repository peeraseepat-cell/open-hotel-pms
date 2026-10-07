begin;

-- Phase 12B Hotfix: make HK lanes dynamic from staff directory

alter table public.staff
  add column if not exists hk_lane_enabled boolean not null default false,
  add column if not exists hk_lane_order integer not null default 100;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_staff_hk_lane_order'
      and conrelid = 'public.staff'::regclass
  ) then
    alter table public.staff
      add constraint chk_staff_hk_lane_order check (hk_lane_order between 1 and 999);
  end if;
end
$$;

create index if not exists idx_staff_hk_lane_enabled_order
  on public.staff (hk_lane_enabled, hk_lane_order, display_name);

-- Backfill: current HK staff are lane-enabled by default
update public.staff s
set hk_lane_enabled = true
from public.departments d
where s.department_id = d.id
  and d.code = 'HK'
  and s.hk_lane_enabled is distinct from true;

commit;
