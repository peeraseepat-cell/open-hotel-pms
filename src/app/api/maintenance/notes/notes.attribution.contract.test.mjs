import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const createSource = readFileSync(resolve("src/app/api/maintenance/notes/route.ts"), "utf8");
const resolveSource = readFileSync(
  resolve("src/app/api/maintenance/notes/[id]/resolve/route.ts"),
  "utf8"
);

// ─── note CREATE ─────────────────────────────────────────────────────────────
// maintenance_notes has no author column (id, room_id, task_id, note, created_at,
// is_resolved, resolved_at). Per the review decision, the actor lives in audit_logs only
// — 0 migration — because the Part-2 redesign reshapes this table into the Defect layer.
assert.match(createSource, /const \{ supabase, actor \} = await requireMaintenanceAccess\(request, "write"\)/);
assert.match(createSource, /from\("audit_logs"\)\.insert\(\{/);
assert.match(createSource, /action: "maintenance_note_created"/);
assert.match(createSource, /entity_type: "maintenance_notes"/);
assert.match(createSource, /actor_user_id: actor\.userId/);
assert.match(createSource, /console\.error\("maintenance\/notes POST audit log failed"/);

// ─── note RESOLVE ────────────────────────────────────────────────────────────
assert.match(resolveSource, /const \{ supabase, actor \} = await requireMaintenanceAccess\(request, "write"\)/);
assert.match(resolveSource, /from\("audit_logs"\)\.insert\(\{/);
assert.match(resolveSource, /action: "maintenance_note_resolved"/);
assert.match(resolveSource, /entity_type: "maintenance_notes"/);
assert.match(resolveSource, /actor_user_id: actor\.userId/);
// the audit must carry WHO resolved it — that is the entire point of this PR
assert.match(resolveSource, /resolved_by_name: actor\.name/);
// before/after tells an investigator what actually changed
assert.match(resolveSource, /before_json: \{ is_resolved: false \}/);
assert.match(resolveSource, /console\.error\("maintenance\/notes\/\[id\]\/resolve POST audit log failed"/);

// an already-resolved note short-circuits — it must NOT emit a second audit row
// claiming this actor resolved something they didn't.
assert.match(resolveSource, /if \(note\.is_resolved\) \{\n\s*return NextResponse\.json\(\{ success: true \}\);/);
