// The LINE bot must stay silent in a group or room chat.
//
// A group receives pushes only. Without a `source.type` check an invited bot answers every
// message there, and the per-event catch replies `[DEBUG exception]`, which would leak
// internal errors into the group. The guard is the first statement inside the per-event
// `try`, so the exception reply is unreachable for a non-user source.
//
// Harness mirrors src/app/api/settings/route.auth-gate.test.ts (alias + Module._load
// stubs). The fetch stub counts REPLY calls; that count is the whole verdict.
//
// Run: npx tsx "src/app/api/webhooks/line/route.group-guard.test.ts"
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const M = Module as any;
const originalResolveFilename = M._resolveFilename;
M._resolveFilename = function resolveWithSrcAlias(request: string, ...rest: unknown[]) {
  if (request.startsWith("@/")) {
    return originalResolveFilename.call(this, path.join(process.cwd(), "src", request.slice(2)), ...rest);
  }
  return originalResolveFilename.call(this, request, ...rest);
};

// The bot must never reach the DB from a group message. A stub that THROWS on use is
// the honest shape: if the guard leaks, this turns into a visible failure rather than a
// quiet extra round-trip.
const dbTrap = {
  from() {
    throw new Error("DB reached from a webhook event — the group guard did not hold");
  },
};

const stubs = new Map<string, unknown>([
  ["@/lib/supabase/server", { createServerSupabaseClient: () => dbTrap }],
  [
    "@/lib/line-staff-access",
    { classifyLineStaffAccess: () => ({ isBound: false, isFrontdeskOnly: false, departmentCode: null, role: null }) },
  ],
  [
    "@/lib/staff-schedule",
    { formatLineStaffScheduleReply: () => "schedule", getLineStaffSchedule: async () => ({}) },
  ],
]);
const originalLoad = M._load;
M._load = function loadWithStubs(request: string, parent: unknown, isMain: boolean) {
  if (stubs.has(request)) return stubs.get(request);
  return originalLoad.call(this, request, parent, isMain);
};

process.env.LINE_CHANNEL_SECRET = "test-secret";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";

const { POST } = require("./route.ts") as { POST: (req: unknown) => Promise<Response> };

let replyCalls: Array<{ url: string; body: any }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  const parsedBody = init?.body ? JSON.parse(String(init.body)) : null;
  replyCalls.push({ url: String(url), body: parsedBody });
  return { ok: true, status: 200, text: async () => "{}" } as any;
}) as any;

let infoLines: string[] = [];
const originalInfo = console.info;

function req(body: unknown) {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", "test-secret").update(raw).digest("base64");
  return {
    text: async () => raw,
    headers: { get: (name: string) => (name.toLowerCase() === "x-line-signature" ? signature : null) },
  };
}

function reset() {
  replyCalls = [];
  infoLines = [];
}

const results: Array<{ name: string; ok: boolean; err?: unknown }> = [];
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

async function main() {
  const quiet = () => undefined;
  const oe = console.error;
  const ow = console.warn;
  console.error = quiet;
  console.warn = quiet;
  console.info = (...args: unknown[]) => {
    infoLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };

  await test("T1: a GROUP text message produces ZERO replies (the bot is mute in a group)", async () => {
    reset();
    const res = await POST(
      req({
        events: [
          {
            type: "message",
            replyToken: "rt-group",
            source: { type: "group", groupId: "C1", userId: "U1" },
            message: { type: "text", text: "BIND" },
          },
        ],
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(
      replyCalls.length,
      0,
      `a group message must produce no reply at all — got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`,
    );
  });

  await test("T2: positive control — a 1:1 USER message still gets its reply", async () => {
    reset();
    const res = await POST(
      req({
        events: [
          {
            type: "message",
            replyToken: "rt-user",
            // `type` is set EXPLICITLY: a fixture that omits it is non-user by the guard,
            // so it would pass while proving nothing.
            source: { type: "user", userId: "U1" },
            message: { type: "text", text: "BIND" },
          },
        ],
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(replyCalls.length, 1, "the 1:1 shift-check bot must keep working");
    assert.match(String(replyCalls[0].body?.messages?.[0]?.text ?? ""), /รูปแบบคำสั่งไม่ถูกต้อง/);
  });

  await test("T3: a ROOM source is silenced too (group is not the only non-user source)", async () => {
    reset();
    await POST(
      req({
        events: [
          {
            type: "message",
            replyToken: "rt-room",
            source: { type: "room", roomId: "R1", userId: "U1" },
            message: { type: "text", text: "help" },
          },
        ],
      }),
    );
    assert.equal(replyCalls.length, 0, "a room message must produce no reply");
  });

  await test("T4: a JOIN event is never answered", async () => {
    reset();
    await POST(
      req({
        events: [
          {
            type: "join",
            replyToken: "rt-join",
            source: { type: "group", groupId: "C1" },
          },
        ],
      }),
    );
    assert.equal(replyCalls.length, 0, "join must not be answered");
  });

  console.error = oe;
  console.warn = ow;
  console.info = originalInfo;
  globalThis.fetch = originalFetch;

  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log(`  ✓ ${r.name}`);
    else {
      failed++;
      console.log(`  ✗ ${r.name}`);
      console.log(String(r.err instanceof Error ? r.err.message : r.err));
    }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
