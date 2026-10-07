begin;

-- ============================================================
-- Phase 12C Revised: Freeform Logbook Board
-- - logbook_notes
-- - logbook_note_links
-- - logbook_note_mentions
-- ============================================================

create table if not exists public.logbook_notes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  note_type text not null default 'general'
    check (note_type in ('general', 'task', 'urgent', 'stock', 'vip')),
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'resolved')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  x int not null default 40,
  y int not null default 40,
  width int not null default 320,
  height int not null default 220,
  z_index int not null default 1,
  is_minimized boolean not null default false,
  remind_at timestamptz,
  created_by uuid not null references public.staff(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.logbook_note_links (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.logbook_notes(id) on delete cascade,
  link_type text not null
    check (link_type in ('room', 'guest', 'stock', 'staff')),
  ref_id uuid,
  ref_code text,
  label text not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint chk_logbook_link_ref_not_null
    check (ref_id is not null or ref_code is not null)
);

-- Convention: stock links use ref_code='stock' and ref_id=null.
create table if not exists public.logbook_note_mentions (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.logbook_notes(id) on delete cascade,
  mention_type text not null
    check (mention_type in ('staff', 'group_all', 'group_frontdesk')),
  staff_id uuid references public.staff(id) on delete cascade,
  is_acknowledged boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  constraint chk_logbook_mention_staff
    check (
      (mention_type = 'staff' and staff_id is not null)
      or (mention_type in ('group_all', 'group_frontdesk') and staff_id is null)
    )
);

drop trigger if exists trg_logbook_notes_updated_at on public.logbook_notes;
drop trigger if exists set_logbook_notes_updated_at on public.logbook_notes;
create trigger trg_logbook_notes_updated_at
before update on public.logbook_notes
for each row execute function public.set_updated_at();

create index if not exists idx_logbook_notes_updated_at
  on public.logbook_notes (updated_at desc);
create index if not exists idx_logbook_notes_created_by
  on public.logbook_notes (created_by);
create index if not exists idx_logbook_notes_status
  on public.logbook_notes (status);
create index if not exists idx_logbook_notes_type
  on public.logbook_notes (note_type);
create index if not exists idx_logbook_notes_zindex
  on public.logbook_notes (z_index);

create index if not exists idx_logbook_links_note_type
  on public.logbook_note_links (note_id, link_type);
create index if not exists idx_logbook_links_ref_id
  on public.logbook_note_links (ref_id);
create index if not exists idx_logbook_links_ref_code
  on public.logbook_note_links (ref_code);

create index if not exists idx_logbook_mentions_note
  on public.logbook_note_mentions (note_id);
create index if not exists idx_logbook_mentions_staff
  on public.logbook_note_mentions (staff_id);

create unique index if not exists idx_logbook_mentions_unique_staff
  on public.logbook_note_mentions (note_id, staff_id)
  where mention_type = 'staff';
create unique index if not exists idx_logbook_mentions_unique_group
  on public.logbook_note_mentions (note_id, mention_type)
  where mention_type in ('group_all', 'group_frontdesk');

alter table public.logbook_notes enable row level security;
alter table public.logbook_note_links enable row level security;
alter table public.logbook_note_mentions enable row level security;

drop policy if exists logbook_notes_select_authenticated on public.logbook_notes;
create policy logbook_notes_select_authenticated
on public.logbook_notes
for select
to authenticated
using (true);

drop policy if exists logbook_notes_insert_self on public.logbook_notes;
create policy logbook_notes_insert_self
on public.logbook_notes
for insert
to authenticated
with check (created_by = auth.uid());

drop policy if exists logbook_notes_update_owner_or_admin on public.logbook_notes;
create policy logbook_notes_update_owner_or_admin
on public.logbook_notes
for update
to authenticated
using (
  created_by = auth.uid()
  or exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  )
)
with check (
  created_by = auth.uid()
  or exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  )
);

drop policy if exists logbook_notes_delete_owner_or_admin on public.logbook_notes;
create policy logbook_notes_delete_owner_or_admin
on public.logbook_notes
for delete
to authenticated
using (
  created_by = auth.uid()
  or exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.role in ('admin', 'supervisor')
  )
);

drop policy if exists logbook_note_links_select_authenticated on public.logbook_note_links;
create policy logbook_note_links_select_authenticated
on public.logbook_note_links
for select
to authenticated
using (true);

drop policy if exists logbook_note_links_insert_manage_note on public.logbook_note_links;
create policy logbook_note_links_insert_manage_note
on public.logbook_note_links
for insert
to authenticated
with check (
  exists (
    select 1
    from public.logbook_notes n
    where n.id = note_id
      and (
        n.created_by = auth.uid()
        or exists (
          select 1
          from public.profiles p
          where p.user_id = auth.uid()
            and p.role in ('admin', 'supervisor')
        )
      )
  )
);

drop policy if exists logbook_note_links_delete_manage_note on public.logbook_note_links;
create policy logbook_note_links_delete_manage_note
on public.logbook_note_links
for delete
to authenticated
using (
  exists (
    select 1
    from public.logbook_notes n
    where n.id = note_id
      and (
        n.created_by = auth.uid()
        or exists (
          select 1
          from public.profiles p
          where p.user_id = auth.uid()
            and p.role in ('admin', 'supervisor')
        )
      )
  )
);

drop policy if exists logbook_note_mentions_select_authenticated on public.logbook_note_mentions;
create policy logbook_note_mentions_select_authenticated
on public.logbook_note_mentions
for select
to authenticated
using (true);

drop policy if exists logbook_note_mentions_insert_manage_note on public.logbook_note_mentions;
create policy logbook_note_mentions_insert_manage_note
on public.logbook_note_mentions
for insert
to authenticated
with check (
  exists (
    select 1
    from public.logbook_notes n
    where n.id = note_id
      and (
        n.created_by = auth.uid()
        or exists (
          select 1
          from public.profiles p
          where p.user_id = auth.uid()
            and p.role in ('admin', 'supervisor')
        )
      )
  )
);

drop policy if exists logbook_note_mentions_update_manage_note on public.logbook_note_mentions;
create policy logbook_note_mentions_update_manage_note
on public.logbook_note_mentions
for update
to authenticated
using (
  exists (
    select 1
    from public.logbook_notes n
    where n.id = note_id
      and (
        n.created_by = auth.uid()
        or exists (
          select 1
          from public.profiles p
          where p.user_id = auth.uid()
            and p.role in ('admin', 'supervisor')
        )
      )
  )
)
with check (
  exists (
    select 1
    from public.logbook_notes n
    where n.id = note_id
      and (
        n.created_by = auth.uid()
        or exists (
          select 1
          from public.profiles p
          where p.user_id = auth.uid()
            and p.role in ('admin', 'supervisor')
        )
      )
  )
);

drop policy if exists logbook_note_mentions_delete_manage_note on public.logbook_note_mentions;
create policy logbook_note_mentions_delete_manage_note
on public.logbook_note_mentions
for delete
to authenticated
using (
  exists (
    select 1
    from public.logbook_notes n
    where n.id = note_id
      and (
        n.created_by = auth.uid()
        or exists (
          select 1
          from public.profiles p
          where p.user_id = auth.uid()
            and p.role in ('admin', 'supervisor')
        )
      )
  )
);

commit;
