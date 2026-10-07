import { maintenanceApiError, requireMaintenanceAccess } from "@/lib/maintenance/api-auth";
import { normalizeAuditSource, toBangkokDateString } from "@/lib/audit-utils";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const querySchema = z.object({
  room_id: z.string().uuid().optional(),
  resolved: z.enum(["true", "false"]).optional(),
});

const createNoteSchema = z.object({
  room_id: z.string().uuid("room_id is required"),
  task_id: z.string().uuid("task_id is required"),
  note: z.string().trim().min(1, "note is required").max(4000),
});

export async function GET(request: NextRequest) {
  try {
    const { supabase } = await requireMaintenanceAccess(request, "read");
    const parsedQuery = querySchema.safeParse({
      room_id: request.nextUrl.searchParams.get("room_id") ?? undefined,
      resolved: request.nextUrl.searchParams.get("resolved") ?? undefined,
    });

    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: "Invalid query.", details: parsedQuery.error.flatten() },
        { status: 400 }
      );
    }

    let query = supabase
      .from("maintenance_notes")
      .select("id, room_id, task_id, note, created_at, is_resolved, resolved_at")
      .order("created_at", { ascending: false });

    if (parsedQuery.data.room_id) {
      query = query.eq("room_id", parsedQuery.data.room_id);
    }

    if (parsedQuery.data.resolved === "true") {
      query = query.eq("is_resolved", true);
    }
    if (parsedQuery.data.resolved === "false") {
      query = query.eq("is_resolved", false);
    }

    const { data, error } = await query;

    if (error) {
      console.error("maintenance/notes GET failed", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, notes: data ?? [] });
  } catch (err) {
    const { status, message } = maintenanceApiError(err);
    if (status >= 500) console.error("maintenance/notes GET unexpected", err);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { supabase, actor } = await requireMaintenanceAccess(request, "write");
    const body = await request.json().catch(() => null);
    const parsedBody = createNoteSchema.safeParse(body);

    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid request body.", details: parsedBody.error.flatten() },
        { status: 400 }
      );
    }

    const payload = parsedBody.data;

    const { data: room, error: roomError } = await supabase
      .from("rooms")
      .select("id")
      .eq("id", payload.room_id)
      .maybeSingle();
    if (roomError) return NextResponse.json({ error: roomError.message }, { status: 500 });
    if (!room) return NextResponse.json({ error: "Room not found." }, { status: 404 });

    const { data: task, error: taskError } = await supabase
      .from("maintenance_tasks")
      .select("id")
      .eq("id", payload.task_id)
      .maybeSingle();
    if (taskError) return NextResponse.json({ error: taskError.message }, { status: 500 });
    if (!task) return NextResponse.json({ error: "Task not found." }, { status: 404 });

    const { data, error } = await supabase
      .from("maintenance_notes")
      .insert({
        room_id: payload.room_id,
        task_id: payload.task_id,
        note: payload.note,
      })
      .select("id, room_id, task_id, note, created_at, is_resolved, resolved_at")
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // maintenance_notes carries no author column, so the actor is recorded here.
    // Audit is a record, not a gate — a failed write must not fail the mutation.
    const { error: auditError } = await supabase.from("audit_logs").insert({
      action: "maintenance_note_created",
      entity_type: "maintenance_notes",
      entity_id: String(data?.id ?? ""),
      after_json: {
        room_id: payload.room_id,
        task_id: payload.task_id,
        note: payload.note,
        created_by_name: actor.name,
        actor_role: actor.role,
      },
      change_reason: "maintenance note created",
      actor_user_id: actor.userId,
      business_date: toBangkokDateString(),
      source: normalizeAuditSource("manual"),
    });
    if (auditError) {
      console.error("maintenance/notes POST audit log failed", auditError);
    }

    return NextResponse.json({ success: true, note: data }, { status: 201 });
  } catch (err) {
    const { status, message } = maintenanceApiError(err);
    if (status >= 500) console.error("maintenance/notes POST unexpected", err);
    return NextResponse.json({ error: message }, { status });
  }
}
