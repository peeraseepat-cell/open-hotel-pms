// Auth-corridor role-gate test for staff PATCH (F1).
// A management mutation (rename/deactivate a staff member; rename cascades hotel-wide via
// syncRenamedAssignments) must be gated to admin/supervisor — the same tier the sibling
// /api/staff/invite route already enforces. Anyone else (maid, mobile, frontdesk) gets 403
// BEFORE any write. The stubbed requireStaffAuth mirrors the real allow/deny semantics, so
// a wrong `allowRoles` in the handler turns T4/T5 red, not just "gate removed" (T1).
//
// Run: npx tsx "src/app/api/staff/[id]/route.auth-gate.test.ts"
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { createRequire } from "node:module";
import { NextResponse } from "next/server";

const require = createRequire(import.meta.url);

const STAFF_ID = "11111111-1111-4111-8111-111111111111";

const M = Module as any;
const originalResolveFilename = M._resolveFilename;
M._resolveFilename = function resolveWithSrcAlias(request: string, ...rest: unknown[]) {
  if (request.startsWith("@/")) {
    return originalResolveFilename.call(this, path.join(process.cwd(), "src", request.slice(2)), ...rest);
  }
  return originalResolveFilename.call(this, request, ...rest);
};

// ── fake auth: faithful mirror of requireStaffAuth (src/lib/server-auth.ts) ──
let currentRole: string | null = "maid";
let authOptionsSeen: any[] = [];
const DEFAULT_DENY = ["owner"];
const requireStaffAuth = async (_sb: unknown, _rq: unknown, options: any = {}) => {
  authOptionsSeen.push(options);
  if (currentRole === null) {
    return { user: null, role: null, error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  const allow: string[] | undefined = options.allowRoles;
  const deny: string[] = options.denyRoles ?? DEFAULT_DENY;
  const passes = allow ? allow.includes(currentRole) : !deny.includes(currentRole);
  if (!passes) {
    return { user: null, role: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { user: { id: `user-${currentRole}`, email: null }, role: currentRole, error: null };
};
const getAuthenticatedUser = async () => (currentRole === null ? null : { id: `user-${currentRole}`, email: null });

// ── DB stub: enough of the staff PATCH happy path to reach the update ──
let currentDb: DB;
class QB {
  table: string;
  op = "select";
  sel = "";
  constructor(table: string) {
    this.table = table;
  }
  select(sel = "") {
    this.sel = sel;
    return this;
  }
  update(payload: any) {
    this.op = "update";
    currentDb.writes.push({ table: this.table, type: "update", payload });
    return this;
  }
  insert(payload: any) {
    this.op = "insert";
    currentDb.writes.push({ table: this.table, type: "insert", payload });
    return this;
  }
  eq() { return this; }
  neq() { return this; }
  ilike() { return this; }
  limit() { return this; }
  order() { return this; }
  is() { return this; }
  in() { return this; }
  maybeSingle() { return this.resolve(); }
  then(onf: any, onr: any) { return Promise.resolve(this.resolve()).then(onf, onr); }
  resolve() {
    if (this.op === "update" && this.table === "staff") {
      return {
        data: {
          id: STAFF_ID, employee_code: "E1", display_name: "Old", nickname: "N",
          department_id: null, is_active: true, hk_lane_enabled: false, hk_lane_order: 100, department: null,
        },
        error: null,
      };
    }
    if (this.op !== "select") return { data: null, error: null };
    if (this.table === "staff") {
      // current-staff read: hk_lane_enabled=false skips the duplicate-name checks
      return { data: { id: STAFF_ID, display_name: "Old", hk_lane_enabled: false, is_active: true }, error: null };
    }
    return { data: null, error: null };
  }
}
class DB {
  writes: Array<{ table: string; type: string; payload: any }> = [];
  from(table: string) { return new QB(table); }
  async rpc() { return { data: null, error: null }; }
}

const stubs = new Map<string, unknown>([
  ["@/lib/supabase/server", { createServerSupabaseClient: () => currentDb }],
  ["@/lib/server-auth", { requireStaffAuth, getAuthenticatedUser }],
  ["@/lib/staff-sync", { syncStaffFromProfiles: async () => {} }],
]);
const originalLoad = M._load;
M._load = function loadWithStubs(request: string, parent: unknown, isMain: boolean) {
  if (stubs.has(request)) return stubs.get(request);
  return originalLoad.call(this, request, parent, isMain);
};

const { PATCH } = require("./route.ts") as {
  PATCH: (req: unknown, ctx: { params: { id: string } }) => Promise<Response>;
};

function req(body: Record<string, unknown>) {
  return { json: async () => body, headers: { get: () => null } };
}
function reset(role: string | null) {
  currentRole = role;
  authOptionsSeen = [];
  currentDb = new DB();
}
function staffWrites() {
  return currentDb.writes.filter((w) => w.table === "staff");
}

const results: Array<{ name: string; ok: boolean; err?: unknown }> = [];
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err }); }
}

async function main() {
  const quiet = () => undefined;
  const oe = console.error; const ow = console.warn;
  console.error = quiet; console.warn = quiet;

  await test("T1: maid -> 403 and NO staff write", async () => {
    reset("maid");
    const res = await PATCH(req({ nickname: "N" }), { params: { id: STAFF_ID } });
    assert.equal(res.status, 403);
    assert.equal(staffWrites().length, 0, "a maid must not mutate staff");
  });

  await test("T2: admin -> passes gate and reaches the staff update (positive control)", async () => {
    reset("admin");
    const res = await PATCH(req({ nickname: "N" }), { params: { id: STAFF_ID } });
    assert.notEqual(res.status, 403);
    assert.ok(staffWrites().some((w) => w.type === "update"), "admin must reach the update");
  });

  await test("T3: supervisor -> passes gate (positive control)", async () => {
    reset("supervisor");
    const res = await PATCH(req({ nickname: "N" }), { params: { id: STAFF_ID } });
    assert.notEqual(res.status, 403);
    assert.ok(staffWrites().some((w) => w.type === "update"), "supervisor must reach the update");
  });

  await test("T4: frontdesk -> 403 (tier is exactly admin/supervisor, not any-authenticated)", async () => {
    reset("frontdesk");
    const res = await PATCH(req({ nickname: "N" }), { params: { id: STAFF_ID } });
    assert.equal(res.status, 403);
    assert.equal(staffWrites().length, 0, "frontdesk must not mutate staff");
  });

  await test("T5: gate is wired with allowRoles = admin+supervisor", async () => {
    reset("admin");
    await PATCH(req({ nickname: "N" }), { params: { id: STAFF_ID } });
    const allow = authOptionsSeen[0]?.allowRoles;
    assert.deepEqual(Array.isArray(allow) ? allow.slice().sort() : allow, ["admin", "supervisor"]);
  });

  console.error = oe; console.warn = ow;

  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log(`  ✓ ${r.name}`);
    else { failed++; console.log(`  ✗ ${r.name}`); console.log(String(r.err instanceof Error ? r.err.message : r.err)); }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
