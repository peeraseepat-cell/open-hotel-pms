-- Phase 32 hotfix: Add room_diary and calendar to alert template display_surfaces
-- Root cause: seed data gave critical/warning templates surfaces without room_diary/calendar,
-- so filterAlertsForSurface("room_diary") filtered them out → only info (blue) dots showed.

-- 1) Fix alert_templates: add room_diary + calendar to all templates that don't already have them
--    Exception: auto_on_co templates (checkout-specific) keep restricted surfaces
UPDATE public.alert_templates
SET display_surfaces = array(
  SELECT DISTINCT unnest(
    display_surfaces || ARRAY['room_diary','calendar']::text[]
  )
)
WHERE NOT (display_surfaces @> ARRAY['room_diary']::text[])
  AND code NOT IN (
    SELECT code FROM public.alert_codes WHERE auto_on_co = true
  );

-- 2) Also fix reservation_alerts rows that inherited restricted surfaces from templates
--    For rows that have a template with room_diary/calendar, sync surfaces
UPDATE public.reservation_alerts ra
SET display_surfaces = at.display_surfaces
FROM public.alert_templates at
WHERE ra.alert_template_id = at.id
  AND ra.display_surfaces IS NOT NULL
  AND NOT (ra.display_surfaces @> ARRAY['room_diary']::text[])
  AND (at.display_surfaces @> ARRAY['room_diary']::text[]);
