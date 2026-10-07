import assert from "node:assert/strict";
import fs from "node:fs";

// Contract: this migration closes the maintenance anon back door left by phase9.
// 202603010002:92-125 + 202603010003:28-32 granted `for all to anon, authenticated
// using(true)` on all 6 maintenance tables, and :317-319 + :85 granted EXECUTE on the
// read RPCs to anon — so the publishable key could mutate maintenance data through
// PostgREST, bypassing Next.js entirely.
//
// Source-level contract in house style (no local PG harness in this repo); the
// privilege proof both directions is the PR's ceremony read-back.
const migration = fs.readFileSync(
  new URL("../../../supabase/migrations/20260716000199_secure_maintenance_anon.sql", import.meta.url),
  "utf8"
);

// Negative assertions ("must not touch X") run against the EXECUTABLE sql only.
// Asserting over the raw file would conflate a `-- NOT TOUCHED: x` comment — which
// documents intent and is worth keeping — with a statement that actually touches x.
const sql = migration.replace(/--[^\n]*/g, "");

// ── every one of the 6 permissive policies must be dropped ──
// NOTE: the checklist policy name does NOT match its table name — a DROP written
// from the table name silently misses it and leaves the door open.
const PERMISSIVE_POLICIES = [
  ["maintenance_tasks_allow_all", "maintenance_tasks"],
  ["maintenance_logs_allow_all", "maintenance_logs"],
  ["maintenance_notes_allow_all", "maintenance_notes"],
  ["maintenance_task_times_allow_all", "maintenance_task_times"],
  ["maintenance_assignments_allow_all", "maintenance_assignments"],
  ["maintenance_assignment_checklists_allow_all", "maintenance_assignment_checklist_results"],
];

for (const [policy, table] of PERMISSIVE_POLICIES) {
  assert.match(
    migration,
    new RegExp(`DROP POLICY IF EXISTS ${policy} ON public\\.${table};`, "i"),
    `permissive policy ${policy} on ${table} must be dropped`
  );
}

// ── the door must not be re-opened by a replacement policy ──
// phase9's shape was `for all to anon, authenticated`; 202606060002 (POS/stock)
// narrowed to `TO authenticated`. Maintenance has ZERO browser callers (all 5 RPC
// call sites + every /api/maintenance/* route use the service-role client), so
// neither role gets a policy back. service_role bypasses RLS, so the app keeps working.
assert.doesNotMatch(
  sql,
  /CREATE POLICY[\s\S]*?\bTO\b[^;]*\banon\b/i,
  "no replacement policy may grant anon"
);
assert.doesNotMatch(
  sql,
  /CREATE POLICY[\s\S]*?\bTO\b[^;]*\bauthenticated\b/i,
  "no replacement policy may grant authenticated"
);

// ── table privileges revoked from both public roles, service_role retained ──
for (const [, table] of PERMISSIVE_POLICIES) {
  assert.match(
    migration,
    new RegExp(`REVOKE ALL ON TABLE[\\s\\S]{0,400}?public\\.${table}\\b[\\s\\S]{0,400}?FROM[^;]*\\banon\\b`, "i"),
    `${table} privileges must be revoked from anon`
  );
  assert.match(
    migration,
    new RegExp(`REVOKE ALL ON TABLE[\\s\\S]{0,400}?public\\.${table}\\b[\\s\\S]{0,400}?FROM[^;]*\\bauthenticated\\b`, "i"),
    `${table} privileges must be revoked from authenticated`
  );
}

// ── RLS must stay enabled (revoking grants alone is not the wall) ──
for (const [, table] of PERMISSIVE_POLICIES) {
  assert.match(
    migration,
    new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`, "i"),
    `${table} must have RLS (re-)asserted enabled`
  );
}

// ── the 3 maintenance read RPCs: exact signatures, revoked then service_role-only ──
// Enumerated every overload across all migrations: one live signature each. The
// legacy get_todays_maintenance_assignments(date) overload was already dropped by
// 202603010003:38 before its re-create, so no arity surprise remains.
const RPCS = [
  ["get_room_maintenance_status", ""],
  ["get_maintenance_for_rooms", "uuid\\[\\]"],
  ["get_todays_maintenance_assignments", "date"],
];

for (const [fn, args] of RPCS) {
  assert.match(
    migration,
    new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${fn}\\(${args}\\)[\\s\\S]{0,120}?FROM[^;]*PUBLIC[^;]*\\banon\\b[^;]*\\bauthenticated\\b`, "i"),
    `${fn}(${args || ""}) EXECUTE must be revoked from PUBLIC, anon, authenticated`
  );
  assert.match(
    migration,
    new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(${args}\\)[\\s\\S]{0,120}?TO service_role`, "i"),
    `${fn}(${args || ""}) EXECUTE must be granted to service_role`
  );
}

// ── HK stays untouched: hk_finish_task_with_maintenance is already locked by
// 202606210001 and the maid top-up flow rides it. S1 must not mention it. ──
assert.doesNotMatch(
  sql,
  /hk_finish_task_with_maintenance/i,
  "S1 must not touch the HK finish RPC (locked by 202606210001; maid flow depends on it)"
);
// ...but the file MUST still explain why it is left alone, so the next agent doesn't
// "helpfully" fold it into a future maintenance sweep.
assert.match(
  migration,
  /NOT TOUCHED[\s\S]{0,120}hk_finish_task_with_maintenance/i,
  "the migration must document why the HK finish RPC is deliberately untouched"
);

// ── re-emit immunization: the next agent must be told that a drop/create of these
// functions silently restores the anon grant (202603010003:38 -> :85 did exactly that) ──
assert.match(
  migration,
  /202603010003/,
  "migration must name the re-grant source file so the trap is not re-opened"
);

// ── ceremony must be replayable: STEP0 state probe before mutating ──
assert.match(migration, /to_regclass/i, "STEP0 must probe schema state via to_regclass so the ceremony is replayable");

// ── house idiom: table tightening commits independently of the RPC txn, so a later
// signature drift cannot roll back the policy fix (202606060002's stated rationale) ──
assert.ok(
  (migration.match(/BEGIN;/gi) ?? []).length >= 2 && (migration.match(/COMMIT;/gi) ?? []).length >= 2,
  "table-privilege and RPC-privilege work must be in separate transactions (202606060002 idiom)"
);
