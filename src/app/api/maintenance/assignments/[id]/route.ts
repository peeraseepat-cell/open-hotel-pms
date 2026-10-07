import { maintenanceApiError, requireMaintenanceAccess } from "@/lib/maintenance/api-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const paramsSchema = z.object({ id: z.string().uuid("Invalid assignment id") });

const updateAssignmentSchema = z.object({
  status: z.enum(["completed", "cancelled"]),
  notes: z.string().trim().max(2000).optional(),
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
    const parsedBody = updateAssignmentSchema.safeParse(body);
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "Invalid request body.", details: parsedBody.error.flatten() },
        { status: 400 }
      );
    }

    const assignmentId = parsedParams.data.id;
    const payload = parsedBody.data;

    const { data: existing, error: fetchError } = await supabase
      .from("maintenance_assignments")
      .select("id, status")
      .eq("id", assignmentId)
      .maybeSingle();

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: "Assignment not found." }, { status: 404 });
    }

    if (existing.status !== "pending") {
      return NextResponse.json(
        { error: `Only pending assignment can be updated. Current status: ${existing.status}` },
        { status: 409 }
      );
    }

    const updates: Record<string, unknown> = {
      status: payload.status,
      notes: payload.notes ?? null,
    };

    if (payload.status === "completed") {
      updates.completed_at = new Date().toISOString();
    } else {
      updates.completed_at = null;
    }

    const { error: updateError } = await supabase
      .from("maintenance_assignments")
      .update(updates)
      .eq("id", assignmentId);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const { status, message } = maintenanceApiError(err);
    if (status >= 500) console.error("maintenance/assignments/[id] PUT unexpected", err);
    return NextResponse.json({ error: message }, { status });
  }
}
