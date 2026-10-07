-- ============================================================
-- Phase 14 Hotfix: ensure canonical day-use rooms are visible
-- ============================================================

update public.rooms
set
  is_dayuse = true,
  is_visible_on_board = true
where room_number in ('118', '120', '122');

update public.hotel_settings
set
  dayuse_rate = coalesce(dayuse_rate, 200.00),
  dayuse_duration_min = coalesce(dayuse_duration_min, 120),
  dayuse_extend_rate = coalesce(dayuse_extend_rate, 100.00),
  dayuse_extend_min = coalesce(dayuse_extend_min, 60)
where id = 1;
