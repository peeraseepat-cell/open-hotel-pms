import { normalizeAuditSource, toBangkokDateString } from "@/lib/audit-utils";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getAuthenticatedUser, requireStaffAuth } from "@/lib/server-auth";
import { syncStaffFromProfiles } from "@/lib/staff-sync";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const FALLBACK_MAIDS = ["Jan", "Tan", "Others"];

const querySchema = z.object({
  department_id: z.string().uuid().optional(),
  department_code: z.enum(["FO", "HK", "MNT", "FB", "SEC"]).optional(),
  is_active: z.enum(["true", "false"]).optional().default("true"),
  hk_lane_enabled: z.enum(["true", "false"]).optional(),
});

const createSchema = z.object({
  display_name: z.string().trim().min(1).max(120),
  nickname: z.string().trim().max(120).nullable().optional(),
  department_code: z.enum(["FO", "HK", "MNT", "FB", "SEC"]).optional().default("HK"),
  is_active: z.boolean().optional().default(true),
  hk_lane_enabled: z.boolean().optional().default(true),
  hk_lane_order: z.coerce.number().int().min(1).max(999).optional().default(100),
});

type DepartmentRow = { id: string; code: string; name: string };

type UnifiedStaffItem = {
  id: string;
  employee_code: string;
  display_name: string;
  nickname: string | null;
  department_id: string | null;
  department: { id: string; code: string; name: string } | null;
  is_active: boolean;
  hk_lane_enabled: boolean;
  hk_lane_order: number;
  source: "staff" | "lane";
  can_bind_line: boolean;
};

function roleToCode(role: string | null | undefined): "FO" | "HK" | "MNT" | "FB" | "SEC" {
  const v = String(role ?? "").toLowerCase();
  if (v === "maid") return "HK";
  return "FO";
}

function mapDepartmentRelation(relation: unknown): { id: string; code: string; name: string } | null {
  const picked = Array.isArray(relation) ? relation[0] : relation;
  if (!picked || typeof picked !== "object") return null;
  const row = picked as { id?: string; code?: string; name?: string };
  if (!row.id || !row.code || !row.name) return null;
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
  };
}

async function loadDepartments(supabase: ReturnType<typeof createServerSupabaseClient>) {
  const { data, error } = await supabase.from("departments").select("id, code, name");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as DepartmentRow[];
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const byCode = new Map(rows.map((row) => [String(row.code), row]));
  return { byId, byCode };
}

async function loadAuthStaffRows(params: {
  supabase: ReturnType<typeof createServerSupabaseClient>;
  isActive: boolean;
  departmentId?: string;
  hkLaneEnabled?: boolean;
}): Promise<{ rows: Array<Record<string, unknown>>; laneColumnsAvailable: boolean }> {
  const { supabase, isActive, departmentId, hkLaneEnabled } = params;

  const run = async (withLaneColumns: boolean) => {
    let query = supabase
      .from("staff")
      .select(
        withLaneColumns
          ? `
          id,
          employee_code,
          display_name,
          nickname,
          department_id,
          is_active,
          hk_lane_enabled,
          hk_lane_order,
          department:departments(id,code,name)
        `
          : `
          id,
          employee_code,
          display_name,
          nickname,
          department_id,
          is_active,
          department:departments(id,code,name)
        `
      )
      .eq("is_active", isActive)
      .order("display_name", { ascending: true });

    if (departmentId) query = query.eq("department_id", departmentId);
    if (withLaneColumns && hkLaneEnabled !== undefined) query = query.eq("hk_lane_enabled", hkLaneEnabled);

    return query;
  };

  let { data, error } = await run(true);
  if (error) {
    const lower = String(error.message ?? "").toLowerCase();
    const missingLaneColumn = lower.includes("hk_lane_enabled") || lower.includes("hk_lane_order");
    if (!missingLaneColumn) throw new Error(error.message);
    const fallback = await run(false);
    if (fallback.error) throw new Error(fallback.error.message);
    return { rows: ((fallback.data ?? []) as unknown as Array<Record<string, unknown>>), laneColumnsAvailable: false };
  }
  return { rows: ((data ?? []) as unknown as Array<Record<string, unknown>>), laneColumnsAvailable: true };
}

