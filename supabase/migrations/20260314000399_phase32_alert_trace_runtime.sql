CREATE TABLE IF NOT EXISTS public.alert_templates (
  id serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  description text,
  category text NOT NULL,
  display_surfaces text[] NOT NULL DEFAULT ARRAY['reservation']::text[],
  severity text NOT NULL DEFAULT 'info',
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  icon text
);

ALTER TABLE public.alert_templates ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'alert_templates'
      AND policyname = 'service role full access'
  ) THEN
    CREATE POLICY "service role full access" ON public.alert_templates FOR ALL USING (true);
  END IF;
END $$;

ALTER TABLE public.reservation_alerts
  ADD COLUMN IF NOT EXISTS alert_template_id int REFERENCES public.alert_templates(id),
  ADD COLUMN IF NOT EXISTS custom_message text,
  ADD COLUMN IF NOT EXISTS display_surfaces text[],
  ADD COLUMN IF NOT EXISTS severity text DEFAULT 'info',
  ADD COLUMN IF NOT EXISTS is_dismissed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by text;

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS expected_arrival_time time;

ALTER TABLE public.loan_items
  ADD COLUMN IF NOT EXISTS requires_extra_charge_reminder boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS linked_fee_template_code text;

INSERT INTO public.alert_templates (code, name, description, category, display_surfaces, severity, is_system, sort_order, icon)
SELECT
  ac.code,
  CASE ac.code
    WHEN 'ADA' THEN 'Adaptor / Device Return'
    WHEN 'HAIR' THEN 'Hair Dryer Return'
    WHEN 'IRON' THEN 'Iron Return'
    WHEN 'BED' THEN 'Extra Bed Request'
    WHEN 'PIL' THEN 'Extra Pillow Request'
    WHEN 'DND' THEN 'Do Not Disturb'
    WHEN 'DEP' THEN 'Take Deposit'
    WHEN 'GRT' THEN 'Manager Greeting'
    WHEN 'ANN' THEN 'Anniversary'
    WHEN 'BIR' THEN 'Birthday'
    WHEN 'PCP' THEN 'Previous Complaint'
    WHEN 'BOAT' THEN 'Boat Transfer'
    WHEN 'CAR' THEN 'Car Transfer'
    WHEN 'VIP' THEN 'VIP Guest'
    WHEN 'OTH' THEN 'Other Alert'
    ELSE ac.description
  END,
  ac.description,
  CASE
    WHEN ac.dept = 'HK' THEN 'housekeeping'
    WHEN ac.code IN ('BOAT', 'CAR') THEN 'arrival'
    ELSE 'policy'
  END,
  CASE
    WHEN ac.code IN ('BOAT', 'CAR') THEN ARRAY['arrivals','room_diary','calendar','reservation','room_drawer']::text[]
    WHEN ac.dept = 'HK' THEN ARRAY['reservation','room_drawer','inhouse','room_diary','calendar','hk_dashboard']::text[]
    WHEN ac.auto_on_co = true THEN ARRAY['reservation','room_drawer','inhouse']::text[]
    ELSE ARRAY['arrivals','reservation','room_drawer','inhouse']::text[]
  END,
  CASE
    WHEN ac.code IN ('PCP', 'VIP') THEN 'critical'
    WHEN ac.code IN ('BOAT', 'CAR', 'DEP', 'ANN', 'BIR') THEN 'warning'
    ELSE 'info'
  END,
  true,
  0,
  ac.icon
FROM public.alert_codes ac
ON CONFLICT (code) DO UPDATE
SET
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  display_surfaces = EXCLUDED.display_surfaces,
  severity = EXCLUDED.severity,
  icon = EXCLUDED.icon;

INSERT INTO public.alert_templates (code, name, description, category, display_surfaces, severity, is_system, sort_order, icon)
VALUES
  ('very_late_arrival', 'Very Late Arrival', 'Guest expects arrival after 22:00', 'arrival', ARRAY['arrivals','room_diary','calendar','reservation','room_drawer']::text[], 'warning', false, 10, '🌙'),
  ('clean_every_2_days', 'Clean Every 2 Days', 'Housekeeping frequency reminder', 'housekeeping', ARRAY['inhouse','room_diary','calendar','reservation','room_drawer','hk_dashboard']::text[], 'info', false, 20, '🧹')
ON CONFLICT (code) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  display_surfaces = EXCLUDED.display_surfaces,
  severity = EXCLUDED.severity,
  icon = EXCLUDED.icon;

UPDATE public.reservation_alerts ra
SET
  alert_template_id = at.id,
  severity = COALESCE(ra.severity, at.severity),
  display_surfaces = COALESCE(ra.display_surfaces, at.display_surfaces)
FROM public.alert_templates at
WHERE ra.alert_template_id IS NULL
  AND ra.alert_code = at.code;

CREATE INDEX IF NOT EXISTS idx_reservation_alerts_template_id
  ON public.reservation_alerts (alert_template_id);

CREATE INDEX IF NOT EXISTS idx_reservation_alerts_dismissed
  ON public.reservation_alerts (reservation_id, is_dismissed, created_at);

CREATE INDEX IF NOT EXISTS idx_alert_templates_active
  ON public.alert_templates (is_active, sort_order, code);
