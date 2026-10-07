begin;

alter table public.guest_profiles
  add column if not exists night_count integer not null default 0,
  add column if not exists main_stay_count integer not null default 0,
  add column if not exists accompanying_stay_count integer not null default 0,
  add column if not exists main_night_count integer not null default 0,
  add column if not exists accompanying_night_count integer not null default 0;

comment on column public.guest_profiles.stay_count is
  'Legacy total stays counter. Phase 29+: incremented only on checkout and includes primary+accompanying roles.';
comment on column public.guest_profiles.night_count is
  'Total completed nights across all roles. Incremented only on checkout.';
comment on column public.guest_profiles.main_stay_count is
  'Completed stays where profile role was primary. Incremented only on checkout.';
comment on column public.guest_profiles.accompanying_stay_count is
  'Completed stays where profile role was accompanying. Incremented only on checkout.';
comment on column public.guest_profiles.main_night_count is
  'Completed nights where profile role was primary. Incremented only on checkout.';
comment on column public.guest_profiles.accompanying_night_count is
  'Completed nights where profile role was accompanying. Incremented only on checkout.';

create index if not exists idx_guest_profiles_main_stay_count
  on public.guest_profiles (main_stay_count desc);
create index if not exists idx_guest_profiles_accompanying_stay_count
  on public.guest_profiles (accompanying_stay_count desc);

with completed_from_party as (
  select
    rg.guest_profile_id,
    rg.role,
    greatest((r.checkout_date::date - r.checkin_date::date), 1)::int as nights,
    r.checkout_date::date as checkout_date
  from public.reservations r
  join public.reservation_guests rg
    on rg.reservation_id = r.id
  where r.status = 'checked_out'
    and rg.guest_profile_id is not null
    and rg.role in ('primary', 'accompanying')
),
completed_primary_fallback as (
  select
    r.guest_profile_id,
    'primary'::text as role,
    greatest((r.checkout_date::date - r.checkin_date::date), 1)::int as nights,
    r.checkout_date::date as checkout_date
  from public.reservations r
  where r.status = 'checked_out'
    and r.guest_profile_id is not null
    and not exists (
      select 1
      from public.reservation_guests rg
      where rg.reservation_id = r.id
        and rg.role = 'primary'
    )
),
completed_union as (
  select * from completed_from_party
  union all
  select * from completed_primary_fallback
),
stats as (
  select
    cu.guest_profile_id,
    sum(case when cu.role = 'primary' then 1 else 0 end)::int as main_stays,
    sum(case when cu.role = 'accompanying' then 1 else 0 end)::int as accompanying_stays,
    sum(case when cu.role = 'primary' then cu.nights else 0 end)::int as main_nights,
    sum(case when cu.role = 'accompanying' then cu.nights else 0 end)::int as accompanying_nights,
    max(cu.checkout_date)::date as last_stay_date
  from completed_union cu
  group by cu.guest_profile_id
)
update public.guest_profiles gp
set
  main_stay_count = coalesce(stats.main_stays, 0),
  accompanying_stay_count = coalesce(stats.accompanying_stays, 0),
  main_night_count = coalesce(stats.main_nights, 0),
  accompanying_night_count = coalesce(stats.accompanying_nights, 0),
  stay_count = coalesce(stats.main_stays, 0) + coalesce(stats.accompanying_stays, 0),
  night_count = coalesce(stats.main_nights, 0) + coalesce(stats.accompanying_nights, 0),
  last_stay_date = stats.last_stay_date
from (
  select
    gp2.id,
    st.main_stays,
    st.accompanying_stays,
    st.main_nights,
    st.accompanying_nights,
    st.last_stay_date
  from public.guest_profiles gp2
  left join stats st on st.guest_profile_id = gp2.id
) stats
where gp.id = stats.id;

commit;
