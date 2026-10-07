-- Phase 74 — Alert Settings Seed
-- File 5/6. Adds 3 app_settings rows consumed by Phase 74.
-- telegram.admin_chat_id is NOT seeded here (already seeded in Phase 72).

INSERT INTO public.app_settings (key, value_json, description) VALUES
  (
    'alert.start_time',
    '"07:30"'::jsonb,
    'Phase 74: Time of day (Bangkok) when pending alerts begin escalating. Re-triggered per snooze_minutes interval until Finish Alarm Job is clicked.'
  ),
  (
    'alert.snooze_minutes',
    '60'::jsonb,
    'Phase 74: Minutes between re-triggers of the pending-alerts banner on operational pages after a snooze. Default 60.'
  ),
  (
    'alert.prepayment_lead_days',
    '7'::jsonb,
    'Phase 74: Number of days ahead to scan for eligible Thai-customer pre-payment alerts. Default 7.'
  )
ON CONFLICT (key) DO NOTHING;
