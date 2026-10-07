import {
  filterAuditRowsByGroup,
  isValidDateString,
  normalizeAuditSource,
  toBangkokDateString,
} from "@/lib/audit-utils";
import { buildQuotedIlikeOrFilter } from "@/lib/postgrest-escape";
import { assertAdminOrSupervisor, getAuthenticatedUser } from "@/lib/server-auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SCAN_ROWS = 10000;
const AUDIT_ROW_SELECT =
  "id, actor_user_id, action, entity_type, entity_id, before_json, after_json, source, note, business_date, created_at, profiles:actor_user_id(full_name)";
const AUDIT_METADATA_SELECT = "actor_user_id, action, entity_type, profiles:actor_user_id(full_name)";

const querySchema = z.object({
  date_from: z.string().regex(DATE_RE, "date_from must be YYYY-MM-DD").optional(),
  date_to: z.string().regex(DATE_RE, "date_to must be YYYY-MM-DD").optional(),
  entity_type: z.string().trim().min(1).max(120).optional(),
  action: z.string().trim().min(1).max(120).optional(),
  actor_user_id: z.string().regex(UUID_RE, "actor_user_id must be UUID").optional(),
  search: z.string().trim().max(200).optional(),
  group: z.enum(["reservation", "payment", "housekeeping", "night_audit", "staff", "configuration"]).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(200).optional().default(50),
});

type AuditRow = {
  id: string;
  actor_user_id: string | null;
  actor_name: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_json: unknown;
  after_json: unknown;
  source: "manual" | "system" | "api" | "night_audit";
  note: string | null;
  business_date: string;
  created_at: string;
};

type AuditFilterSourceRow = Pick<AuditRow, "actor_user_id" | "actor_name" | "action" | "entity_type">;

async function requireAuditAccess(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  request: NextRequest
) {
  const user = await getAuthenticatedUser(supabase, request);
  if (!user) {
    return {
      ok: false as const,
      response: NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 }),
    };
  }

  try {
    await assertAdminOrSupervisor(supabase, user.id);
  } catch (guardError) {
    const message = guardError instanceof Error ? guardError.message : "Forbidden";
    const status = message === "Forbidden" ? 403 : 500;
    return {
      ok: false as const,
      response: NextResponse.json({ success: false, error: message }, { status }),
    };
  }

  return { ok: true as const, user };
}

function getActorName(raw: unknown, hasActorUserId: boolean): string {
  const profile = Array.isArray(raw) ? raw[0] : raw;
  const name = String((profile as { full_name?: string | null } | null)?.full_name ?? "").trim();
  if (name) return name;
  // actor_user_id exists but full_name is empty → real user with no name set
  // actor_user_id is null → system/trigger action
  return hasActorUserId ? "User (unnamed)" : "System";
}

function toBusinessDateOrFallback(value: unknown, createdAt: string): string {
  if (isValidDateString(value)) return value;
  const parsed = new Date(createdAt);
  if (!Number.isNaN(parsed.getTime())) return toBangkokDateString(parsed);
  return toBangkokDateString();
}

function shapeAuditRows(rows: any[]): AuditRow[] {
  return rows.map((row) => {
    const createdAt = String(row.created_at ?? "");
    return {
      id: String(row.id),
      actor_user_id: row.actor_user_id ? String(row.actor_user_id) : null,
      actor_name: getActorName(row.profiles, Boolean(row.actor_user_id)),
      action: String(row.action ?? ""),
      entity_type: String(row.entity_type ?? ""),
      entity_id: String(row.entity_id ?? ""),
      before_json: row.before_json ?? null,
      after_json: row.after_json ?? null,
      source: normalizeAuditSource(row.source ? String(row.source) : null),
      note: row.note ? String(row.note) : null,
      business_date: toBusinessDateOrFallback(row.business_date, createdAt),
      created_at: createdAt,
    };
  });
}

function shapeAuditMetadataRows(rows: any[]): AuditFilterSourceRow[] {
  return rows.map((row) => ({
    actor_user_id: row.actor_user_id ? String(row.actor_user_id) : null,
    actor_name: getActorName(row.profiles, Boolean(row.actor_user_id)),
    action: String(row.action ?? ""),
    entity_type: String(row.entity_type ?? ""),
  }));
}

