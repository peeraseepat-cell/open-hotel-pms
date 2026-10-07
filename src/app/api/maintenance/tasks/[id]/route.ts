import { maintenanceApiError, requireMaintenanceAccess } from "@/lib/maintenance/api-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const paramsSchema = z.object({ id: z.string().uuid("Invalid task id") });
const roomTypeCodeSchema = z.enum(["TS", "DS", "DQ", "DT", "JS", "TB", "FR"]);

const updateTaskSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    threshold_count: z.number().int().positive().optional(),
    warning_count: z.number().int().positive().nullable().optional(),
    applicable_room_types: z.array(roomTypeCodeSchema).nullable().optional(),
    sync_to_housekeeper: z.boolean().optional(),
    checklist_items: z.array(z.string().trim().min(1)).nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

export async function PUT(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    const { supabase } = await requireMaintenanceAccess(request, "write");

    const parsedParams = paramsSchema.safeParse(context.params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { error: "Invalid params.", details: parsedParams.error.flatten() },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => null);
    const parsedBody = updateTaskSchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid request body.", details: parsedBody.error.flatten() },
        { status: 400 }
      );
    }

    const taskId = parsedParams.data.id;

    const { data: existingTask, error: existingError } = await supabase
      .from("maintenance_tasks")
      .select("id, threshold_count, warning_count")
      .eq("id", taskId)
      .maybeSingle();

    if (existingError) {
      return NextResponse.json({ error: existingError.message }, { status: 500 });
    }
    if (!existingTask) {
      return NextResponse.json({ error: "Task not found." }, { status: 404 });
    }

    const updates = parsedBody.data;
    const nextThreshold = updates.threshold_count ?? existingTask.threshold_count;
    const nextWarning = updates.warning_count === undefined ? existingTask.warning_count : updates.warning_count;

    if (nextWarning != null && nextWarning >= nextThreshold) {
      return NextResponse.json(
        { error: "warning_count must be less than threshold_count." },
        { status: 400 }
      );
    }

    const normalizedUpdates: Record<string, unknown> = { ...updates };
    if (updates.applicable_room_types !== undefined) {
      normalizedUpdates.applicable_room_types =
        updates.applicable_room_types && updates.applicable_room_types.length > 0
          ? updates.applicable_room_types
          : null;
    }

    if (updates.checklist_items !== undefined) {
      normalizedUpdates.checklist_items =
        updates.checklist_items && updates.checklist_items.length > 0
          ? updates.checklist_items
          : null;
    }

    const { error } = await supabase
      .from("maintenance_tasks")
      .update(normalizedUpdates)
      .eq("id", taskId);

    if (error) {
      const isConflict = error.code === "23505";
      return NextResponse.json(
        { error: isConflict ? "Task name already exists." : error.message },
        { status: isConflict ? 409 : 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const { status, message } = maintenanceApiError(err);
    if (status >= 500) console.error("maintenance/tasks/[id] PUT unexpected", err);
    return NextResponse.json({ error: message }, { status });
  }
}

// DELETE = deactivate, not destroy. The hard delete cascaded through
// maintenance_logs / maintenance_assignments / maintenance_task_times (all
// `on delete cascade`), so removing one task erased its entire service history.
// The route stays for UI compatibility, but retires the task via is_active instead:
// get_room_maintenance_status() already excludes inactive tasks (phase9:220) and
// POST /assignments already refuses them with a 409, so retiring is complete without
// touching a row of history. The task list deliberately still shows inactive tasks
// (ordered active-last) so an admin can reactivate — and so a retired task's name
// stays visible, since `name` is UNIQUE and an invisible row would block re-creating it.
export async function DELETE(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    const { supabase } = await requireMaintenanceAccess(request, "delete");

    const parsedParams = paramsSchema.safeParse(context.params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { error: "Invalid params.", details: parsedParams.error.flatten() },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from("maintenance_tasks")
      .update({ is_active: false })
      .eq("id", parsedParams.data.id)
      .select("id")
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: "Task not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true, deactivated: true });
  } catch (err) {
    const { status, message } = maintenanceApiError(err);
    if (status >= 500) console.error("maintenance/tasks/[id] DELETE unexpected", err);
    return NextResponse.json({ error: message }, { status });
  }
}
