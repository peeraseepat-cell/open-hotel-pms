import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve("src/app/api/maintenance/logs/route.ts"), "utf8");

// --- the POST must take the ACTOR from the wall, not just the client ---
assert.match(source, /const \{ supabase, actor \} = await requireMaintenanceAccess\(request, "write"\)/);

// --- performed_by is STAMPED from the server identity (the consumption seam) ---
// actor.name, not actor.userId: maintenance_logs.performed_by is TEXT, not a uuid FK.
assert.match(source, /performed_by: actor\.name/);

// --- and a client can no longer supply a name to be recorded as ---
assert.doesNotMatch(source, /performed_by: z\.string\(\)/);
assert.doesNotMatch(source, /performed_by: payload\.performed_by/);
assert.doesNotMatch(source, /payload\.performed_by \?\? null/);

// --- the mutation writes an audit row, attributed to a real uuid ---
assert.match(source, /from\("audit_logs"\)\.insert\(\{/);
assert.match(source, /action: "maintenance_log_created"/);
assert.match(source, /entity_type: "maintenance_logs"/);
assert.match(source, /actor_user_id: actor\.userId/);
assert.match(source, /business_date: toBangkokDateString\(\)/);
assert.match(source, /source: normalizeAuditSource\("manual"\)/);

// --- an audit failure must NOT fail the mutation (house norm: HK finish, tips) ---
assert.match(source, /console\.error\("maintenance\/logs POST audit log failed"/);
