-- =============================================================
-- Room Layout: floor_number, sort_order, wing
-- Phase F1: Add physical location data for proximity scoring
-- Created: 2026-02-25
-- =============================================================
-- sort_order = bay number from stair end (1 = closest to stair, ascending away)
-- wing: 'L' = left corridor, 'R' = right corridor, 'C' = single/no pair
-- Large rooms (Triple/Junior Suite) occupy 2 bays → sort_order uses the first bay number
-- Across-corridor pairs share the same sort_order
-- =============================================================

BEGIN;

-- ── Add columns to rooms ─────────────────────────────────────

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS floor_number int,
  ADD COLUMN IF NOT EXISTS sort_order   int,
  ADD COLUMN IF NOT EXISTS wing         text CHECK (wing IN ('L', 'R', 'C'));

-- ── Floor 1 — Family Rooms (Building Annex) ──────────────────
-- 3 large Family rooms with angled/chevron walls
-- 110 = OOC normally, not for sale unless fully booked

UPDATE public.rooms SET floor_number=1, wing='L', sort_order=1 WHERE room_number='106';
UPDATE public.rooms SET floor_number=1, wing='C', sort_order=2 WHERE room_number='108';
UPDATE public.rooms SET floor_number=1, wing='R', sort_order=3 WHERE room_number='110';

-- ── Floor 2 — Main Building ───────────────────────────────────
-- LEFT wing: 202–226, ascending sort_order away from stair
-- RIGHT wing: 250–228, ascending sort_order away from stair (mirrors left)
-- Large rooms 206 (Triple) + 246 (Junior Suite) occupy sort_order 3 (2 bays wide)
-- 226 is at sort_order 13, single room (no pair across), wing='C'

-- Left wing (L)
UPDATE public.rooms SET floor_number=2, wing='L', sort_order=1  WHERE room_number='202';
UPDATE public.rooms SET floor_number=2, wing='L', sort_order=2  WHERE room_number='204';
UPDATE public.rooms SET floor_number=2, wing='L', sort_order=3  WHERE room_number='206'; -- Triple Beds (2-bay room)
UPDATE public.rooms SET floor_number=2, wing='L', sort_order=5  WHERE room_number='210';
UPDATE public.rooms SET floor_number=2, wing='L', sort_order=6  WHERE room_number='212';
UPDATE public.rooms SET floor_number=2, wing='L', sort_order=7  WHERE room_number='214';
UPDATE public.rooms SET floor_number=2, wing='L', sort_order=8  WHERE room_number='216';
UPDATE public.rooms SET floor_number=2, wing='L', sort_order=9  WHERE room_number='218';
UPDATE public.rooms SET floor_number=2, wing='L', sort_order=10 WHERE room_number='220';
UPDATE public.rooms SET floor_number=2, wing='L', sort_order=11 WHERE room_number='222';
UPDATE public.rooms SET floor_number=2, wing='L', sort_order=12 WHERE room_number='224';
UPDATE public.rooms SET floor_number=2, wing='C', sort_order=13 WHERE room_number='226'; -- single at end

-- Right wing (R) — mirrors left, same sort_order as across-corridor partner
UPDATE public.rooms SET floor_number=2, wing='R', sort_order=1  WHERE room_number='250';
UPDATE public.rooms SET floor_number=2, wing='R', sort_order=2  WHERE room_number='248';
UPDATE public.rooms SET floor_number=2, wing='R', sort_order=3  WHERE room_number='246'; -- Junior Suite King (2-bay room)
UPDATE public.rooms SET floor_number=2, wing='R', sort_order=5  WHERE room_number='242';
UPDATE public.rooms SET floor_number=2, wing='R', sort_order=6  WHERE room_number='240';
UPDATE public.rooms SET floor_number=2, wing='R', sort_order=7  WHERE room_number='238';
UPDATE public.rooms SET floor_number=2, wing='R', sort_order=8  WHERE room_number='236';
UPDATE public.rooms SET floor_number=2, wing='R', sort_order=9  WHERE room_number='234';
UPDATE public.rooms SET floor_number=2, wing='R', sort_order=10 WHERE room_number='232';
UPDATE public.rooms SET floor_number=2, wing='R', sort_order=11 WHERE room_number='230';
UPDATE public.rooms SET floor_number=2, wing='R', sort_order=12 WHERE room_number='228';

-- ── Floor 3 — Main Building (same layout as Floor 2) ─────────
-- 306 = Junior Suite King (L, sort=3), 346 = Triple Beds (R, sort=3)
-- 326 = single at end (C, sort=13)

-- Left wing (L)
UPDATE public.rooms SET floor_number=3, wing='L', sort_order=1  WHERE room_number='302';
UPDATE public.rooms SET floor_number=3, wing='L', sort_order=2  WHERE room_number='304';
UPDATE public.rooms SET floor_number=3, wing='L', sort_order=3  WHERE room_number='306'; -- Junior Suite King (2-bay room)
UPDATE public.rooms SET floor_number=3, wing='L', sort_order=5  WHERE room_number='310';
UPDATE public.rooms SET floor_number=3, wing='L', sort_order=6  WHERE room_number='312';
UPDATE public.rooms SET floor_number=3, wing='L', sort_order=7  WHERE room_number='314';
UPDATE public.rooms SET floor_number=3, wing='L', sort_order=8  WHERE room_number='316';
UPDATE public.rooms SET floor_number=3, wing='L', sort_order=9  WHERE room_number='318';
UPDATE public.rooms SET floor_number=3, wing='L', sort_order=10 WHERE room_number='320';
UPDATE public.rooms SET floor_number=3, wing='L', sort_order=11 WHERE room_number='322';
UPDATE public.rooms SET floor_number=3, wing='L', sort_order=12 WHERE room_number='324';
UPDATE public.rooms SET floor_number=3, wing='C', sort_order=13 WHERE room_number='326'; -- single at end

-- Right wing (R)
UPDATE public.rooms SET floor_number=3, wing='R', sort_order=1  WHERE room_number='350';
UPDATE public.rooms SET floor_number=3, wing='R', sort_order=2  WHERE room_number='348';
UPDATE public.rooms SET floor_number=3, wing='R', sort_order=3  WHERE room_number='346'; -- Triple Beds (2-bay room)
UPDATE public.rooms SET floor_number=3, wing='R', sort_order=5  WHERE room_number='342';
UPDATE public.rooms SET floor_number=3, wing='R', sort_order=6  WHERE room_number='340';
UPDATE public.rooms SET floor_number=3, wing='R', sort_order=7  WHERE room_number='338';
UPDATE public.rooms SET floor_number=3, wing='R', sort_order=8  WHERE room_number='336';
UPDATE public.rooms SET floor_number=3, wing='R', sort_order=9  WHERE room_number='334';
UPDATE public.rooms SET floor_number=3, wing='R', sort_order=10 WHERE room_number='332';
UPDATE public.rooms SET floor_number=3, wing='R', sort_order=11 WHERE room_number='330';
UPDATE public.rooms SET floor_number=3, wing='R', sort_order=12 WHERE room_number='328';

-- ── Indexes ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_rooms_floor_sort ON public.rooms(floor_number, sort_order);
CREATE INDEX IF NOT EXISTS idx_rooms_floor_wing  ON public.rooms(floor_number, wing);

COMMIT;