async function loadLaneRows(params: {
  supabase: ReturnType<typeof createServerSupabaseClient>;
  isActive: boolean;
  departmentCode?: string;
  hkLaneEnabled?: boolean;
}): Promise<{ rows: Array<Record<string, unknown>>; tableAvailable: boolean }> {
  const { supabase, isActive, departmentCode, hkLaneEnabled } = params;

  let query = supabase
    .from("hk_staff_lanes")
    .select("id, display_name, nickname, department_code, is_active, hk_lane_enabled, hk_lane_order")
    .eq("is_active", isActive)
    .order("hk_lane_order", { ascending: true })
    .order("display_name", { ascending: true });

  if (departmentCode) query = query.eq("department_code", departmentCode);
  if (hkLaneEnabled !== undefined) query = query.eq("hk_lane_enabled", hkLaneEnabled);

  const { data, error } = await query;
  if (error) {
    const lower = String(error.message ?? "").toLowerCase();
    const tableMissing = lower.includes("hk_staff_lanes") || lower.includes("does not exist");
    if (tableMissing) return { rows: [], tableAvailable: false };
    throw new Error(error.message);
  }
  return { rows: ((data ?? []) as unknown as Array<Record<string, unknown>>), tableAvailable: true };
}

function dedupeById(items: UnifiedStaffItem[]): UnifiedStaffItem[] {
  const seen = new Set<string>();
  const out: UnifiedStaffItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function dedupeByDisplayNamePreferStaff(items: UnifiedStaffItem[]): UnifiedStaffItem[] {
  const byName = new Map<string, UnifiedStaffItem>();
  for (const item of items) {
    const key = item.display_name.trim().toLowerCase();
    if (!key) continue;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, item);
      continue;
    }
    if (existing.source === "lane" && item.source === "staff") {
      byName.set(key, item);
    }
  }
  return Array.from(byName.values());
}

