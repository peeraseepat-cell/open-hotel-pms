-- Add missing renovation rooms on Floor 3 Right wing
-- Required for Room Diary ordering after 334 => 332, 330, 328

BEGIN;

WITH closed_type AS (
  SELECT id
  FROM public.room_types
  WHERE code = 'CLOSED'
  UNION ALL
  SELECT room_type_id AS id
  FROM public.rooms
  WHERE room_number = '334'
  LIMIT 1
),
target_rooms AS (
  SELECT *
  FROM (
    VALUES
      ('332'::text, 10::int),
      ('330'::text, 11::int),
      ('328'::text, 12::int)
  ) AS v(room_number, sort_order)
)
INSERT INTO public.rooms (
  room_number,
  room_type_id,
  is_sellable,
  is_visible_on_board,
  closure_reason,
  floor_number,
  wing,
  sort_order
)
SELECT
  tr.room_number,
  ct.id,
  false,
  true,
  'Renovation',
  3,
  'R',
  tr.sort_order
FROM target_rooms tr
CROSS JOIN closed_type ct
ON CONFLICT (room_number) DO UPDATE
SET
  room_type_id = EXCLUDED.room_type_id,
  is_sellable = EXCLUDED.is_sellable,
  is_visible_on_board = EXCLUDED.is_visible_on_board,
  closure_reason = EXCLUDED.closure_reason,
  floor_number = EXCLUDED.floor_number,
  wing = EXCLUDED.wing,
  sort_order = EXCLUDED.sort_order;

INSERT INTO public.room_layouts (room_id, view_type, grid_x, grid_y, zone, sort_order)
SELECT
  r.id,
  vt.view_type,
  NULL,
  NULL,
  'building',
  r.sort_order
FROM public.rooms r
CROSS JOIN (
  VALUES
    ('month'::text),
    ('week'::text),
    ('day'::text)
) AS vt(view_type)
WHERE r.room_number IN ('332', '330', '328')
ON CONFLICT (room_id, view_type) DO UPDATE
SET
  zone = EXCLUDED.zone,
  sort_order = EXCLUDED.sort_order;

COMMIT;
