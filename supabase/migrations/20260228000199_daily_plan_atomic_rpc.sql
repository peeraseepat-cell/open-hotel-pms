-- Ensure daily plan save is atomic (single transaction)

CREATE OR REPLACE FUNCTION public.hk_save_daily_plan(
  p_date date,
  p_assignments jsonb DEFAULT '[]'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'p_date is required';
  END IF;

  IF p_assignments IS NULL THEN
    p_assignments := '[]'::jsonb;
  END IF;

  IF jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'p_assignments must be a JSON array';
  END IF;

  CREATE TEMP TABLE tmp_daily_plan_assignments (
    room_id uuid PRIMARY KEY,
    assigned_maid text NOT NULL,
    priority integer NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO tmp_daily_plan_assignments (room_id, assigned_maid, priority)
  SELECT
    (item ->> 'room_id')::uuid AS room_id,
    trim(item ->> 'assigned_maid') AS assigned_maid,
    (item ->> 'priority')::integer AS priority
  FROM jsonb_array_elements(p_assignments) AS item;

  IF EXISTS (
    SELECT 1
    FROM tmp_daily_plan_assignments
    WHERE assigned_maid = ''
  ) THEN
    RAISE EXCEPTION 'assigned_maid is required for all assignments';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM tmp_daily_plan_assignments
    WHERE priority < 1 OR priority > 15
  ) THEN
    RAISE EXCEPTION 'priority must be between 1 and 15';
  END IF;

  DELETE FROM public.daily_plans dp
  WHERE dp.plan_date = p_date
    AND NOT EXISTS (
      SELECT 1
      FROM tmp_daily_plan_assignments t
      WHERE t.room_id = dp.room_id
    );

  INSERT INTO public.daily_plans (plan_date, room_id, assigned_maid, priority)
  SELECT p_date, room_id, assigned_maid, priority
  FROM tmp_daily_plan_assignments
  ON CONFLICT (plan_date, room_id) DO UPDATE
  SET
    assigned_maid = EXCLUDED.assigned_maid,
    priority = EXCLUDED.priority;

  SELECT count(*) INTO v_count FROM tmp_daily_plan_assignments;
  RETURN v_count;
END;
$$;
