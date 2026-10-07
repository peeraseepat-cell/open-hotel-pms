-- =============================================================
-- Migration: Rate Plans / Special Rates
-- Date:      2026-02-26
-- Purpose:
--   1) Add configurable rate plan table
--   2) Link reservations to selected rate plan
--   3) Seed default plans (RACK, DIRECT, LONGSTAY, VIP, PROMO)
--
-- Note:
--   room_types.id is BIGINT in current schema, so apply_to_room_types
--   uses BIGINT[] instead of UUID[].
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.rate_plans (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text NOT NULL UNIQUE,
  name_en              text NOT NULL,
  name_th              text,
  description          text,
  discount_type        text NOT NULL DEFAULT 'percent'
    CHECK (discount_type IN ('percent', 'fixed', 'override')),
  discount_value       numeric(10,2) NOT NULL DEFAULT 0,
  min_nights           int NOT NULL DEFAULT 1,
  max_nights           int,
  valid_from           date,
  valid_until          date,
  is_active            boolean NOT NULL DEFAULT true,
  apply_to_room_types  bigint[],
  sort_order           int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at           timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT chk_rate_plans_min_nights CHECK (min_nights >= 1),
  CONSTRAINT chk_rate_plans_max_nights CHECK (max_nights IS NULL OR max_nights >= min_nights),
  CONSTRAINT chk_rate_plans_valid_range CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  CONSTRAINT chk_rate_plans_discount_value_non_negative CHECK (discount_value >= 0)
);

CREATE INDEX IF NOT EXISTS idx_rate_plans_active
  ON public.rate_plans (is_active, sort_order, code);

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS rate_plan_id uuid REFERENCES public.rate_plans(id);

CREATE INDEX IF NOT EXISTS idx_reservations_rate_plan
  ON public.reservations (rate_plan_id)
  WHERE rate_plan_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_rate_plans_updated_at ON public.rate_plans;
CREATE TRIGGER trg_rate_plans_updated_at
BEFORE UPDATE ON public.rate_plans
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.rate_plans (
  code, name_en, name_th, discount_type, discount_value, min_nights, sort_order
)
VALUES
  ('RACK',     'Rack Rate',   'ราคาปกติ',      'percent', 0,  1, 0),
  ('DIRECT',   'Direct Rate', 'ราคาจองตรง',    'percent', 10, 1, 1),
  ('LONGSTAY', 'Long Stay',   'ราคาพักยาว',    'percent', 20, 7, 2),
  ('VIP',      'VIP Rate',    'ราคา VIP',      'percent', 25, 1, 3),
  ('PROMO',    'Promotion',   'ราคาโปรโมชั่น', 'percent', 15, 1, 4)
ON CONFLICT (code) DO NOTHING;

COMMIT;
