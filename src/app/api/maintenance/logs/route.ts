import { maintenanceApiError, requireMaintenanceAccess } from "@/lib/maintenance/api-auth";
import { normalizeAuditSource, toBangkokDateString } from "@/lib/audit-utils";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const querySchema = z.object({
  room_id: z.string().uuid().optional(),
  task_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

// performed_by is deliberately absent: it is stamped server-side from the
// authenticated actor. A client does not get to choose who it was.
const createLogSchema = z.object({
  room_id: z.string().uuid("room_id is required"),
  task_id: z.string().uuid("task_id is required"),
  notes: z.string().trim().max(2000).optional(),
  assignment_id: z.string().uuid().optional(),
});

function getThailandDateString(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return new Date().toISOString().slice(0, 10);
  return `${year}-${month}-${day}`;
}

export async function GET(request: NextRequest) {
  try {
    const { supabase } = await requireMaintenanceAccess(request, "read");
    const parsedQuery = querySchema.safeParse({
      room_id: request.nextUrl.searchParams.get("room_id") ?? undefined,
      task_id: request.nextUrl.searchParams.get("task_id") ?? undefined,
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
    });

    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: "Invalid query.", details: parsedQuery.error.flatten() },
        { status: 400 }
      );
    }

    const { room_id, task_id, limit } = parsedQuery.data;

    let query = supabase
      .from("maintenance_logs")
      .select(
        "id, room_id, task_id, performed_at, performed_by, stay_count_at_time, notes, rooms(room_number), maintenance_tasks(name)"
      )
      .order("performed_at", { ascending: false })
      .limit(limit ?? 100);

    if (room_id) query = query.eq("room_id", room_id);
    if (task_id) query = query.eq("task_id", task_id);

    const { data, error } = await query;

    if (error) {
      console.error("maintenance/logs GET failed", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const logs = (data ?? []).map((row: any) => ({
      id: row.id,
      room_id: row.room_id,
      room_number: row.rooms?.room_number ?? null,
      task_id: row.task_id,
      task_name: row.maintenance_tasks?.name ?? null,
      performed_at: row.performed_at,
      performed_by: row.performed_by,
      stay_count_at_time: row.stay_count_at_time,
      notes: row.notes,
    }));

    return NextResponse.json({ success: true, logs });
  } catch (err) {
    const { status, message } = maintenanceApiError(err);
    if (status >= 500) console.error("maintenance/logs GET unexpected", err);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { supabase, actor } = await requireMaintenanceAccess(request, "write");
    const body = await request.json().catch(() => null);
    const parsedBody = createLogSchema.safeParse(body);

    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid request body.", details: parsedBody.error.flatten() },
        { status: 400 }
      );
    }

    const payload = parsedBody.data;
    const normalizedNote = payload.notes?.trim() || null;

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

    const completedAt = new Date().toISOString();
    const targetDate = getThailandDateString();

    const { data, error } = await supabase
      .from("maintenance_logs")
      .insert({
        room_id: payload.room_id,
        task_id: payload.task_id,
        performed_at: completedAt,
        performed_by: actor.name,
        notes: normalizedNote ?? "Marked done via Maintenance Hub",
      })
      .select("id, room_id, task_id, performed_at, performed_by, stay_count_at_time, notes")
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    let assignmentUpdateQuery = supabase
      .from("maintenance_assignments")
      .update({
        status: "completed",
        completed_at: completedAt,
      })
      .eq("status", "pending")
      .eq("room_id", payload.room_id)
      .eq("task_id", payload.task_id);

    if (payload.assignment_id) {
      assignmentUpdateQuery = assignmentUpdateQuery.eq("id", payload.assignment_id);
    } else {
      // Default behavior: closing a maintenance log means all pending due records up to today are completed.
      assignmentUpdateQuery = assignmentUpdateQuery.lte("assigned_date", targetDate);
    }

    const { data: completedAssignments, error: assignmentError } = await assignmentUpdateQuery
      .select("id");

    if (assignmentError) {
      console.error("maintenance/logs POST assignment completion failed", assignmentError);
      return NextResponse.json(
        { error: assignmentError.message, log: data, log_saved: true },
        { status: 500 }
      );
    }

    const completedAssignmentCount = (completedAssignments ?? []).length;
    let effectiveLog = data;

    if (data?.id && completedAssignmentCount > 0) {
      const autoCloseNote = normalizedNote
        ? `${normalizedNote} | Auto-closed ${completedAssignmentCount} pending assignment(s)`
        : `Marked done via Maintenance Hub | Auto-closed ${completedAssignmentCount} pending assignment(s)`;

      const { data: updatedLog, error: updateLogError } = await supabase
        .from("maintenance_logs")
        .update({ notes: autoCloseNote })
        .eq("id", data.id)
        .select("id, room_id, task_id, performed_at, performed_by, stay_count_at_time, notes")
        .maybeSingle();

      if (updateLogError) {
        console.error("maintenance/logs POST update auto-close note failed", updateLogError);
      } else if (updatedLog) {
        effectiveLog = updatedLog;
      }
    }

    // Audit is a record, not a gate: a failed audit write must not fail the
    // mutation that already succeeded (same posture as HK finish and tips).
    const { error: auditError } = await supabase.from("audit_logs").insert({
      action: "maintenance_log_created",
      entity_type: "maintenance_logs",
      entity_id: String(effectiveLog?.id ?? ""),
      after_json: {
        room_id: payload.room_id,
        task_id: payload.task_id,
        performed_at: completedAt,
        performed_by: actor.name,
        notes: effectiveLog?.notes ?? null,
        completed_assignment_count: completedAssignmentCount,
        actor_role: actor.role,
      },
      change_reason: "maintenance task marked done",
      actor_user_id: actor.userId,
      business_date: toBangkokDateString(),
      source: normalizeAuditSource("manual"),
    });
    if (auditError) {
      console.error("maintenance/logs POST audit log failed", auditError);
    }

    return NextResponse.json(
      {
        success: true,
        log: effectiveLog,
        completed_assignment_count: completedAssignmentCount,
      },
      { status: 201 }
    );
  } catch (err) {
    const { status, message } = maintenanceApiError(err);
    if (status >= 500) console.error("maintenance/logs POST unexpected", err);
    return NextResponse.json({ error: message }, { status });
  }
}
