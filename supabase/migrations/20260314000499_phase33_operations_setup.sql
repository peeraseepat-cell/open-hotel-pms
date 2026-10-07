CREATE TABLE IF NOT EXISTS public.trace_templates (
  id serial PRIMARY KEY,
  name text NOT NULL,
  dept public.trace_dept NOT NULL DEFAULT 'FD',
  template_text text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.trace_templates ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'trace_templates'
      AND policyname = 'service role full access'
  ) THEN
    CREATE POLICY "service role full access" ON public.trace_templates FOR ALL USING (true);
  END IF;
END
$$;

INSERT INTO public.trace_templates (name, dept, template_text, is_active, sort_order)
VALUES
  ('Extra pillow before arrival', 'HK', 'Please place extra pillow in room before arrival.', true, 10),
  ('Extra bed setup', 'HK', 'Extra bed requested. Please set up before check-in.', true, 20),
  ('Do Not Disturb', 'HK', 'Do Not Disturb — guest requested privacy.', true, 30),
  ('EU adapter collect', 'FD', 'Guest has EU adapter — collect on checkout.', true, 40),
  ('Hair dryer collect', 'FD', 'Guest has hair dryer — collect on checkout.', true, 50),
  ('A/C issue check', 'MAINT', 'Please check A/C in room — guest reported issue.', true, 60),
  ('Anniversary amenity', 'FD', 'Anniversary — arrange cake / flowers.', true, 70),
  ('Transfer confirm', 'FD', 'Guest booked car transfer — confirm pick-up time.', true, 80)
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_trace_templates_active
  ON public.trace_templates (is_active, dept, sort_order, id);
