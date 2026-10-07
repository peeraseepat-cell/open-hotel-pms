begin;

drop policy if exists passport_scans_fo_read_current_day on public.passport_scans;
create policy passport_scans_fo_read_current_day
  on public.passport_scans
  for select
  to authenticated
  using (
    public.has_any_role(array['frontdesk', 'supervisor', 'mobile']::public.user_role[])
    and (created_at at time zone 'Asia/Bangkok')::date >= (
      select hs.business_date
      from public.hotel_settings hs
      where hs.id = 1
    )
  );

drop policy if exists passport_scans_fo_insert on public.passport_scans;
create policy passport_scans_fo_insert
  on public.passport_scans
  for insert
  to authenticated
  with check (
    public.has_any_role(array['admin', 'frontdesk', 'supervisor', 'mobile']::public.user_role[])
  );

commit;
