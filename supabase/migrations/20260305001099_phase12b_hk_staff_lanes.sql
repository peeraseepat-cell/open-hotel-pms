begin;

-- Phase 12B hotfix: operational staff lanes independent from auth-linked staff

create table if not exists public.hk_staff_lanes (
  id uuid primary key default gen_random_uuid(),
  display_name text not null unique,
  nickname text,
  department_code text not null default 'HK'
    check (department_code in ('FO', 'HK', 'MNT', 'FB', 'SEC')),
  is_active boolean not null default true,
  hk_lane_enabled boolean not null default true,
  hk_lane_order integer not null default 100
    check (hk_lane_order between 1 and 999),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_hk_staff_lanes_active_order
  on public.hk_staff_lanes (is_active, hk_lane_enabled, hk_lane_order, display_name);

drop trigger if exists trg_hk_staff_lanes_updated_at on public.hk_staff_lanes;
create trigger trg_hk_staff_lanes_updated_at
before update on public.hk_staff_lanes
for each row execute function public.set_updated_at();

-- seed baseline names used by HK workflow
insert into public.hk_staff_lanes (display_name, department_code, hk_lane_enabled, hk_lane_order, is_active)
values
  ('Jan', 'HK', true, 1, true),
  ('Tan', 'HK', true, 2, true),
  ('Others', 'HK', true, 999, true)
on conflict (display_name) do nothing;

commit;
