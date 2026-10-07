import { normalizeAuditSource, toBangkokDateString } from "@/lib/audit-utils";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireStaffAuth } from "@/lib/server-auth";
import { syncStaffFromProfiles } from "@/lib/staff-sync";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const patchSchema = z
  .object({
    display_name: z.string().trim().min(1).max(120).optional(),
    nickname: z.string().trim().max(120).nullable().optional(),
    department_id: z.string().uuid().nullable().optional(),
    is_active: z.boolean().optional(),
    hk_lane_enabled: z.boolean().optional(),
    hk_lane_order: z.coerce.number().int().min(1).max(999).optional(),
  })
  .refine(
    (value) =>
      value.display_name !== undefined ||
      value.nickname !== undefined ||
      value.department_id !== undefined ||
      value.is_active !== undefined ||
      value.hk_lane_enabled !== undefined ||
      value.hk_lane_order !== undefined,
    { message: "At least one field is required." }
  );

async function syncRenamedAssignments(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  oldName: string,
  newName: string
) {
  if (!oldName || !newName || oldName === newName) {
    return { daily_plans: 0, housekeeping_tasks: 0, extra_task_assignments: 0 };
  }

  const [dailyPlanResult, hkTaskResult, extraTaskResult] = await Promise.all([
    supabase
      .from("daily_plans")
      .update({ assigned_maid: newName })
      .eq("assigned_maid", oldName)
      .select("id"),
    supabase
      .from("housekeeping_tasks")
      .update({ assigned_maid_name: newName })
      .eq("assigned_maid_name", oldName)
      .select("id"),
    supabase
      .from("extra_task_assignments")
      .update({ assigned_maid: newName })
      .eq("assigned_maid", oldName)
      .select("id"),
  ]);

  if (dailyPlanResult.error) throw new Error(dailyPlanResult.error.message);
  if (hkTaskResult.error) throw new Error(hkTaskResult.error.message);
  if (extraTaskResult.error) throw new Error(extraTaskResult.error.message);

  return {
    daily_plans: (dailyPlanResult.data ?? []).length,
    housekeeping_tasks: (hkTaskResult.data ?? []).length,
    extra_task_assignments: (extraTaskResult.data ?? []).length,
  };
}

function isLaneColumnMissing(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("hk_lane_enabled") || lower.includes("hk_lane_order");
}

