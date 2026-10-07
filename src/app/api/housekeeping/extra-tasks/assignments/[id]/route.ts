import { normalizeAuditSource, toBangkokDateString } from "@/lib/audit-utils";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireStaffAuth } from "@/lib/server-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const paramsSchema = z.object({ id: z.string().uuid("Invalid assignment id") });

const updateAssignmentSchema = z
  .object({
    assignment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "assignment_date must be YYYY-MM-DD").optional(),
    template_id: z.string().uuid().nullable().optional(),
    task_name: z.string().trim().min(1, "task_name is required").optional(),
    status: z.enum(["cancelled"]).optional(),
    assigned_maid: z.string().trim().min(1).optional(),
    priority: z.number().int().min(1).max(9999).optional(),
    duration_min: z.number().int().positive().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

export async function PUT(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
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

    const supabase = createServerSupabaseClient();
    // Moving or cancelling a card is a supervisor action, not a maid action.
    const auth = await requireStaffAuth(supabase, request, { denyRoles: ["owner", "maid"] });
    if (auth.error) return auth.error;
    const assignmentId = parsedParams.data.id;

    const { data: existing, error: existingError } = await supabase
      .from("extra_task_assignments")
      .select("id, status")
      .eq("id", assignmentId)
      .maybeSingle();

    if (existingError) {
      return NextResponse.json({ error: existingError.message }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: "Assignment not found." }, { status: 404 });
    }

    const updates = parsedBody.data;
    if (updates.status === "cancelled") {
      if (existing.status === "done") {
        return NextResponse.json(
          { error: "Done assignment cannot be cancelled." },
          { status: 409 }
        );
      }
      if (existing.status === "cancelled") {
        return NextResponse.json({ success: true });
      }
    }

    const { error } = await supabase
      .from("extra_task_assignments")
      .update(updates)
      .eq("id", assignmentId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Audit log (non-blocking)
    try {
      const auditAction = updates.status === "cancelled" ? "cancelled" : "update";
      await supabase.from("audit_logs").insert({
        action: auditAction,
        entity_type: "extra_task",
        entity_id: assignmentId,
        before_json: { status: existing.status },
        after_json: updates,
        business_date: toBangkokDateString(),
        source: normalizeAuditSource("manual"),
      });
    } catch (auditErr) {
      console.error("Extra task update audit log failed:", auditErr);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("extra-tasks/assignments/[id] PUT unexpected", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    const parsedParams = paramsSchema.safeParse(context.params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { error: "Invalid params.", details: parsedParams.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = createServerSupabaseClient();
    // Moving or cancelling a card is a supervisor action, not a maid action.
    const auth = await requireStaffAuth(supabase, request, { denyRoles: ["owner", "maid"] });
    if (auth.error) return auth.error;
    const assignmentId = parsedParams.data.id;

    const { data: existing, error: existingError } = await supabase
      .from("extra_task_assignments")
      .select("*")
      .eq("id", assignmentId)
      .maybeSingle();

    if (existingError) {
      return NextResponse.json({ error: existingError.message }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: "Assignment not found." }, { status: 404 });
    }

    const { error } = await supabase
      .from("extra_task_assignments")
      .delete()
      .eq("id", assignmentId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    try {
      await supabase.from("audit_logs").insert({
        action: "delete",
        entity_type: "extra_task",
        entity_id: assignmentId,
        before_json: existing,
        business_date: toBangkokDateString(),
        source: normalizeAuditSource("manual"),
      });
    } catch (auditErr) {
      console.error("Extra task delete audit log failed:", auditErr);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("extra-tasks/assignments/[id] DELETE unexpected", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
