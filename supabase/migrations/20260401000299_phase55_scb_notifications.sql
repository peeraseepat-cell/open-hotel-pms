-- Phase 55: SCB payment notifications

create table if not exists public.scb_payment_notifications (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid null references public.scb_payment_transactions(id) on delete set null,
  target_type text not null check (target_type in ('reservation', 'pos_order')),
  target_id uuid not null,
  title text not null,
  body text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.scb_notification_reads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  notification_id uuid not null references public.scb_payment_notifications(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists uq_scb_notification_reads_user_notification
  on public.scb_notification_reads (user_id, notification_id);

create index if not exists idx_scb_payment_notifications_is_read_created
  on public.scb_payment_notifications (is_read, created_at desc);

create index if not exists idx_scb_payment_notifications_target
  on public.scb_payment_notifications (target_type, target_id, created_at desc);

create index if not exists idx_scb_notification_reads_user_created
  on public.scb_notification_reads (user_id, created_at desc);
