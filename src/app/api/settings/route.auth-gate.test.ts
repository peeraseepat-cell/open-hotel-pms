// Auth-corridor role-gate test for settings PUT (F2).
// hotel_settings PUT changes hotel-wide config (fees, check-in/out times, and the under-18/over-18
// identity-verification alerts). It must be gated to admin/supervisor BEFORE the upsert — the bug is
// that the write currently happens with no auth check at all. GET stays public/read.
//
// Run: npx tsx "src/app/api/settings/route.auth-gate.test.ts"
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
  constructor(table: string) { this.table = table; }
  select() { return this; }
  upsert(payload: any) {
    this.op = "upsert";
    currentDb.writes.push({ table: this.table, type: "upsert", payload });
    return this;
  }
  eq() { return this; }
  maybeSingle() { return this.resolve(); }
  then(onf: any, onr: any) { return Promise.resolve(this.resolve()).then(onf, onr); }
  resolve() {
    if (this.op === "upsert" && this.table === "hotel_settings") {
      return { data: { id: 1, check_in_time: "15:00" }, error: null };
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
  ["@/lib/alerts/service", {
    readAlertSettings: async () => ({}),
    updateAlertSettings: async () => {},
    applyAlertSettingsToHotelSettings: (s: any) => s,
  }],
]);
const originalLoad = M._load;
M._load = function loadWithStubs(request: string, parent: unknown, isMain: boolean) {
  if (stubs.has(request)) return stubs.get(request);
  return originalLoad.call(this, request, parent, isMain);
};

const { PUT } = require("./route.ts") as { PUT: (req: unknown) => Promise<Response> };

function req(body: Record<string, unknown>) {
  return { json: async () => body, headers: { get: () => null } };
}
function reset(role: string | null) {
  currentRole = role;
  authOptionsSeen = [];
  currentDb = new DB();
}
function settingsUpserts() {
  return currentDb.writes.filter((w) => w.table === "hotel_settings" && w.type === "upsert");
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

  await test("T1: maid -> 403 and NO hotel_settings write (write must be gated BEFORE upsert)", async () => {
    reset("maid");
    const res = await PUT(req({ check_in_time: "15:00" }));
    assert.equal(res.status, 403);
    assert.equal(settingsUpserts().length, 0, "a maid must not write hotel_settings");
  });

  await test("T2: admin -> passes gate and writes settings (positive control)", async () => {
    reset("admin");
    const res = await PUT(req({ check_in_time: "15:00" }));
    assert.notEqual(res.status, 403);
    assert.equal(settingsUpserts().length, 1, "admin must reach the upsert");
  });

  await test("T3: supervisor -> passes gate (positive control)", async () => {
    reset("supervisor");
    const res = await PUT(req({ check_in_time: "15:00" }));
    assert.notEqual(res.status, 403);
    assert.equal(settingsUpserts().length, 1, "supervisor must reach the upsert");
  });

  await test("T4: frontdesk -> 403 (tier is exactly admin/supervisor)", async () => {
    reset("frontdesk");
    const res = await PUT(req({ check_in_time: "15:00" }));
    assert.equal(res.status, 403);
    assert.equal(settingsUpserts().length, 0, "frontdesk must not write hotel_settings");
  });

  await test("T5: gate is wired with allowRoles = admin+supervisor", async () => {
    reset("admin");
    await PUT(req({ check_in_time: "15:00" }));
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