export async function GET(request: NextRequest) {
  try {
    const parsed = querySchema.safeParse({
      department_id: request.nextUrl.searchParams.get("department_id") ?? undefined,
      department_code: request.nextUrl.searchParams.get("department_code") ?? undefined,
      is_active: request.nextUrl.searchParams.get("is_active") ?? undefined,
      hk_lane_enabled: request.nextUrl.searchParams.get("hk_lane_enabled") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid query.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = createServerSupabaseClient();
    const user = await getAuthenticatedUser(supabase, request);
    // Legacy PMS mode
    void user;

    try {
      await syncStaffFromProfiles(supabase);
    } catch (syncError) {
      console.error("api/staff syncStaffFromProfiles failed", syncError);
    }

    const isActive = parsed.data.is_active === "true";
    const hkLaneEnabled = parsed.data.hk_lane_enabled
      ? parsed.data.hk_lane_enabled === "true"
      : undefined;

    const { byId: deptById, byCode: deptByCode } = await loadDepartments(supabase);

    let targetDepartmentId = parsed.data.department_id;
    let targetDepartmentCode = parsed.data.department_code;
    if (targetDepartmentCode && !targetDepartmentId) {
      const row = deptByCode.get(targetDepartmentCode);
      targetDepartmentId = row?.id;
    }
    if (targetDepartmentId && !targetDepartmentCode) {
      targetDepartmentCode = deptById.get(targetDepartmentId)?.code as
        | "FO"
        | "HK"
        | "MNT"
        | "FB"
        | "SEC"
        | undefined;
    }

    if (parsed.data.department_code && !targetDepartmentId) {
      return NextResponse.json({ success: true, data: [] });
    }

    const { rows: authRows, laneColumnsAvailable } = await loadAuthStaffRows({
      supabase,
      isActive,
      departmentId: targetDepartmentId,
      hkLaneEnabled,
    });

    const { rows: laneRows } = await loadLaneRows({
      supabase,
      isActive,
      departmentCode: targetDepartmentCode,
      hkLaneEnabled,
    });

    const authItems: UnifiedStaffItem[] = authRows.map((row) => {
      const relation = mapDepartmentRelation(row.department);
      return {
        id: String(row.id),
        employee_code: String(row.employee_code),
        display_name: String(row.display_name ?? "").trim() || "Unknown",
        nickname: row.nickname ? String(row.nickname) : null,
        department_id: row.department_id ? String(row.department_id) : null,
        department: relation,
        is_active: Boolean(row.is_active),
        hk_lane_enabled: laneColumnsAvailable ? Boolean(row.hk_lane_enabled) : false,
        hk_lane_order: laneColumnsAvailable ? Number(row.hk_lane_order ?? 100) : 100,
        source: "staff",
        can_bind_line: true,
      };
    });

    const laneItems: UnifiedStaffItem[] = laneRows.map((row) => {
      const code = String(row.department_code ?? "HK");
      const dept = deptByCode.get(code) ?? null;
      return {
        id: String(row.id),
        employee_code: `LANE-${String(row.id).slice(0, 8).toUpperCase()}`,
        display_name: String(row.display_name ?? "").trim() || "Unknown",
        nickname: row.nickname ? String(row.nickname) : null,
        department_id: dept?.id ?? null,
        department: dept
          ? {
              id: String(dept.id),
              code: String(dept.code),
              name: String(dept.name),
            }
          : null,
        is_active: Boolean(row.is_active ?? true),
        hk_lane_enabled: Boolean(row.hk_lane_enabled ?? true),
        hk_lane_order: Number(row.hk_lane_order ?? 100),
        source: "lane",
        can_bind_line: false,
      };
    });

    let profileItems: UnifiedStaffItem[] = [];
    // Keep this fallback active when no auth-linked staff rows exist yet,
    // even if manual lanes are present, so Team page can still show real Staff cards.
    if (isActive && authItems.length === 0) {
      const { data: profilesRows, error: profilesError } = await supabase
        .from("profiles")
        .select("user_id, full_name, role")
        .order("full_name", { ascending: true });
      if (profilesError) throw new Error(profilesError.message);

      profileItems = (profilesRows ?? []).map((row) => {
        const code = roleToCode((row as { role?: string | null }).role);
        const dept = deptByCode.get(code) ?? null;
        const fullName = String((row as { full_name?: string | null }).full_name ?? "").trim();
        return {
          id: String((row as { user_id: string }).user_id),
          employee_code: `TMP-${String((row as { user_id: string }).user_id).slice(0, 8).toUpperCase()}`,
          display_name: fullName.length > 0 ? fullName : "Unknown",
          nickname: null,
          department_id: dept?.id ?? null,
          department: dept
            ? {
                id: String(dept.id),
                code: String(dept.code),
                name: String(dept.name),
              }
            : null,
          is_active: true,
          hk_lane_enabled: code === "HK",
          hk_lane_order: 100,
          source: "staff",
          can_bind_line: true,
        };
      });
    }

    let items = dedupeById([...authItems, ...profileItems, ...laneItems]);
    items = dedupeByDisplayNamePreferStaff(items).sort((a, b) =>
      a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base", numeric: true })
    );

    if (items.length === 0) {
      items = FALLBACK_MAIDS.map((name, idx) => ({
        id: `fallback-${idx + 1}`,
        employee_code: `LANE-00${idx + 1}`,
        display_name: name,
        nickname: null,
        department_id: deptByCode.get("HK")?.id ?? null,
        department: deptByCode.get("HK")
          ? {
              id: String(deptByCode.get("HK")?.id ?? ""),
              code: "HK",
              name: String(deptByCode.get("HK")?.name ?? "Housekeeping"),
            }
          : null,
        is_active: true,
        hk_lane_enabled: true,
        hk_lane_order: idx + 1,
        source: "lane" as const,
        can_bind_line: false,
      }));
    }

    return NextResponse.json({ success: true, data: items });
  } catch (err) {
    console.error("api/staff GET failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    // Creating a manual staff/lane member is a management mutation: gate to admin/supervisor,
    // matching /api/staff/invite. (GET above stays open — the staff list is read everywhere.)
    const auth = await requireStaffAuth(supabase, request, { allowRoles: ["admin", "supervisor"] });
    if (auth.error) return auth.error;
    const user = auth.user;

    const json = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const payload = parsed.data;
    const displayName = payload.display_name.trim();

    const duplicateStaff = await supabase
      .from("staff")
      .select("id")
      .ilike("display_name", displayName)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (duplicateStaff.error) throw new Error(duplicateStaff.error.message);
    if (duplicateStaff.data) {
      return NextResponse.json(
        { success: false, error: `Staff name "${displayName}" already exists.` },
        { status: 409 }
      );
    }

    const duplicateLane = await supabase
      .from("hk_staff_lanes")
      .select("id")
      .ilike("display_name", displayName)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (duplicateLane.error) {
      const lower = String(duplicateLane.error.message ?? "").toLowerCase();
      if (lower.includes("hk_staff_lanes") || lower.includes("does not exist")) {
        return NextResponse.json(
          {
            success: false,
            error:
              "DB migration required: apply 20260305_phase12b_hk_staff_lanes.sql before creating manual staff.",
          },
          { status: 500 }
        );
      }
      throw new Error(duplicateLane.error.message);
    }
    if (duplicateLane.data) {
      return NextResponse.json(
        { success: false, error: `Staff name "${displayName}" already exists.` },
        { status: 409 }
      );
    }

    const { data: created, error: createError } = await supabase
      .from("hk_staff_lanes")
      .insert({
        display_name: displayName,
        nickname: payload.nickname?.trim() || null,
        department_code: payload.department_code,
        is_active: payload.is_active,
        hk_lane_enabled: payload.hk_lane_enabled,
        hk_lane_order: payload.hk_lane_order,
      })
      .select("id, display_name, nickname, department_code, is_active, hk_lane_enabled, hk_lane_order")
      .maybeSingle();

    if (createError) throw new Error(createError.message);
    if (!created) throw new Error("Failed to create staff.");

    const { byCode: deptByCode } = await loadDepartments(supabase);
    const dept = deptByCode.get(String(created.department_code)) ?? null;

    const item: UnifiedStaffItem = {
      id: String(created.id),
      employee_code: `LANE-${String(created.id).slice(0, 8).toUpperCase()}`,
      display_name: String(created.display_name),
      nickname: created.nickname ? String(created.nickname) : null,
      department_id: dept?.id ?? null,
      department: dept
        ? { id: String(dept.id), code: String(dept.code), name: String(dept.name) }
        : null,
      is_active: Boolean(created.is_active),
      hk_lane_enabled: Boolean(created.hk_lane_enabled),
      hk_lane_order: Number(created.hk_lane_order ?? 100),
      source: "lane",
      can_bind_line: false,
    };

    // Audit log (non-blocking)
    try {
      await supabase.from("audit_logs").insert({
        actor_user_id: user?.id ?? null,
        action: "staff_created",
        entity_type: "staff",
        entity_id: String(created.id),
        after_json: {
          display_name: displayName,
          department_code: payload.department_code,
          hk_lane_enabled: payload.hk_lane_enabled,
        },
        business_date: toBangkokDateString(),
        source: normalizeAuditSource("manual"),
      });
    } catch (auditErr) {
      console.error("Staff create audit log failed:", auditErr);
    }

    return NextResponse.json({ success: true, data: item });
  } catch (err) {
    console.error("api/staff POST failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
