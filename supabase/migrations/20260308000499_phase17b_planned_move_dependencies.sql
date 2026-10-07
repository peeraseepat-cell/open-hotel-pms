begin;

alter table public.reservation_nights
  add column if not exists assignment_source text;

alter table public.reservation_nights
  add column if not exists dependency_plan_id uuid references public.reservation_room_plans(id) on delete set null;

alter table public.reservation_nights
  add column if not exists dependency_reason text;

alter table public.reservation_nights
  drop constraint if exists reservation_nights_assignment_source_check;

alter table public.reservation_nights
  add constraint reservation_nights_assignment_source_check
  check (
    assignment_source is null
    or assignment_source in ('manual', 'auto_assign', 'planned_move_release')
  );

create index if not exists idx_reservation_nights_dependency_plan_id
  on public.reservation_nights (dependency_plan_id)
  where dependency_plan_id is not null and cancelled_at is null;

create index if not exists idx_reservation_nights_room_date_dependency
  on public.reservation_nights (room_id, stay_date, dependency_plan_id)
  where cancelled_at is null;

comment on column public.reservation_nights.assignment_source is
  'How this room assignment was produced: manual, auto_assign, or planned_move_release.';

comment on column public.reservation_nights.dependency_plan_id is
  'If assignment_source=planned_move_release, this links the room assignment to the reservation_room_plans row that released the source room.';

comment on column public.reservation_nights.dependency_reason is
  'Human-readable explanation for plan-dependent room assignment.';

commit;
