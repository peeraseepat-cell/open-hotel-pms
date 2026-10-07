-- Phase 14 hotfix: some environments do not have rooms 118/120/122 yet.
-- Ensure canonical Day Use rooms exist and are visible on board/diary.

BEGIN;

WITH target_rooms AS (
  SELECT *
  FROM (
    VALUES
      ('118'::text, 4::int),
      ('120'::text, 5::int),
      ('122'::text, 6::int)
  ) AS v(room_number, sort_order)
),
preferred_type AS (
  SELECT room_type_id AS id
  FROM public.rooms
  WHERE room_number IN ('106', '108')
  ORDER BY room_number
  LIMIT 1
),
fallback_type AS (
  SELECT id
  FROM public.room_types
  WHERE code <> 'CLOSED'
  ORDER BY sort_order ASC, id ASC
  LIMIT 1
),
resolved_type AS (
  SELECT id FROM preferred_type
  UNION ALL
  SELECT id FROM fallback_type
  LIMIT 1
)
INSERT INTO public.rooms (
  room_number,
  room_type_id,
  is_sellable,
  is_visible_on_board,
  closure_reason,
  sort_order,
  floor_number,
  wing,
  is_dayuse
)
SELECT
  tr.room_number,
  rt.id,
  true,
  true,
  null,
  tr.sort_order,
  1,
  'R',
  true
FROM target_rooms tr
CROSS JOIN resolved_type rt
ON CONFLICT (room_number) DO UPDATE
SET
  floor_number = EXCLUDED.floor_number,
  wing = EXCLUDED.wing,
  sort_order = EXCLUDED.sort_order,
  is_dayuse = true,
  is_visible_on_board = true,
  is_sellable = true,
  closure_reason = null,
  room_type_id = COALESCE(public.rooms.room_type_id, EXCLUDED.room_type_id),
  updated_at = timezone('utc', now());

UPDATE public.rooms
SET
  is_dayuse = true,
  is_visible_on_board = true,
  is_sellable = true,
  closure_reason = null,
  floor_number = 1,
  wing = 'R',
  sort_order = CASE room_number
    WHEN '118' THEN 4
    WHEN '120' THEN 5
    WHEN '122' THEN 6
    ELSE sort_order
  END,
  updated_at = timezone('utc', now())
WHERE room_number IN ('118', '120', '122');

INSERT INTO public.room_layouts (room_id, view_type, grid_x, grid_y, zone, sort_order)
SELECT
  r.id,
  vt.view_type,
  null,
  null,
  'building',
  r.sort_order
FROM public.rooms r
CROSS JOIN (
  VALUES
    ('month'::text),
    ('week'::text),
    ('day'::text)
) AS vt(view_type)
WHERE r.room_number IN ('118', '120', '122')
ON CONFLICT (room_id, view_type) DO UPDATE
SET
  zone = EXCLUDED.zone,
  sort_order = EXCLUDED.sort_order;

COMMIT;
