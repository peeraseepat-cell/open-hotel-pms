import { maintenanceApiError, requireMaintenanceAccess } from "@/lib/maintenance/api-auth";
import { normalizeAuditSource, toBangkokDateString } from "@/lib/audit-utils";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const paramsSchema = z.object({ id: z.string().uuid("Invalid note id") });
const emptyBodySchema = z.object({}).passthrough();

export async function POST(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    const { supabase, actor } = await requireMaintenanceAccess(request, "write");
    const parsedParams = paramsSchema.safeParse(context.params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { error: "Invalid params.", details: parsedParams.error.flatten() },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const parsedBody = emptyBodySchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid request body.", details: parsedBody.error.flatten() },
        { status: 400 }
      );
    }

    const noteId = parsedParams.data.id;

    const { data: note, error: fetchError } = await supabase
      .from("maintenance_notes")
      .select("id, is_resolved")
      .eq("id", noteId)
      .maybeSingle();

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }
    if (!note) {
      return NextResponse.json({ error: "Note not found." }, { status: 404 });
    }
    if (note.is_resolved) {
      return NextResponse.json({ success: true });
    }

    const resolvedAt = new Date().toISOString();

    const { error: updateError } = await supabase
      .from("maintenance_notes")
      .update({
        is_resolved: true,
        resolved_at: resolvedAt,
      })
      .eq("id", noteId);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // "Resolved" used to record nobody. The actor is recorded here because
    // maintenance_notes has no resolver column (review decision: audit_logs only,
    // 0 migration — the Part-2 redesign reshapes this table).
    const { error: auditError } = await supabase.from("audit_logs").insert({
      action: "maintenance_note_resolved",
      entity_type: "maintenance_notes",
      entity_id: noteId,
      before_json: { is_resolved: false },
      after_json: {
        is_resolved: true,
        resolved_at: resolvedAt,
        resolved_by_name: actor.name,
        actor_role: actor.role,
      },
      change_reason: "maintenance note resolved",
      actor_user_id: actor.userId,
      business_date: toBangkokDateString(),
      source: normalizeAuditSource("manual"),
    });
    if (auditError) {
      console.error("maintenance/notes/[id]/resolve POST audit log failed", auditError);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const { status, message } = maintenanceApiError(err);
    if (status >= 500) console.error("maintenance/notes/[id]/resolve POST unexpected", err);
    return NextResponse.json({ error: message }, { status });
  }
}
