// Auth-corridor test for the SCB auto-inquiry cron (F3).
// Middleware treats /api/cron as public (sessionless), so this handler is the ONLY wall. It must
// authorize solely on the shared secret (bearer or ?token=), constant-time, fail-closed when the
// secret is unset — NOT on the client-controlled `x-vercel-cron` header or a `vercel-cron` User-Agent,
// both of which are trivially spoofable.
//
// Run: npx tsx "src/app/api/cron/scb-auto-inquiry/route.auth-gate.test.ts"
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const SECRET = "s3cr3t-cron-value";

const M = Module as any;
const originalResolveFilename = M._resolveFilename;
M._resolveFilename = function resolveWithSrcAlias(request: string, ...rest: unknown[]) {
  if (request.startsWith("@/")) {
    return originalResolveFilename.call(this, path.join(process.cwd(), "src", request.slice(2)), ...rest);
  }
  return originalResolveFilename.call(this, request, ...rest);
};

// No due rows -> the runner is never invoked; empty selects keep the handler on its happy path.
class QB {
  select() { return this; }
  eq() { return this; }
  lt() { return this; }
  lte() { return this; }
  gte() { return this; }
  in() { return this; }
  order() { return this; }
  limit() { return this; }
  insert() { return this; }
  update() { return this; }
  maybeSingle() { return { data: null, error: null }; }
  then(onf: any, onr: any) { return Promise.resolve({ data: [], error: null }).then(onf, onr); }
}
class DB {
  from() { return new QB(); }
  async rpc() { return { data: null, error: null }; }
}

const stubs = new Map<string, unknown>([
  ["@/lib/supabase/server", { createServerSupabaseClient: () => new DB() }],
  ["@/lib/scb/inquiry-runner", { runScbInquiryForRequest: async () => ({ inquiry: { status: "ok", found: false } }) }],
]);
const originalLoad = M._load;
M._load = function loadWithStubs(request: string, parent: unknown, isMain: boolean) {
  if (stubs.has(request)) return stubs.get(request);
  return originalLoad.call(this, request, parent, isMain);
};

const { GET } = require("./route.ts") as { GET: (req: unknown) => Promise<Response> };

function req({ headers = {}, token }: { headers?: Record<string, string>; token?: string }) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const nextUrl = new URL(
    `http://localhost/api/cron/scb-auto-inquiry${token !== undefined ? `?token=${encodeURIComponent(token)}` : ""}`
  );
  return { headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null }, nextUrl };
}
function withSecret(fn: () => Promise<void>) {
  return async () => {
    process.env.SCB_AUTO_INQUIRY_CRON_SECRET = SECRET;
    delete process.env.CRON_SECRET;
    await fn();
  };
}
function withoutSecret(fn: () => Promise<void>) {
  return async () => {
    delete process.env.SCB_AUTO_INQUIRY_CRON_SECRET;
    delete process.env.CRON_SECRET;
    await fn();
  };
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

  await test("T1: correct bearer secret -> authorized (positive control, not 401)", withSecret(async () => {
    const res = await GET(req({ headers: { authorization: `Bearer ${SECRET}` } }));
    assert.notEqual(res.status, 401);
  }));

  await test("T1b: correct ?token= secret -> authorized (positive control, not 401)", withSecret(async () => {
    const res = await GET(req({ token: SECRET }));
    assert.notEqual(res.status, 401);
  }));

  await test("T2: spoofed x-vercel-cron:1 header, no secret supplied -> 401", withSecret(async () => {
    const res = await GET(req({ headers: { "x-vercel-cron": "1" } }));
    assert.equal(res.status, 401);
  }));

  await test("T3: spoofed vercel-cron User-Agent, no secret supplied -> 401", withSecret(async () => {
    const res = await GET(req({ headers: { "user-agent": "vercel-cron/1.0" } }));
    assert.equal(res.status, 401);
  }));

  await test("T4: secret UNSET + spoofed x-vercel-cron header -> 401 (fail-closed)", withoutSecret(async () => {
    const res = await GET(req({ headers: { "x-vercel-cron": "1" } }));
    assert.equal(res.status, 401);
  }));

  await test("T5: wrong bearer -> 401", withSecret(async () => {
    const res = await GET(req({ headers: { authorization: "Bearer nope" } }));
    assert.equal(res.status, 401);
  }));

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