export async function PATCH(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    const supabase = createServerSupabaseClient();
    // Management mutation: renaming/deactivating staff cascades hotel-wide via
    // syncRenamedAssignments. Gate to admin/supervisor — the tier /api/staff/invite enforces.
    const auth = await requireStaffAuth(supabase, request, { allowRoles: ["admin", "supervisor"] });
    if (auth.error) return auth.error;
    const user = auth.user;

    try {
      await syncStaffFromProfiles(supabase);
    } catch (syncError) {
      console.error("api/staff/[id] PATCH syncStaffFromProfiles failed", syncError);
    }

    const parsedParams = paramsSchema.safeParse(context.params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { success: false, error: "Invalid path params.", details: parsedParams.error.flatten() },
        { status: 400 }
      );
    }

    const json = await request.json().catch(() => null);
    const parsedBody = patchSchema.safeParse(json);
    if (!parsedBody.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsedBody.error.flatten() },
        { status: 400 }
      );
    }

    const staffId = parsedParams.data.id;
    const payload = parsedBody.data;

    let laneColumnsAvailable = true;
    let currentStaff: Record<string, unknown> | null = null;

    const withLaneSelect = await supabase
      .from("staff")
      .select("id, display_name, hk_lane_enabled, is_active")
      .eq("id", staffId)
      .maybeSingle();
    if (withLaneSelect.error) {
      if (!isLaneColumnMissing(String(withLaneSelect.error.message ?? ""))) {
        return NextResponse.json({ success: false, error: withLaneSelect.error.message }, { status: 500 });
      }
      laneColumnsAvailable = false;
      const fallbackSelect = await supabase
        .from("staff")
        .select("id, display_name, is_active")
        .eq("id", staffId)
        .maybeSingle();
      if (fallbackSelect.error) {
        return NextResponse.json({ success: false, error: fallbackSelect.error.message }, { status: 500 });
      }
      currentStaff = (fallbackSelect.data ?? null) as Record<string, unknown> | null;
    } else {
      currentStaff = (withLaneSelect.data ?? null) as Record<string, unknown> | null;
    }

    if (currentStaff) {
      if (
        !laneColumnsAvailable &&
        (payload.hk_lane_enabled !== undefined || payload.hk_lane_order !== undefined)
      ) {
        return NextResponse.json(
          {
            success: false,
            error:
              "DB migration required: apply 20260305_phase12b_staff_hk_lane.sql before editing HK lane settings.",
          },
          { status: 500 }
        );
      }

      const currentName = String(currentStaff.display_name ?? "").trim();
      const nextName =
        payload.display_name !== undefined ? String(payload.display_name).trim() : currentName;
      const nextLaneEnabled =
        payload.hk_lane_enabled !== undefined
          ? payload.hk_lane_enabled
          : laneColumnsAvailable
            ? Boolean(currentStaff.hk_lane_enabled ?? false)
            : false;
      const nextIsActive =
        payload.is_active !== undefined
          ? payload.is_active
          : Boolean(currentStaff.is_active ?? true);

      if (nextLaneEnabled && nextIsActive) {
        const duplicateAuth = await supabase
          .from("staff")
          .select("id")
          .neq("id", staffId)
          .eq("is_active", true)
          .ilike("display_name", nextName)
          .limit(1)
          .maybeSingle();
        if (duplicateAuth.error) {
          return NextResponse.json({ success: false, error: duplicateAuth.error.message }, { status: 500 });
        }
        if (duplicateAuth.data) {
          return NextResponse.json(
            { success: false, error: `HK lane name "${nextName}" is already used.` },
            { status: 409 }
          );
        }

        const duplicateLane = await supabase
          .from("hk_staff_lanes")
          .select("id")
          .eq("is_active", true)
          .ilike("display_name", nextName)
          .limit(1)
          .maybeSingle();
        if (duplicateLane.error) {
          const lower = String(duplicateLane.error.message ?? "").toLowerCase();
          if (!lower.includes("hk_staff_lanes") && !lower.includes("does not exist")) {
            return NextResponse.json({ success: false, error: duplicateLane.error.message }, { status: 500 });
          }
        } else if (duplicateLane.data) {
          return NextResponse.json(
            { success: false, error: `HK lane name "${nextName}" is already used.` },
            { status: 409 }
          );
        }
      }

      const updatePayload: Record<string, unknown> = {};
      if (payload.display_name !== undefined) updatePayload.display_name = nextName;
      if (payload.nickname !== undefined) updatePayload.nickname = payload.nickname?.trim() || null;
      if (payload.department_id !== undefined) updatePayload.department_id = payload.department_id;
      if (payload.is_active !== undefined) updatePayload.is_active = payload.is_active;
      if (laneColumnsAvailable && payload.hk_lane_enabled !== undefined) {
        updatePayload.hk_lane_enabled = payload.hk_lane_enabled;
      }
      if (laneColumnsAvailable && payload.hk_lane_order !== undefined) {
        updatePayload.hk_lane_order = payload.hk_lane_order;
      }

      const updateSelect = laneColumnsAvailable
        ? "id, employee_code, display_name, nickname, department_id, is_active, hk_lane_enabled, hk_lane_order, department:departments(id,code,name)"
        : "id, employee_code, display_name, nickname, department_id, is_active, department:departments(id,code,name)";

      const updatedResult = await supabase
        .from("staff")
        .update(updatePayload)
        .eq("id", staffId)
        .select(updateSelect)
        .maybeSingle();
      if (updatedResult.error) {
        return NextResponse.json({ success: false, error: updatedResult.error.message }, { status: 500 });
      }

      const sync = await syncRenamedAssignments(supabase, currentName, nextName);
      const updated = (updatedResult.data ?? null) as Record<string, unknown> | null;
      const relation = Array.isArray(updated?.department) ? updated?.department[0] : updated?.department;

      // Audit log (non-blocking)
      try {
        await supabase.from("audit_logs").insert({
          actor_user_id: user?.id ?? null,
          action: "staff_updated",
          entity_type: "staff",
          entity_id: staffId,
          before_json: { display_name: currentName },
          after_json: updatePayload,
          business_date: toBangkokDateString(),
          source: normalizeAuditSource("manual"),
        });
      } catch (auditErr) {
        console.error("Staff update audit log failed:", auditErr);
      }

      return NextResponse.json({
        success: true,
        data: updated
          ? {
              id: String(updated.id),
              employee_code: String(updated.employee_code),
              display_name: String(updated.display_name),
              nickname: updated.nickname ? String(updated.nickname) : null,
              department_id: updated.department_id ? String(updated.department_id) : null,
              is_active: Boolean(updated.is_active),
              hk_lane_enabled: laneColumnsAvailable ? Boolean(updated.hk_lane_enabled ?? false) : false,
              hk_lane_order: laneColumnsAvailable ? Number(updated.hk_lane_order ?? 100) : 100,
              department: relation
                ? {
                    id: String((relation as { id?: string }).id ?? ""),
                    code: String((relation as { code?: string }).code ?? ""),
                    name: String((relation as { name?: string }).name ?? ""),
                  }
                : null,
              source: "staff",
              can_bind_line: true,
            }
          : null,
        sync,
      });
    }

    const currentLane = await supabase
      .from("hk_staff_lanes")
      .select("id, display_name, nickname, department_code, is_active, hk_lane_enabled, hk_lane_order")
      .eq("id", staffId)
      .maybeSingle();
    if (currentLane.error) {
      const lower = String(currentLane.error.message ?? "").toLowerCase();
      if (lower.includes("hk_staff_lanes") || lower.includes("does not exist")) {
        return NextResponse.json(
          {
            success: false,
            error:
              "DB migration required: apply 20260305_phase12b_hk_staff_lanes.sql before editing manual staff lanes.",
          },
          { status: 500 }
        );
      }
      return NextResponse.json({ success: false, error: currentLane.error.message }, { status: 500 });
    }
    if (!currentLane.data) {
      return NextResponse.json({ success: false, error: "Staff not found." }, { status: 404 });
    }

    const current = currentLane.data;
    const currentName = String(current.display_name ?? "").trim();
    const nextName = payload.display_name !== undefined ? String(payload.display_name).trim() : currentName;
    const nextLaneEnabled =
      payload.hk_lane_enabled !== undefined ? payload.hk_lane_enabled : Boolean(current.hk_lane_enabled);
    const nextIsActive = payload.is_active !== undefined ? payload.is_active : Boolean(current.is_active);

    if (nextLaneEnabled && nextIsActive) {
      const duplicateAuth = await supabase
        .from("staff")
        .select("id")
        .eq("is_active", true)
        .ilike("display_name", nextName)
        .limit(1)
        .maybeSingle();
      if (duplicateAuth.error) {
        return NextResponse.json({ success: false, error: duplicateAuth.error.message }, { status: 500 });
      }
      if (duplicateAuth.data) {
        return NextResponse.json(
          { success: false, error: `HK lane name "${nextName}" is already used.` },
          { status: 409 }
        );
      }

      const duplicateLane = await supabase
        .from("hk_staff_lanes")
        .select("id")
        .neq("id", staffId)
        .eq("is_active", true)
        .ilike("display_name", nextName)
        .limit(1)
        .maybeSingle();
      if (duplicateLane.error) {
        return NextResponse.json({ success: false, error: duplicateLane.error.message }, { status: 500 });
      }
      if (duplicateLane.data) {
        return NextResponse.json(
          { success: false, error: `HK lane name "${nextName}" is already used.` },
          { status: 409 }
        );
      }
    }

    let nextDepartmentCode = String(current.department_code ?? "HK");
    if (payload.department_id !== undefined) {
      if (payload.department_id === null) {
        nextDepartmentCode = "HK";
      } else {
        const dept = await supabase
          .from("departments")
          .select("code")
          .eq("id", payload.department_id)
          .maybeSingle();
        if (dept.error) {
          return NextResponse.json({ success: false, error: dept.error.message }, { status: 500 });
        }
        if (!dept.data?.code) {
          return NextResponse.json({ success: false, error: "Invalid department." }, { status: 400 });
        }
        nextDepartmentCode = String(dept.data.code);
      }
    }

    const laneUpdatePayload: Record<string, unknown> = {};
    if (payload.display_name !== undefined) laneUpdatePayload.display_name = nextName;
    if (payload.nickname !== undefined) laneUpdatePayload.nickname = payload.nickname?.trim() || null;
    if (payload.is_active !== undefined) laneUpdatePayload.is_active = payload.is_active;
    if (payload.hk_lane_enabled !== undefined) laneUpdatePayload.hk_lane_enabled = payload.hk_lane_enabled;
    if (payload.hk_lane_order !== undefined) laneUpdatePayload.hk_lane_order = payload.hk_lane_order;
    if (payload.department_id !== undefined) laneUpdatePayload.department_code = nextDepartmentCode;

    const updatedLane = await supabase
      .from("hk_staff_lanes")
      .update(laneUpdatePayload)
      .eq("id", staffId)
      .select("id, display_name, nickname, department_code, is_active, hk_lane_enabled, hk_lane_order")
      .maybeSingle();
    if (updatedLane.error) {
      return NextResponse.json({ success: false, error: updatedLane.error.message }, { status: 500 });
    }

    const sync = await syncRenamedAssignments(supabase, currentName, nextName);
    const dept = await supabase
      .from("departments")
      .select("id, code, name")
      .eq("code", nextDepartmentCode)
      .maybeSingle();
    if (dept.error) {
      return NextResponse.json({ success: false, error: dept.error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      data: updatedLane.data
        ? {
            id: String(updatedLane.data.id),
            employee_code: `LANE-${String(updatedLane.data.id).slice(0, 8).toUpperCase()}`,
            display_name: String(updatedLane.data.display_name),
            nickname: updatedLane.data.nickname ? String(updatedLane.data.nickname) : null,
            department_id: dept.data?.id ? String(dept.data.id) : null,
            is_active: Boolean(updatedLane.data.is_active),
            hk_lane_enabled: Boolean(updatedLane.data.hk_lane_enabled),
            hk_lane_order: Number(updatedLane.data.hk_lane_order ?? 100),
            department: dept.data
              ? {
                  id: String(dept.data.id),
                  code: String(dept.data.code),
                  name: String(dept.data.name),
                }
              : null,
            source: "lane",
            can_bind_line: false,
          }
        : null,
      sync,
    });
  } catch (err) {
    console.error("api/staff/[id] PATCH failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