export async function GET(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const auth = await requireAuditAccess(supabase, request);
    if (!auth.ok) return auth.response;

    const parsed = querySchema.safeParse({
      date_from: request.nextUrl.searchParams.get("date_from") ?? undefined,
      date_to: request.nextUrl.searchParams.get("date_to") ?? undefined,
      entity_type: request.nextUrl.searchParams.get("entity_type") ?? undefined,
      action: request.nextUrl.searchParams.get("action") ?? undefined,
      actor_user_id: request.nextUrl.searchParams.get("actor_user_id") ?? undefined,
      search: request.nextUrl.searchParams.get("search") ?? undefined,
      group: request.nextUrl.searchParams.get("group") ?? undefined,
      page: request.nextUrl.searchParams.get("page") ?? undefined,
      per_page: request.nextUrl.searchParams.get("per_page") ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid query.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const queryData = parsed.data;
    const dateFrom = queryData.date_from ?? toBangkokDateString();
    const dateTo = queryData.date_to ?? toBangkokDateString();
    if (dateFrom > dateTo) {
      return NextResponse.json(
        { success: false, error: "date_from must be <= date_to." },
        { status: 400 }
      );
    }

    const buildBaseQuery = (selectColumns = AUDIT_ROW_SELECT) => {
      let query = supabase
        .from("audit_logs")
        .select(selectColumns)
        .gte("business_date", dateFrom)
        .lte("business_date", dateTo)
        .order("created_at", { ascending: false });

      if (queryData.entity_type) query = query.eq("entity_type", queryData.entity_type);
      if (queryData.action) query = query.eq("action", queryData.action);
      if (queryData.actor_user_id) query = query.eq("actor_user_id", queryData.actor_user_id);

      return query;
    };

    const rawSearch = (queryData.search ?? "").trim();
    const hasSearch = rawSearch.length > 0;
    let rowsQuery = buildBaseQuery();
    if (hasSearch) {
      rowsQuery = rowsQuery.or(buildQuotedIlikeOrFilter(["entity_id", "action", "note"], rawSearch));
    }

    const { data, error } = await rowsQuery.limit(MAX_SCAN_ROWS);
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    const shaped = shapeAuditRows((data ?? []) as any[]);
    const grouped = filterAuditRowsByGroup(shaped, queryData.group);

    const total = grouped.length;
    const page = queryData.page;
    const perPage = queryData.per_page;
    const offset = (page - 1) * perPage;
    const pageRows = grouped.slice(offset, offset + perPage);
    const totalPages = total > 0 ? Math.ceil(total / perPage) : 0;

    let filterSourceRows: AuditFilterSourceRow[] = grouped;
    if (page === 1 && hasSearch) {
      const { data: metaData, error: metaError } = await buildBaseQuery(AUDIT_METADATA_SELECT).limit(MAX_SCAN_ROWS);
      if (metaError) {
        return NextResponse.json({ success: false, error: metaError.message }, { status: 500 });
      }

      filterSourceRows = filterAuditRowsByGroup(
        shapeAuditMetadataRows((metaData ?? []) as any[]),
        queryData.group
      );
    }

    const filters =
      page === 1
        ? {
            available_actions: Array.from(new Set(filterSourceRows.map((row) => row.action)))
              .filter(Boolean)
              .sort((a, b) => a.localeCompare(b)),
            available_entity_types: Array.from(new Set(filterSourceRows.map((row) => row.entity_type)))
              .filter(Boolean)
              .sort((a, b) => a.localeCompare(b)),
            available_actors: Array.from(
              filterSourceRows.reduce((acc, row) => {
                if (!row.actor_user_id) return acc;
                if (!acc.has(row.actor_user_id)) {
                  acc.set(row.actor_user_id, {
                    user_id: row.actor_user_id,
                    display_name: row.actor_name,
                  });
                }
                return acc;
              }, new Map<string, { user_id: string; display_name: string }>())
            )
              .map(([, value]) => value)
              .sort((a, b) => a.display_name.localeCompare(b.display_name)),
          }
        : undefined;

    return NextResponse.json({
      success: true,
      data: pageRows,
      pagination: {
        page,
        per_page: perPage,
        total,
        total_pages: totalPages,
      },
      ...(filters ? { filters } : {}),
    });
  } catch (err) {
    console.error("api/audit GET failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
