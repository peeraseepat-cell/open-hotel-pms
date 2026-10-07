import { maintenanceApiError, requireMaintenanceAccess } from "@/lib/maintenance/api-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const listQuerySchema = z.object({
  date: z.string().regex(dateRegex, "date must be YYYY-MM-DD").optional(),
});

const dueQuerySchema = z.object({
  date: z.string().regex(dateRegex, "date must be YYYY-MM-DD").optional(),
  room_ids: z.string().min(1, "room_ids is required"),
});

const createAssignmentSchema = z.object({
  room_id: z.string().uuid("room_id is required"),
  task_id: z.string().uuid("task_id is required"),
  assigned_by: z.string().trim().max(120).optional(),
  assigned_date: z.string().regex(dateRegex, "assigned_date must be YYYY-MM-DD").optional(),
  notes: z.string().trim().max(2000).optional(),
});

type DueMaintenanceRow = {
  room_id: string;
  task_id: string;
  task_name: string;
  checklist_items: string[] | null;
  estimated_minutes: number | null;
  stays_since_last: number | null;
  threshold_count: number | null;
  status: string;
};

type PendingAssignmentRow = {
  id: string;
  room_id: string;
  task_id: string;
};

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

function parseUuidList(raw: string): string[] {
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const uuidSchema = z.string().uuid();
  const unique = Array.from(new Set(items));
  return unique.filter((item) => uuidSchema.safeParse(item).success);
}

