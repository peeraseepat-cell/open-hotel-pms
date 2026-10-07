// Auth-corridor role-gate test for staff POST (F1).
// Creating a manual staff/lane member is a management mutation — gate to admin/supervisor
// (same tier as /api/staff/invite). GET is intentionally NOT gated here (staff list is read
// everywhere); only the POST mutation is in scope.
//
// Run: npx tsx "src/app/api/staff/route.auth-gate.test.ts"
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { createRequire } from "node:module";
import { NextResponse } from "next/server";

const require = createRequire(import.meta.url);

const M = Module as any;
const originalResolveFilename = M._resolveFilename;
M._resolveFilename = function resolveWithSrcAlias(request: string, ...rest: unknown[]) {
  if (request.startsWith("@/")) {
    return originalResolveFilename.call(this, path.join(process.cwd(), "src", request.slice(2)), ...rest);
  }
  return originalResolveFilename.call(this, request, ...rest);
};

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

let currentDb: DB;
class QB {
  table: string;
  op = "select";
  sel = "";
  constructor(table: string) { this.table = table; }
  select(sel = "") { this.sel = sel; return this; }
  insert(payload: any) {
    this.op = "insert";
    currentDb.writes.push({ table: this.table, type: "insert", payload });
    return this;
  }
  eq() { return this; }
  ilike() { return this; }
  limit() { return this; }
  order() { return this; }
  maybeSingle() { return this.resolve(); }
  then(onf: any, onr: any) { return Promise.resolve(this.resolve()).then(onf, onr); }
  resolve() {
    if (this.op === "insert" && this.table === "hk_staff_lanes") {
      return {
        data: {
          id: "lane-1", display_name: "New", nickname: null, department_code: "HK",
          is_active: true, hk_lane_enabled: true, hk_lane_order: 100,
        },
        error: null,
      };
    }
    if (this.op !== "select") return { data: null, error: null };
    if (this.table === "departments") return { data: [], error: null };
    // duplicate-name lookups (staff / hk_staff_lanes) -> none found
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

const { POST } = require("./route.ts") as { POST: (req: unknown) => Promise<Response> };

function req(body: Record<string, unknown>) {
  return { json: async () => body, headers: { get: () => null } };
}
function reset(role: string | null) {
  currentRole = role;
  authOptionsSeen = [];
  currentDb = new DB();
}
function laneInserts() {
  return currentDb.writes.filter((w) => w.table === "hk_staff_lanes" && w.type === "insert");
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

  await test("T1: maid -> 403 and NO staff created", async () => {
    reset("maid");
    const res = await POST(req({ display_name: "New" }));
    assert.equal(res.status, 403);
    assert.equal(laneInserts().length, 0, "a maid must not create staff");
  });

  await test("T2: admin -> passes gate and creates staff (positive control)", async () => {
    reset("admin");
    const res = await POST(req({ display_name: "New" }));
    assert.notEqual(res.status, 403);
    assert.equal(laneInserts().length, 1, "admin must reach the insert");
  });

  await test("T3: supervisor -> passes gate (positive control)", async () => {
    reset("supervisor");
    const res = await POST(req({ display_name: "New" }));
    assert.notEqual(res.status, 403);
    assert.equal(laneInserts().length, 1, "supervisor must reach the insert");
  });

  await test("T4: frontdesk -> 403 (tier is exactly admin/supervisor)", async () => {
    reset("frontdesk");
    const res = await POST(req({ display_name: "New" }));
    assert.equal(res.status, 403);
    assert.equal(laneInserts().length, 0, "frontdesk must not create staff");
  });

  await test("T5: gate is wired with allowRoles = admin+supervisor", async () => {
    reset("admin");
    await POST(req({ display_name: "New" }));
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
