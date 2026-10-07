import assert from "node:assert/strict";
import fs from "node:fs";

// Contract: the maintenance handler wall.
//
// Before S2, /api/maintenance/* had ZERO auth checks (grep for getAuthenticatedUser
// /role/allowed_pages returned nothing). middleware.ts:134-170 requires a session on
// mutating /api and 403s ONLY role==='owner'; the GET branch (:172-193) checks session
// and no role at all. The maid/mobile role walls at :196 are PAGE-scoped (/pms, /maid,
// /linen-mobile) and never cover /api/maintenance/*. So this helper is the ONLY wall
// between an authenticated maid/mobile session and a hard task delete — not
// defense-in-depth.
//
// Source-level contract in house style (no runtime harness for route handlers here);
// the live role probe is the PR's QA script.
const source = fs.readFileSync(new URL("./api-auth.ts", import.meta.url), "utf8");

// The page-permission predicate moved to ./page-permission.ts so it could be
// EXECUTED — see page-permission.contract.test.mjs, which calls it with real profile
// rows. The assertions below that follow it are repointed at that file; they remain
// source-level here only to pin the SHAPE. Behaviour is pinned by the executing suite.
const pagePermRaw = fs.readFileSync(new URL("./page-permission.ts", import.meta.url), "utf8");

// Comments are STRIPPED before any source assertion. A raw-text scan reads commented-out
// code as live code — the exact way a commented-out REVOKE once stayed green in an earlier
// migration test. It bites in both directions: a `match` passes on a disabled line, and a
// `doesNotMatch` FAILS on a comment that merely mentions the forbidden token. That second
// form fired here for real: page-permission.ts documents `page === "*"` in a scope note
// explaining why it is gone, and the assertion below matched the explanation.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const pagePermSource = stripComments(pagePermRaw);

// ── the three action tiers, exactly as pinned (later work builds on this) ──
assert.match(
  source,
  /export type MaintenanceAction = "read" \| "write" \| "delete";/,
  "MaintenanceAction must stay the pinned 3-tier union"
);

// READ = admin/supervisor/frontdesk (or allowed_pages, below)
assert.match(
  source,
  /READ_ROLES[\s\S]{0,80}?"admin"[\s\S]{0,40}?"supervisor"[\s\S]{0,40}?"frontdesk"/,
  "read tier must admit admin, supervisor, frontdesk"
);
// WRITE = admin/supervisor ONLY — frontdesk must not write.
assert.match(
  source,
  /WRITE_ROLES[\s\S]{0,60}?"admin"[\s\S]{0,40}?"supervisor"/,
  "write tier must admit admin + supervisor"
);
assert.doesNotMatch(
  source,
  /WRITE_ROLES[^;]*frontdesk/,
  "frontdesk must NOT be able to write"
);

// ── DELETE is admin-STRICT ──
// linen's LinenActor.isAdmin = (admin || supervisor) — a lying name. Reusing that
// semantic here would silently let supervisors hard-delete. isAdmin must be strict.
assert.match(
  source,
  /isAdmin\s*=\s*role === "admin";/,
  "isAdmin must be STRICT admin (never admin||supervisor, unlike linen's misnamed flag)"
);
// The exact failure mode being pinned: linen writes
//   isAdmin: role === "admin" || role === "supervisor"
// Any `||` in the isAdmin assignment widens delete beyond admin.
assert.doesNotMatch(
  source,
  /isAdmin\s*=\s*role === "admin"\s*\|\|/,
  "isAdmin must not inherit linen's admin||supervisor conflation"
);
assert.match(
  source,
  /case "delete":[\s\S]{0,120}?isAdmin/,
  "the delete tier must gate on isAdmin"
);

// ── allowed_pages grants READ only, never write/delete (fail-closed) ──
assert.match(
  source,
  /canRead\s*=[\s\S]{0,120}?hasMaintenancePagePermission/,
  "allowed_pages must feed the read tier"
);
assert.doesNotMatch(
  source,
  /canWrite\s*=[\s\S]{0,120}?hasMaintenancePagePermission/,
  "allowed_pages must NOT grant write — spec says WRITE = admin/supervisor by role"
);

// ── both maintenance page strings are accepted (the review decision on the
// page-gate != API-gate wound: linen needs /linen-mobile for the page but
// /pms/linen for the API; granting only one string silently locks staff out) ──
assert.match(pagePermSource, /"\/pms\/maintenance"/, "must accept the /pms/maintenance page grant");
assert.match(
  pagePermSource,
  /"\/pms\/housekeeping\/maintenance"/,
  "must accept the /pms/housekeeping/maintenance page grant (the second real page path)"
);

// ⚠⚠ THIS ASSERTION WAS INVERTED — product decision, 2026-07-18.
//
// It previously read:
//     assert.match(source, /page === "\*"/, "wildcard allowed_pages must grant read");
//
// That is not a test that MISSED the hole. It is a test that CERTIFIED it — a positive
// assertion, with an approving message, requiring the wildcard pierce to be present.
// Anyone deleting the pierce would have been told by the suite that they broke the
// contract. A guard test that cannot fail is bad; a guard test that fails when you FIX
// the vulnerability is worse, because it actively defends the hole.
//
// Deliberately kept as a doesNotMatch here so the regression is caught at the source
// level too — but the real pin is behavioural, in page-permission.contract.test.mjs
// ("RULING: a blanket '*' does NOT grant maintenance read").
assert.doesNotMatch(
  pagePermSource,
  /page === "\*"/,
  "a blanket '*' must NOT satisfy the maintenance page permission"
);

// Both roots must be matched exactly AND by prefix-child, so /pms/maintenance/tasks
// grants too. Asserted against the roots-array form rather than duplicated literals.
assert.match(
  pagePermSource,
  /MAINTENANCE_PAGE_ROOTS\s*=\s*\[/,
  "page roots must be declared as one list (both real page paths live there)"
);
assert.match(
  pagePermSource,
  /MAINTENANCE_PAGE_ROOTS\.some\(\(root\) => page === root \|\| page\.startsWith\(`\$\{root\}\/`\)\)/,
  "each root must grant on exact match AND on prefix-children"
);

// ── unauthenticated = 401, insufficient role = 403, as thrown .status ──
assert.match(source, /status\s*=\s*401/, "missing session must throw .status 401");
assert.match(source, /status\s*=\s*403/, "insufficient role must throw .status 403");

// ── the actor shape later work stamps from (pinned; do not drift) ──
// performed_by is a TEXT column, so `name` is the identity he writes there;
// audit_logs.actor_user_id is a uuid FK, so `userId` is what goes there.
for (const field of ["userId", "role", "name", "isAdmin", "canWrite"]) {
  assert.match(
    source,
    new RegExp(`\\b${field}\\b`),
    `MaintenanceActor.${field} is pinned in the contract`
  );
}
assert.match(
  source,
  /full_name/,
  "actor.name must resolve from profiles.full_name (the value stamped into performed_by)"
);

// ── service-role client is returned so handlers don't mint their own ──
assert.match(source, /createServerSupabaseClient/, "helper must return the service-role client");

// ── error shape mirrors linenApiError so handlers can catch uniformly ──
assert.match(
  source,
  /export function maintenanceApiError/,
  "maintenanceApiError must exist (mirrors linenApiError)"
);

// ── role must be compared case/whitespace-normalised (profiles.role is free text) ──
assert.match(
  source,
  /\.trim\(\)\.toLowerCase\(\)/,
  "role must be normalised before comparison, else ' Admin' silently fails closed"
);