export async function GET(request: NextRequest) {
  try {
    const { supabase } = await requireMaintenanceAccess(request, "read");
    const mode = request.nextUrl.searchParams.get("mode") ?? "list";

    if (mode === "due") {
      const parsedQuery = dueQuerySchema.safeParse({
        date: request.nextUrl.searchParams.get("date") ?? undefined,
        room_ids: request.nextUrl.searchParams.get("room_ids") ?? "",
      });

      if (!parsedQuery.success) {
        return NextResponse.json(
          { error: "Invalid query.", details: parsedQuery.error.flatten() },
          { status: 400 }
        );
      }

      const targetDate = parsedQuery.data.date ?? getThailandDateString();
      const roomIds = parseUuidList(parsedQuery.data.room_ids);
      if (roomIds.length === 0) {
        return NextResponse.json({ success: true, date: targetDate, due_tasks: [] });
      }

      const { data: dueRows, error: dueError } = await supabase.rpc("get_maintenance_for_rooms", {
        p_room_ids: roomIds,
      });

      if (dueError) {
        console.error("maintenance/assignments GET due rpc failed", dueError);
        return NextResponse.json({ error: dueError.message }, { status: 500 });
      }

      const { data: roomRows, error: roomError } = await supabase
        .from("rooms")
        .select("id, room_number")
        .in("id", roomIds);
      if (roomError) {
        console.error("maintenance/assignments GET due room map failed", roomError);
        return NextResponse.json({ error: roomError.message }, { status: 500 });
      }
      const roomNumberById = new Map<string, string>();
      for (const row of roomRows ?? []) {
        roomNumberById.set(String(row.id), String(row.room_number ?? ""));
      }

      const { data: pendingRows, error: pendingError } = await supabase
        .from("maintenance_assignments")
        .select("id, room_id, task_id")
        .eq("assigned_date", targetDate)
        .eq("status", "pending")
        .in("room_id", roomIds);

      if (pendingError) {
        console.error("maintenance/assignments GET due pending check failed", pendingError);
        return NextResponse.json({ error: pendingError.message }, { status: 500 });
      }

      const pendingByKey = new Map<string, string>();
      for (const row of (pendingRows ?? []) as PendingAssignmentRow[]) {
        pendingByKey.set(`${row.room_id}:${row.task_id}`, row.id);
      }

      const dueTasks = ((dueRows ?? []) as DueMaintenanceRow[])
        .map((row) => {
          const roomId = String(row.room_id);
          const taskId = String(row.task_id);
          const key = `${roomId}:${taskId}`;
          const existingAssignmentId = pendingByKey.get(key) ?? null;
          return {
            room_id: roomId,
            room_number: roomNumberById.get(roomId) ?? "",
            task_id: taskId,
            task_name: String(row.task_name ?? ""),
            checklist_items: Array.isArray(row.checklist_items) ? row.checklist_items : null,
            estimated_minutes: Number(row.estimated_minutes ?? 0),
            stays_since_last: Number(row.stays_since_last ?? 0),
            threshold_count: Number(row.threshold_count ?? 0),
            status: String(row.status ?? "OVERDUE"),
            already_assigned: Boolean(existingAssignmentId),
            assignment_id: existingAssignmentId,
          };
        })
        .sort((a, b) => {
          const roomDiff = a.room_number.localeCompare(b.room_number, undefined, { numeric: true });
          if (roomDiff !== 0) return roomDiff;
          return a.task_name.localeCompare(b.task_name, undefined, { numeric: true });
        });

      return NextResponse.json({ success: true, date: targetDate, due_tasks: dueTasks });
    }

    const parsedQuery = listQuerySchema.safeParse({
      date: request.nextUrl.searchParams.get("date") ?? undefined,
    });

    if (!parsedQuery.success) {
      return NextResponse.json(
        { error: "Invalid query.", details: parsedQuery.error.flatten() },
        { status: 400 }
      );
    }

    const targetDate = parsedQuery.data.date ?? getThailandDateString();

    const { data, error } = await supabase.rpc("get_todays_maintenance_assignments", {
      p_target_date: targetDate,
    });

    if (error) {
      console.error("maintenance/assignments GET rpc failed", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const assignments = (data ?? []).map((row: any) => ({
      id: row.assignment_id,
      room_id: row.room_id,
      room_number: row.room_number,
      room_type_code: row.room_type_code,
      task_id: row.task_id,
      task_name: row.task_name,
      checklist_items: row.checklist_items,
      estimated_minutes: row.estimated_minutes,
      status: row.status,
      assigned_by: row.assigned_by,
      assigned_at: row.assigned_at,
      notes: row.notes,
    }));

    return NextResponse.json({ success: true, assignments });
  } catch (err) {
    const { status, message } = maintenanceApiError(err);
    if (status >= 500) console.error("maintenance/assignments GET unexpected", err);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { supabase } = await requireMaintenanceAccess(request, "write");
    const body = await request.json().catch(() => null);
    const parsedBody = createAssignmentSchema.safeParse(body);

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
      .select("id, is_active")
      .eq("id", payload.task_id)
      .maybeSingle();
    if (taskError) return NextResponse.json({ error: taskError.message }, { status: 500 });
    if (!task) return NextResponse.json({ error: "Task not found." }, { status: 404 });
    if (!task.is_active) return NextResponse.json({ error: "Task is inactive." }, { status: 409 });

    const assignedDate = payload.assigned_date ?? getThailandDateString();
    const { data: duplicatePending, error: duplicateError } = await supabase
      .from("maintenance_assignments")
      .select("id, room_id, task_id, assigned_at, assigned_by, assigned_date, status, completed_at, notes")
      .eq("room_id", payload.room_id)
      .eq("task_id", payload.task_id)
      .eq("assigned_date", assignedDate)
      .eq("status", "pending")
      .maybeSingle();

    if (duplicateError && duplicateError.code !== "PGRST116") {
      console.error("maintenance/assignments POST duplicate check failed", duplicateError);
      return NextResponse.json({ error: duplicateError.message }, { status: 500 });
    }

    if (duplicatePending) {
      return NextResponse.json(
        { success: true, assignment: duplicatePending, duplicate: true },
        { status: 200 }
      );
    }

    const { data, error } = await supabase
      .from("maintenance_assignments")
      .insert({
        room_id: payload.room_id,
        task_id: payload.task_id,
        assigned_by: payload.assigned_by ?? null,
        assigned_date: assignedDate,
        status: "pending",
        notes: payload.notes ?? null,
      })
      .select("id, room_id, task_id, assigned_at, assigned_by, assigned_date, status, completed_at, notes")
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, assignment: data }, { status: 201 });
  } catch (err) {
    const { status, message } = maintenanceApiError(err);
    if (status >= 500) console.error("maintenance/assignments POST unexpected", err);
    return NextResponse.json({ error: message }, { status });
  }
}
