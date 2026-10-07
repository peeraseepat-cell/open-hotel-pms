import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Contract: every /api/maintenance/* handler is walled, and DELETE retires instead
// of destroying.
//
// Before S2 these routes had ZERO auth: middleware 403s only `owner` on mutations and
// checks no role on GET, and its maid/mobile walls are page-scoped. So an authenticated
// maid session could hard-delete a task and cascade away its logs/assignments/times.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Tier per handler, as decided in review:
// READ = admin/supervisor/frontdesk or allowed_pages · WRITE = admin/supervisor · DELETE = admin
const EXPECTED = {
  "assignments/[id]/route.ts": { PUT: "write" },
  "assignments/route.ts": { GET: "read", POST: "write" },
  "logs/route.ts": { GET: "read", POST: "write" },
  "notes/[id]/resolve/route.ts": { POST: "write" },
  "notes/route.ts": { GET: "read", POST: "write" },
  "status/route.ts": { GET: "read" },
  "tasks/[id]/route.ts": { PUT: "write", DELETE: "delete" },
  "tasks/[id]/times/route.ts": { PUT: "write" },
  "tasks/route.ts": { GET: "read", POST: "write" },
};

function handlerBody(source, fn) {
  const start = source.indexOf(`export async function ${fn}(`);
  if (start === -1) return null;
  const next = source.slice(start + 1).search(/\nexport async function /);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

let walled = 0;
for (const [rel, handlers] of Object.entries(EXPECTED)) {
  const source = fs.readFileSync(path.join(HERE, rel), "utf8");

  for (const [fn, tier] of Object.entries(handlers)) {
    const body = handlerBody(source, fn);
    assert.ok(body, `${rel} must export ${fn}`);

    // The wall must be present AND carry the right tier — a `read` wall on a write
    // handler is worse than none, because it reads as protected.
    assert.match(
      body,
      new RegExp(`requireMaintenanceAccess\\(request, "${tier}"\\)`),
      `${rel} ${fn} must be walled at the "${tier}" tier`
    );

    // The wall must come before any table access, or it gates nothing.
    const wallAt = body.indexOf("requireMaintenanceAccess");
    const dbAt = body.indexOf(".from(");
    if (dbAt !== -1) {
      assert.ok(wallAt < dbAt, `${rel} ${fn} must authenticate BEFORE touching the database`);
    }

    // A thrown 401/403 must not be swallowed into a 500 by the pre-existing catch.
    assert.doesNotMatch(
      body,
      /String\(err\) \}, \{ status: 500 \}/,
      `${rel} ${fn} must map thrown auth errors via maintenanceApiError, not blanket-500 them`
    );
    walled += 1;
  }
}
assert.equal(walled, 14, "all 14 maintenance handlers must be walled");

// ── no handler may mint its own service-role client and dodge the wall ──
for (const rel of Object.keys(EXPECTED)) {
  const source = fs.readFileSync(path.join(HERE, rel), "utf8");
  assert.doesNotMatch(
    source,
    /createServerSupabaseClient/,
    `${rel} must take its client from requireMaintenanceAccess, not mint an unwalled one`
  );
}

// ── DELETE retires, never destroys ──
const taskRoute = fs.readFileSync(path.join(HERE, "tasks/[id]/route.ts"), "utf8");
const del = handlerBody(taskRoute, "DELETE");
assert.match(
  del,
  /\.update\(\{ is_active: false \}\)/,
  "DELETE must retire via is_active=false (is_active already exists since phase9:22)"
);
assert.doesNotMatch(
  del,
  /\.delete\(\)/,
  "DELETE must NOT hard-delete — maintenance_logs/assignments/task_times cascade on delete, which erases the task's whole service history"
);
assert.match(del, /deactivated: true/, "DELETE response must say deactivated, not deleted");

// ── the confirm dialog must not promise history deletion it no longer performs ──
const page = fs.readFileSync(
  path.join(HERE, "../../pms/housekeeping/maintenance/tasks/page.tsx"),
  "utf8"
);
assert.doesNotMatch(
  page,
  /permanently removed/i,
  "the confirm dialog must not promise permanent history removal — under retire semantics that is a lie"
);
assert.match(
  page,
  /history and notes are kept/i,
  "the confirm dialog must state that history is kept"
);
// The optimistic list update must retire in place, not drop the row: the server keeps
// the task so it stays reactivable, and a filtered row silently returns on refresh.
assert.doesNotMatch(
  page,
  /setTasks\(tasks\.filter\(t => t\.id !== deleteTarget\.id\)\)/,
  "the list must not drop the row — the server keeps it (is_active=false) and it must stay reactivable"
);
