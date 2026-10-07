import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireStaffAuth } from "@/lib/server-auth";
import type { UserRole } from "@/lib/types";
import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const bodySchema = z.object({
  email: z.string().trim().email().max(254),
  display_name: z.string().trim().min(1).max(120),
  nickname: z.string().trim().max(120).nullable().optional(),
  role: z.enum(["admin", "frontdesk", "maid", "supervisor", "mobile", "owner"]).optional().default("frontdesk"),
  department_code: z.enum(["FO", "HK", "MNT", "FB", "SEC"]).optional(),
  is_active: z.boolean().optional().default(true),
  hk_lane_enabled: z.boolean().optional().default(false),
  hk_lane_order: z.coerce.number().int().min(1).max(999).optional().default(100),
});

function roleToDepartmentCode(role: "admin" | "frontdesk" | "maid" | "supervisor" | "mobile" | "owner") {
  if (role === "maid") return "HK";
  return "FO";
}

function toEmployeeCode(userId: string): string {
  return `TMP-${String(userId).slice(0, 8).toUpperCase()}`;
}

async function findAuthUserByEmail(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  email: string
): Promise<{ id: string; email: string | null } | null> {
  const target = email.toLowerCase();
  let page = 1;
  const perPage = 200;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(error.message);
    const users = data.users ?? [];
    const found = users.find((u) => String(u.email ?? "").toLowerCase() === target);
    if (found) {
      return { id: String(found.id), email: found.email ?? null };
    }
    if (users.length < perPage) break;
    page += 1;
    if (page > 20) break;
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    // Staff invite is a management action: admin or supervisor only.
    // A supervisor may only invite operational staff; assigning an elevated role
    // (admin/supervisor/owner) requires admin (enforced below). The first admin on a
    // fresh deployment is seeded out-of-band (Supabase), not via this open route.
    const auth = await requireStaffAuth(supabase, request, { allowRoles: ["admin", "supervisor"] });
    if (auth.error) return auth.error;

    const json = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const payload = parsed.data;

    // Privilege-escalation guard: only an admin may grant an elevated role.
    // (Without this, a supervisor — who passes the gate above — could mint admin/owner.)
    const ELEVATED_ROLES: readonly UserRole[] = ["admin", "supervisor", "owner"];
    if (ELEVATED_ROLES.includes(payload.role) && auth.role !== "admin") {
      return NextResponse.json(
        { success: false, error: "Only an admin can assign an elevated role." },
        { status: 403 }
      );
    }

    const email = payload.email.trim().toLowerCase();
    const displayName = payload.display_name.trim();
    const departmentCode = payload.department_code ?? roleToDepartmentCode(payload.role);

    const { data: deptRow, error: deptError } = await supabase
      .from("departments")
      .select("id, code, name")
      .eq("code", departmentCode)
      .maybeSingle();
    if (deptError) {
      return NextResponse.json({ success: false, error: deptError.message }, { status: 500 });
    }
    if (!deptRow) {
      return NextResponse.json(
        { success: false, error: `Department ${departmentCode} not found.` },
        { status: 400 }
      );
    }

    let authUserId: string | null = null;
    let createdNewUser = false;

    const existingAuthUser = await findAuthUserByEmail(supabase, email);
    if (existingAuthUser) {
      authUserId = existingAuthUser.id;
      const { error: updateUserError } = await supabase.auth.admin.updateUserById(authUserId, {
        email,
        user_metadata: {
          full_name: displayName,
        },
      });
      if (updateUserError) {
        return NextResponse.json({ success: false, error: updateUserError.message }, { status: 500 });
      }
    } else {
      const tempPassword = `Tmp#${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const { data: createdUser, error: createUserError } = await supabase.auth.admin.createUser({
        email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: {
          full_name: displayName,
        },
      });
      if (createUserError) {
        return NextResponse.json({ success: false, error: createUserError.message }, { status: 500 });
      }
      authUserId = createdUser.user?.id ?? null;
      createdNewUser = true;
    }

    if (!authUserId) {
      return NextResponse.json({ success: false, error: "Failed to allocate auth user id." }, { status: 500 });
    }

    const { error: profileError } = await supabase.from("profiles").upsert(
      {
        user_id: authUserId,
        role: payload.role,
        full_name: displayName,
        is_active: payload.is_active,
      },
      { onConflict: "user_id" }
    );
    if (profileError) {
      return NextResponse.json({ success: false, error: profileError.message }, { status: 500 });
    }

    const { data: staffRow, error: staffError } = await supabase
      .from("staff")
      .upsert(
        {
          id: authUserId,
          employee_code: toEmployeeCode(authUserId),
          display_name: displayName,
          nickname: payload.nickname?.trim() || null,
          department_id: deptRow.id,
          is_active: payload.is_active,
          hk_lane_enabled: payload.hk_lane_enabled,
          hk_lane_order: payload.hk_lane_order,
        },
        { onConflict: "id" }
      )
      .select("id, employee_code, display_name, nickname, department_id, is_active, hk_lane_enabled, hk_lane_order")
      .maybeSingle();

    if (staffError) {
      return NextResponse.json({ success: false, error: staffError.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      data: staffRow
        ? {
            id: String(staffRow.id),
            employee_code: String(staffRow.employee_code),
            display_name: String(staffRow.display_name),
            nickname: staffRow.nickname ? String(staffRow.nickname) : null,
            department_id: staffRow.department_id ? String(staffRow.department_id) : null,
            is_active: Boolean(staffRow.is_active),
            hk_lane_enabled: Boolean(staffRow.hk_lane_enabled),
            hk_lane_order: Number(staffRow.hk_lane_order ?? 100),
            department: {
              id: String(deptRow.id),
              code: String(deptRow.code),
              name: String(deptRow.name),
            },
            source: "staff" as const,
            can_bind_line: true,
          }
        : null,
      meta: {
        created_new_auth_user: createdNewUser,
      },
    });
  } catch (err) {
    console.error("api/staff/invite POST failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
