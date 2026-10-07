BEGIN;

CREATE OR REPLACE FUNCTION public.renumber_abbreviated_invoices(
  p_audit_period_id uuid,
  p_source_type public.abbreviated_source_type,
  p_assignments jsonb DEFAULT '[]'::jsonb,
  p_stale_ids uuid[] DEFAULT '{}'::uuid[]
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_expected_assignment_count int;
  v_expected_stale_count int;
  v_changed_count int;
BEGIN
  IF p_audit_period_id IS NULL OR p_source_type IS NULL THEN
    RAISE EXCEPTION 'audit period and source type are required';
  END IF;
  IF jsonb_typeof(COALESCE(p_assignments, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'assignments must be a JSON array';
  END IF;

  v_expected_assignment_count := jsonb_array_length(COALESCE(p_assignments, '[]'::jsonb));
  v_expected_stale_count := cardinality(COALESCE(p_stale_ids, '{}'::uuid[]));

  PERFORM pg_advisory_xact_lock(
    hashtext('abbreviated-invoice-renumber:' || p_audit_period_id::text || ':' || p_source_type::text)
  );

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(COALESCE(p_assignments, '[]'::jsonb)) AS assignment(id uuid, invoice_no text)
    GROUP BY assignment.id
    HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(COALESCE(p_assignments, '[]'::jsonb)) AS assignment(id uuid, invoice_no text)
    GROUP BY assignment.invoice_no
    HAVING count(*) > 1 OR assignment.invoice_no IS NULL OR btrim(assignment.invoice_no) = ''
  ) THEN
    RAISE EXCEPTION 'assignments contain duplicate or invalid invoice numbers';
  END IF;

  IF v_expected_stale_count <> (
    SELECT count(DISTINCT stale_id)
    FROM unnest(COALESCE(p_stale_ids, '{}'::uuid[])) AS stale_id
  ) THEN
    RAISE EXCEPTION 'stale invoice ids must be unique';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(COALESCE(p_assignments, '[]'::jsonb)) AS assignment(id uuid, invoice_no text)
    WHERE assignment.id = ANY(COALESCE(p_stale_ids, '{}'::uuid[]))
  ) THEN
    RAISE EXCEPTION 'an invoice cannot be both assigned and stale';
  END IF;

  IF v_expected_assignment_count <> (
    SELECT count(*)
    FROM public.abbreviated_tax_invoice invoice
    JOIN jsonb_to_recordset(COALESCE(p_assignments, '[]'::jsonb)) AS assignment(id uuid, invoice_no text)
      ON assignment.id = invoice.id
    WHERE invoice.audit_period_id = p_audit_period_id
      AND invoice.source_type = p_source_type
      AND invoice.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'one or more assigned invoices are outside the active audit period/source set';
  END IF;

  IF v_expected_stale_count <> (
    SELECT count(*)
    FROM public.abbreviated_tax_invoice invoice
    WHERE invoice.id = ANY(COALESCE(p_stale_ids, '{}'::uuid[]))
      AND invoice.audit_period_id = p_audit_period_id
      AND invoice.source_type = p_source_type
      AND invoice.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'one or more stale invoices are outside the active audit period/source set';
  END IF;

  UPDATE public.abbreviated_tax_invoice invoice
  SET status = 'cancelled',
      cancelled_reason = 'regenerated_without_draft',
      cancelled_at = now()
  WHERE invoice.id = ANY(COALESCE(p_stale_ids, '{}'::uuid[]))
    AND invoice.audit_period_id = p_audit_period_id
    AND invoice.source_type = p_source_type
    AND invoice.status <> 'cancelled';

  GET DIAGNOSTICS v_changed_count = ROW_COUNT;
  IF v_changed_count <> v_expected_stale_count THEN
    RAISE EXCEPTION 'stale invoice set changed during renumbering';
  END IF;

  UPDATE public.abbreviated_tax_invoice invoice
  SET invoice_no = '__abbr_renumber__' || replace(invoice.id::text, '-', '')
  FROM jsonb_to_recordset(COALESCE(p_assignments, '[]'::jsonb)) AS assignment(id uuid, invoice_no text)
  WHERE invoice.id = assignment.id
    AND invoice.audit_period_id = p_audit_period_id
    AND invoice.source_type = p_source_type
    AND invoice.status <> 'cancelled';

  GET DIAGNOSTICS v_changed_count = ROW_COUNT;
  IF v_changed_count <> v_expected_assignment_count THEN
    RAISE EXCEPTION 'active invoice set changed while reserving invoice numbers';
  END IF;

  UPDATE public.abbreviated_tax_invoice invoice
  SET invoice_no = assignment.invoice_no
  FROM jsonb_to_recordset(COALESCE(p_assignments, '[]'::jsonb)) AS assignment(id uuid, invoice_no text)
  WHERE invoice.id = assignment.id
    AND invoice.audit_period_id = p_audit_period_id
    AND invoice.source_type = p_source_type
    AND invoice.status <> 'cancelled';

  GET DIAGNOSTICS v_changed_count = ROW_COUNT;
  IF v_changed_count <> v_expected_assignment_count THEN
    RAISE EXCEPTION 'active invoice set changed while assigning final invoice numbers';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.renumber_abbreviated_invoices(uuid, public.abbreviated_source_type, jsonb, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.renumber_abbreviated_invoices(uuid, public.abbreviated_source_type, jsonb, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.renumber_abbreviated_invoices(uuid, public.abbreviated_source_type, jsonb, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.renumber_abbreviated_invoices(uuid, public.abbreviated_source_type, jsonb, uuid[])
  IS 'Atomically cancels stale abbreviated invoices and renumbers active invoices without transient unique-key conflicts.';

COMMIT;
