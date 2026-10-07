// PUT and DELETE on an extra-task assignment build a service-role client, so the handler
// itself must wall the caller. Moving or cancelling a card is a supervisor action: the wall
// denies owner (the default) and maid.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "route.ts"), "utf8");

for (const method of ["PUT", "DELETE"]) {
  const start = source.indexOf(`export async function ${method}(`);
  assert.ok(start >= 0, `${method} handler exists`);
  const next = source.indexOf("export async function", start + 1);
  const body = source.slice(start, next === -1 ? undefined : next);
  const client = body.indexOf("createServerSupabaseClient()");
  const wall = body.search(/requireStaffAuth\(supabase, request, \{ denyRoles: \["owner", "maid"\] \}\)/);
  assert.ok(wall > client, `${method}: requireStaffAuth with owner+maid denied, right after the client is built`);
  assert.match(body.slice(wall), /if \(auth\.error\) return auth\.error;/, `${method}: the wall's error is returned`);
  const firstQuery = body.indexOf(".from(");
  assert.ok(firstQuery === -1 || wall < firstQuery, `${method}: wall runs before any query`);
}
console.log("extra-task assignment [id] auth wall: ok");
