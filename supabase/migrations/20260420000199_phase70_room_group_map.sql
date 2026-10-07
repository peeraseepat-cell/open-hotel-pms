-- Phase 70: Abbreviated Tax Invoice — Room Group Map
-- Maps room_type_code → tax_group (A/B/C/D/E) for ใบกำกับภาษีอย่างย่อ
-- Seed per WORK_ASSIGNMENT_PHASE70.md D14:
--   A = DS, TS   (Standard twin/double)
--   B = DQ, DT   (Deluxe queen/twin + DT moved from D per User correction)
--   C = JS       (Junior Suite)
--   D = TB       (Triple)
--   E = FR       (Family)

CREATE TABLE IF NOT EXISTS public.tax_invoice_room_group_map (
  id              serial PRIMARY KEY,
  room_type_code  text NOT NULL UNIQUE,
  tax_group       char(1) NOT NULL CHECK (tax_group IN ('A','B','C','D','E')),
  label_th        text NOT NULL,
  sort_order      smallint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tax_invoice_room_group_map
  IS 'Phase 70: maps PMS room_type_code to abbreviated tax invoice group (A-E) for ใบกำกับภาษีอย่างย่อ';

COMMENT ON COLUMN public.tax_invoice_room_group_map.tax_group
  IS 'A=Standard, B=Deluxe, C=Junior Suite, D=Triple, E=Family';

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE public.tax_invoice_room_group_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY tirgm_select ON public.tax_invoice_room_group_map
  FOR SELECT TO authenticated USING (true);

CREATE POLICY tirgm_modify ON public.tax_invoice_room_group_map
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('admin','supervisor')
  ));

-- ------------------------------------------------------------
-- Seed (User-confirmed mapping, 2026-04-20)
-- ------------------------------------------------------------
INSERT INTO public.tax_invoice_room_group_map (room_type_code, tax_group, label_th, sort_order)
VALUES
  ('DS', 'A', 'ห้องพักแบบ A', 10),
  ('TS', 'A', 'ห้องพักแบบ A', 11),
  ('DQ', 'B', 'ห้องพักแบบ B', 20),
  ('DT', 'B', 'ห้องพักแบบ B', 21),
  ('JS', 'C', 'ห้องพักแบบ C', 30),
  ('TB', 'D', 'ห้องพักแบบ D', 40),
  ('FR', 'E', 'ห้องพักแบบ E', 50)
ON CONFLICT (room_type_code) DO UPDATE
  SET tax_group  = EXCLUDED.tax_group,
      label_th   = EXCLUDED.label_th,
      sort_order = EXCLUDED.sort_order;

-- ------------------------------------------------------------
-- Index
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tirgm_tax_group
  ON public.tax_invoice_room_group_map(tax_group, sort_order);
