import { maintenanceApiError, requireMaintenanceAccess } from "@/lib/maintenance/api-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const roomTypeCodeSchema = z.enum(["TS", "DS", "DQ", "DT", "JS", "TB", "FR"]);

const createTaskSchema = z
  .object({
    name: z.string().trim().min(1, "name is required"),
    description: z.string().trim().max(2000).optional().nullable(),
    threshold_count: z.number().int().positive(),
    warning_count: z.number().int().positive().optional().nullable(),
    applicable_room_types: z.array(roomTypeCodeSchema).optional().nullable(),
    sync_to_housekeeper: z.boolean().optional().default(false),
    checklist_items: z.array(z.string().trim().min(1)).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.warning_count != null && value.warning_count >= value.threshold_count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "warning_count must be less than threshold_count",
        path: ["warning_count"],
      });
    }
  });

export async function GET(request: NextRequest) {
  try {
    const { supabase } = await requireMaintenanceAccess(request, "read");
    const { data, error } = await supabase
      .from("maintenance_tasks")
      .select(
        "id, name, description, threshold_count, warning_count, applicable_room_types, sync_to_housekeeper, checklist_items, is_active, created_at, maintenance_task_times(room_type_code, estimated_minutes)"
      )
      .order("is_active", { ascending: false })
      .order("name", { ascending: true });

    if (error) {
      console.error("maintenance/tasks GET failed", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, tasks: data ?? [] });
  } catch (err) {
    const { status, message } = maintenanceApiError(err);
    if (status >= 500) console.error("maintenance/tasks GET unexpected", err);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { supabase } = await requireMaintenanceAccess(request, "write");
    const body = await request.json().catch(() => null);
    const parsedBody = createTaskSchema.safeParse(body);

    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid request body.", details: parsedBody.error.flatten() },
        { status: 400 }
      );
    }

    const payload = parsedBody.data;

    const insertPayload = {
      name: payload.name,
      description: payload.description ?? null,
      threshold_count: payload.threshold_count,
      warning_count: payload.warning_count ?? null,
      applicable_room_types:
        payload.applicable_room_types && payload.applicable_room_types.length > 0
          ? payload.applicable_room_types
          : null,
      sync_to_housekeeper: payload.sync_to_housekeeper,
      checklist_items:
        payload.checklist_items && payload.checklist_items.length > 0
          ? payload.checklist_items
          : null,
      is_active: true,
    };

    const { data, error } = await supabase
      .from("maintenance_tasks")
      .insert(insertPayload)
      .select(
        "id, name, description, threshold_count, warning_count, applicable_room_types, sync_to_housekeeper, checklist_items, is_active, created_at"
      )
      .maybeSingle();

    if (error) {
      const isConflict = error.code === "23505";
      return NextResponse.json(
        { error: isConflict ? "Task name already exists." : error.message },
        { status: isConflict ? 409 : 500 }
      );
    }

    return NextResponse.json({ success: true, task: data }, { status: 201 });
  } catch (err) {
    const { status, message } = maintenanceApiError(err);
    if (status >= 500) console.error("maintenance/tasks POST unexpected", err);
    return NextResponse.json({ error: message }, { status });
  }
}
