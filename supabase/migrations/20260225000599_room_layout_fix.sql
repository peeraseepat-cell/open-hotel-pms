-- Fix 1: 226 and 326 are end of left corridor (not solo/center)
-- Fix 2: F1 rooms 106/108 sort_order correction
BEGIN;
UPDATE public.rooms SET wing = 'L' WHERE room_number IN ('226', '326');
-- Correct sort_order for F1: 106 closest to entrance
UPDATE public.rooms SET wing = 'L' WHERE room_number IN ('106', '108', '110');
UPDATE public.rooms SET sort_order = 1 WHERE room_number = '106';
UPDATE public.rooms SET sort_order = 2 WHERE room_number = '108';
UPDATE public.rooms SET sort_order = 3 WHERE room_number = '110';
COMMIT;

