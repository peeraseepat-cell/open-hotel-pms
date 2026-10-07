import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL("../../../supabase/migrations/20260701114840_atomic_abbreviated_invoice_renumber.sql", import.meta.url),
  "utf8"
);

assert.match(migration, /CREATE OR REPLACE FUNCTION public\.renumber_abbreviated_invoices/i);
assert.match(migration, /SECURITY INVOKER/i);
assert.match(migration, /pg_advisory_xact_lock/);
assert.match(migration, /regenerated_without_draft/);
assert.match(migration, /__abbr_renumber__/);
assert.match(migration, /jsonb_to_recordset/);
assert.match(migration, /REVOKE ALL ON FUNCTION public\.renumber_abbreviated_invoices[\s\S]*FROM PUBLIC/i);
assert.match(migration, /REVOKE ALL ON FUNCTION public\.renumber_abbreviated_invoices[\s\S]*FROM anon/i);
assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.renumber_abbreviated_invoices[\s\S]*TO authenticated/i);

const temporaryIndex = migration.indexOf("__abbr_renumber__");
const finalAssignmentIndex = migration.indexOf("SET invoice_no = assignment.invoice_no");
assert.ok(temporaryIndex > -1 && finalAssignmentIndex > temporaryIndex, "temporary numbers must be assigned before final numbers");
