import { maintenanceApiError, requireMaintenanceAccess } from "@/lib/maintenance/api-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const paramsSchema = z.object({ id: z.string().uuid("Invalid task id") });

const roomTypeCodeSchema = z.enum(["TS", "DS", "DQ", "DT", "JS", "TB", "FR"]);

const updateTimesSchema = z.object({
  times: z.array(
    z.object({
      room_type_code: roomTypeCodeSchema,
      estimated_minutes: z.number().int().positive(),
    })
  ),
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
    const parsedBody = updateTimesSchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid request body.", details: parsedBody.error.flatten() },
        { status: 400 }
      );
    }

    const taskId = parsedParams.data.id;

    const { data: task, error: taskError } = await supabase
      .from("maintenance_tasks")
      .select("id")
      .eq("id", taskId)
      .maybeSingle();

    if (taskError) {
      return NextResponse.json({ error: taskError.message }, { status: 500 });
    }
    if (!task) {
      return NextResponse.json({ error: "Task not found." }, { status: 404 });
    }

    const { error: deleteError } = await supabase
      .from("maintenance_task_times")
      .delete()
      .eq("task_id", taskId);

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }

    const times = parsedBody.data.times;
    if (times.length > 0) {
      const rows = times.map((time) => ({
        task_id: taskId,
        room_type_code: time.room_type_code,
        estimated_minutes: time.estimated_minutes,
      }));

      const { error: insertError } = await supabase
        .from("maintenance_task_times")
        .insert(rows);

      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const { status, message } = maintenanceApiError(err);
    if (status >= 500) console.error("maintenance/tasks/[id]/times PUT unexpected", err);
    return NextResponse.json({ error: message }, { status });
  }
}
