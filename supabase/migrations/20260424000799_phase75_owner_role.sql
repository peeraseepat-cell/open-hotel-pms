begin;

do $$
begin
  alter type public.user_role add value if not exists 'owner';
exception
  when duplicate_object then null;
end $$;

commit;
