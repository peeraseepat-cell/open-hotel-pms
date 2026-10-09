import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { NextRequest } from "next/server";

// Run the real payment handlers and real requireStaffAuth/default policy.
// Stub the service DB and cookie-session boundaries only; no auth policy stub.
const require = createRequire(import.meta.url);
const M = Module as any;
const originalLoad = M._load;
const originalResolve = M._resolveFilename;
const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://owner-wall.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "owner-wall-test-anon-key";
let role: string | null = "frontdesk";
let authenticated = true;
let tables: string[] = [];
let operations: string[] = [];
let cookieAuthCalls = 0;
const client = {
  auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  from(table: string) {
    tables.push(table);
    const chain: any = {};
    for (const op of ["select", "eq", "order", "limit", "update", "insert", "in"]) {
      chain[op] = () => { operations.push(`${table}.${op}`); return chain; };
    }
    const result = () => ({ data: table === "profiles" ? (role === null ? null : { role }) : null, error: null });
    chain.maybeSingle = async () => result();
    chain.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
    return chain;
  },
  rpc() { operations.push("rpc"); return Promise.resolve({ data: null, error: null }); },
};
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return originalResolve.call(this, request.startsWith("@/") ? path.join(process.cwd(), "src", request.slice(2)) : request, ...rest);
};
M._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "@/lib/supabase/server") return { createServerSupabaseClient: () => client };
  if (request === "@supabase/ssr") return { createServerClient: () => ({ auth: { getUser: async () => {
    cookieAuthCalls++;
    return { data: { user: authenticated ? { id: "cashier" } : null }, error: null };
  } } }) };
  if (request === "next/cache") return { unstable_noStore: () => {} };
  return originalLoad.call(this, request, parent, isMain);
};
const { POST, GET } = require("./route.ts") as {
  POST: (request: NextRequest, context: { params: { id: string } }) => Promise<Response>;
  GET: (request: NextRequest, context: { params: { id: string } }) => Promise<Response>;
};
after(() => {
  M._load = originalLoad; M._resolveFilename = originalResolve;
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
  if (originalAnon === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalAnon;
});
function reset(nextRole: string | null = "frontdesk") { role = nextRole; authenticated = true; tables = []; operations = []; cookieAuthCalls = 0; }
function request(body: Record<string, unknown>, method = "POST") {
  return new NextRequest("http://localhost/api/bookings/booking/payments", {
    method, headers: { cookie: "test-session=yes", "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}
const context = { params: { id: "booking" } };
for (const [name, body] of [
  ["cash payment", { method: "cash", amount: 100 }],
  ["refund", { tx_type: "refund", method: "cash", amount: 100 }],
  ["deposit", { tx_type: "deposit", method: "cash", amount: 100 }],
  ["transfer", { method: "transfer", amount: 100, require_transfer_detail: true }],
] as const) {
  test(`owner ${name} is 403 before any business DB read or write`, async () => {
    reset("owner");
    const response = await POST(request(body), context);
    assert.equal(response.status, 403);
    assert.deepEqual(tables, ["profiles"], "only authentication profile read may precede owner denial");
    assert.equal(cookieAuthCalls, 1);
    assert.ok(operations.every(op => op.startsWith("profiles.")));
  });
}
test("owner is denied before input validation", async () => {
  reset("owner");
  assert.equal((await POST(request({ amount: 0 }), context)).status, 403);
  assert.deepEqual(tables, ["profiles"]);
});
test("unauthenticated POST is 401 without business DB reads", async () => {
  reset(); authenticated = false;
  assert.equal((await POST(request({ amount: 100 }), context)).status, 401);
  assert.deepEqual(tables, []);
});
for (const missing of [null, "", "   "]) {
  test(`missing or blank payment role ${JSON.stringify(missing)} is forbidden before business DB reads`, async () => {
    reset(missing);
    assert.equal((await POST(request({ amount: 100 }), context)).status, 403);
    assert.deepEqual(tables, ["profiles"]);
  });
}
test("frontdesk valid cash reaches reservation 404", async () => {
  reset();
  const response = await POST(request({ method: "cash", amount: 100 }), context);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "Reservation not found.");
  assert.ok(tables.includes("reservations"));
  assert.equal(tables.some(table => table !== "profiles" && table !== "reservations"), false);
});
test("frontdesk still receives amount validation 400", async () => {
  reset();
  const response = await POST(request({ amount: 0 }), context);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "amount must be > 0.");
  assert.equal(tables.includes("reservations"), false);
});
test("owner GET retains read access and reaches reservation 404", async () => {
  reset("owner");
  assert.equal((await GET(request({}, "GET"), context)).status, 404);
  assert.deepEqual(tables, ["profiles", "reservations"]);
});
