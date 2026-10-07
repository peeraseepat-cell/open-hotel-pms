// Executing contract test for the maintenance page-permission predicate.
// Run: node --test "src/**/*.test.mjs"   (QUOTED glob — never find|xargs)
//
// This file EXECUTES the predicate. The sibling api-auth.contract.test.mjs greps
// api-auth.ts as text, which is why it certified the '*' hole for weeks: a source
// pattern cannot answer "what does this return for a '*'-only profile?".

import assert from "node:assert/strict";
import test from "node:test";

const { hasMaintenancePagePermission, MAINTENANCE_PAGE_ROOTS } = await import("./page-permission.ts");

// Product decision (2026-07-18). THE case this change exists for.
test("RULING: a blanket '*' does NOT grant maintenance read", () => {
  assert.equal(hasMaintenancePagePermission(["*"]), false);
});

// The two rows differ ONLY in allowed_pages — same shape, same length, one field.
// A fixture whose rows differ in more than the field under test cannot attribute
// the result to that field.
test("'*'-only vs explicit-grant differ only in allowed_pages, and only one passes", () => {
  const starOnly = ["*"];
  const explicit = ["/pms/maintenance"];
  assert.equal(starOnly.length, explicit.length, "fixtures must differ in the FIELD, not the shape");
  assert.equal(hasMaintenancePagePermission(starOnly), false);
  assert.equal(hasMaintenancePagePermission(explicit), true);
});

// Both real page paths stay honoured. Honouring only one silently locks out every
// profile provisioned with the other — the trap the original comment warns about.
test("BOTH maintenance roots grant, exactly and by prefix-child", () => {
  assert.equal(hasMaintenancePagePermission(["/pms/maintenance"]), true);
  assert.equal(hasMaintenancePagePermission(["/pms/housekeeping/maintenance"]), true);
  assert.equal(hasMaintenancePagePermission(["/pms/maintenance/tasks"]), true);
  assert.equal(hasMaintenancePagePermission(["/pms/housekeeping/maintenance/jobs"]), true);
  assert.deepEqual(MAINTENANCE_PAGE_ROOTS, ["/pms/maintenance", "/pms/housekeeping/maintenance"]);
});

// A '*' holder who ALSO holds a real grant keeps access — the grant carries it, not
// the wildcard. Guards against a fix that over-rotates into denying starred profiles.
test("'*' alongside an explicit grant still passes — on the GRANT, not the star", () => {
  assert.equal(hasMaintenancePagePermission(["*", "/pms/maintenance"]), true);
  assert.equal(hasMaintenancePagePermission(["*", "/pms/linen"]), false);
});

// Near-misses must not pass: prefix matching is root-anchored, not substring.
test("REJECT: near-miss paths do not grant", () => {
  assert.equal(hasMaintenancePagePermission(["/pms/maintenance-reports"]), false, "sibling path sharing a prefix is NOT a child");
  assert.equal(hasMaintenancePagePermission(["/pms/linen"]), false);
  assert.equal(hasMaintenancePagePermission(["/pms"]), false, "a parent grant must not cascade into maintenance");
  assert.equal(hasMaintenancePagePermission([]), false);
});

// profiles.allowed_pages is free-form jsonb — non-arrays and junk entries fail CLOSED.
test("fails CLOSED on junk input", () => {
  for (const junk of [null, undefined, "*", "/pms/maintenance", 0, {}, { pages: ["*"] }]) {
    assert.equal(hasMaintenancePagePermission(junk), false, `non-array ${JSON.stringify(junk)} must not grant`);
  }
  assert.equal(hasMaintenancePagePermission([null, 0, {}]), false);
});

// Entries are trimmed before comparison, mirroring the role normalisation above it.
test("surrounding whitespace does not defeat a real grant", () => {
  assert.equal(hasMaintenancePagePermission(["  /pms/maintenance  "]), true);
});
