import {
  buildRichBody,
  dedupeMentionInputs,
  extractLogbookInlineRefs,
  getBangkokDateForInstant,
  getBangkokDayWindow,
  getNextLogbookZIndex,
  LOGBOOK_BOARD_MODES,
  HttpError,
  LOGBOOK_MENTION_TYPES,
  LOGBOOK_NOTE_TYPES,
  LOGBOOK_PRIORITIES,
  LOGBOOK_STATUSES,
  LOGBOOK_WINDOW_PRESETS,
  normalizeLogbookLinkInput,
  normalizeLogbookMentionInput,
  resolveLogbookWindow,
  resolveLogbookActorStaffId,
} from "@/lib/logbook-api";
import { hydrateLogbookNotes, LOGBOOK_NOTE_SELECT, LogbookNoteRow } from "@/lib/logbook-query";
import { buildQuotedIlikeOrFilter } from "@/lib/postgrest-escape";
import { requireStaffAuth } from "@/lib/server-auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const booleanQueryParam = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "yes") return true;
    if (normalized === "0" || normalized === "no") return false;
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return value;
}, z.boolean().optional());

const querySchema = z.object({
  date: z.string().regex(dateRegex, "date must be YYYY-MM-DD").optional(),
  range_start: z.string().regex(dateRegex, "range_start must be YYYY-MM-DD").optional(),
  range_end: z.string().regex(dateRegex, "range_end must be YYYY-MM-DD").optional(),
  range_mode: z.enum(["board", "calendar"]).optional().default("board"),
  all_active: booleanQueryParam.default(false),
  past: booleanQueryParam.default(false),
  type: z.string().optional(),
  staff_id: z.string().uuid().optional(),
  status: z.enum(LOGBOOK_STATUSES).optional(),
  archived: booleanQueryParam.default(false),
  q: z.string().trim().max(160).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const createLinkSchema = z.object({
  link_type: z.enum(["room", "guest", "stock", "staff"]),
  ref_id: z.string().uuid().optional().nullable(),
  ref_code: z.string().trim().max(120).optional().nullable(),
  room_link_mode: z.enum(["static", "dynamic"]).optional().nullable(),
  label: z.string().trim().max(160).optional().nullable(),
});

const createMentionSchema = z.object({
  mention_type: z.enum(LOGBOOK_MENTION_TYPES),
  staff_id: z.string().uuid().optional().nullable(),
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(10000).optional().default(""),
  body_rich: z.record(z.string(), z.any()).nullable().optional(),
  note_type: z.enum(LOGBOOK_NOTE_TYPES).optional().default("general"),
  status: z.enum(LOGBOOK_STATUSES).optional().default("open"),
  priority: z.enum(LOGBOOK_PRIORITIES).optional().default("normal"),
  remind_at: z.string().datetime().optional().nullable(),
  start_at: z.string().datetime().optional().nullable(),
  end_at: z.string().datetime().optional().nullable(),
  preset: z.enum(LOGBOOK_WINDOW_PRESETS).optional(),
  x: z.coerce.number().int().min(-10000).max(10000).optional(),
  y: z.coerce.number().int().min(-10000).max(10000).optional(),
  width: z.coerce.number().int().min(200).max(1200).optional().default(320),
  height: z.coerce.number().int().min(120).max(1200).optional().default(220),
  z_index: z.coerce.number().int().min(1).max(2000000000).optional(),
  is_minimized: z.boolean().optional().default(false),
  board_mode: z.enum(LOGBOOK_BOARD_MODES).optional(),
  links: z.array(createLinkSchema).optional().default([]),
  mentions: z.array(createMentionSchema).optional().default([]),
});

const PRIORITY_RANK: Record<(typeof LOGBOOK_PRIORITIES)[number], number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

function getInclusiveRangeDays(startDate: string, endDate: string): number {
  const [startYear, startMonth, startDay] = startDate.split("-").map(Number);
  const [endYear, endMonth, endDay] = endDate.split("-").map(Number);
  const startUtc = Date.UTC(startYear, startMonth - 1, startDay);
  const endUtc = Date.UTC(endYear, endMonth - 1, endDay);
  return Math.floor((endUtc - startUtc) / 86_400_000) + 1;
}

function parseTypeList(raw: string | undefined): Array<(typeof LOGBOOK_NOTE_TYPES)[number]> {
  if (!raw) return [];
  const set = new Set<string>();
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (!value) continue;
    set.add(value);
  }

  const list = Array.from(set);
  if (list.length === 0) return [];
  const allowed = new Set<string>(LOGBOOK_NOTE_TYPES);
  for (const value of list) {
    if (!allowed.has(value)) {
      throw new HttpError(400, `Invalid note type filter: ${value}`);
    }
  }
  return list as Array<(typeof LOGBOOK_NOTE_TYPES)[number]>;
}

export async function GET(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const auth = await requireStaffAuth(supabase, request);
    if (auth.error) return auth.error;

    const parsed = querySchema.safeParse({
      date: request.nextUrl.searchParams.get("date") ?? undefined,
      range_start: request.nextUrl.searchParams.get("range_start") ?? undefined,
      range_end: request.nextUrl.searchParams.get("range_end") ?? undefined,
      range_mode: request.nextUrl.searchParams.get("range_mode") ?? undefined,
      all_active: request.nextUrl.searchParams.get("all_active") ?? undefined,
      past: request.nextUrl.searchParams.get("past") ?? undefined,
      type: request.nextUrl.searchParams.get("type") ?? undefined,
      staff_id: request.nextUrl.searchParams.get("staff_id") ?? undefined,
      status: request.nextUrl.searchParams.get("status") ?? undefined,
      archived: request.nextUrl.searchParams.get("archived") ?? undefined,
      q: request.nextUrl.searchParams.get("q") ?? undefined,
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
      offset: request.nextUrl.searchParams.get("offset") ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid query.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { staff_id, status, limit, offset, archived, past, q, range_mode, all_active } = parsed.data;
    const date = parsed.data.date ?? (!parsed.data.range_start && !parsed.data.range_end && !past && !archived && !all_active
      ? getBangkokDateForInstant(new Date())
      : undefined);
    const rangeStart = parsed.data.range_start;
    const rangeEnd = parsed.data.range_end;
    if ((rangeStart && !rangeEnd) || (!rangeStart && rangeEnd)) {
      throw new HttpError(400, "range_start and range_end must be supplied together.");
    }
    if (rangeStart && rangeEnd && rangeStart > rangeEnd) {
      throw new HttpError(400, "range_start must be before or equal to range_end.");
    }
    const rangeDays = rangeStart && rangeEnd ? getInclusiveRangeDays(rangeStart, rangeEnd) : 0;
    if (rangeDays > 7 && range_mode !== "calendar") {
      throw new HttpError(400, "Logbook range filters are limited to 7 days.");
    }
    if (rangeDays > 120) {
      throw new HttpError(400, "Logbook calendar range is limited to 120 days.");
    }
    const typeList = parseTypeList(parsed.data.type);

    let query = supabase
      .from("logbook_notes")
      .select(LOGBOOK_NOTE_SELECT, { count: "exact" })
      .range(offset, offset + limit - 1);

    if (archived) {
      query = query.not("archived_at", "is", null);
    } else if (past) {
      const nowIso = new Date().toISOString();
      query = query
        .is("archived_at", null)
        .or(`end_at.lt.${nowIso},and(end_at.is.null,closed_at.not.is.null)`);
    } else if (range_mode === "calendar") {
      // Calendar is a timeline/history surface: include active, closed, and archived notes.
    } else {
      const nowIso = new Date().toISOString();
      query = query
        .is("archived_at", null)
        .or(`end_at.is.null,end_at.gte.${nowIso}`);
    }
    if (status) query = query.eq("status", status);
    if (staff_id) query = query.eq("created_by", staff_id);
    if (typeList.length === 1) query = query.eq("note_type", typeList[0]);
    if (typeList.length > 1) query = query.in("note_type", typeList);
    if (q) query = query.or(buildQuotedIlikeOrFilter(["title", "body"], q));
    if (!past && !archived && date) {
      const { from, to } = getBangkokDayWindow(date);
      query = query
        .lt("start_at", to)
        .or(`end_at.is.null,end_at.gte.${from}`);
    }
    if (!past && !archived && rangeStart && rangeEnd) {
      const from = getBangkokDayWindow(rangeStart).from;
      const to = getBangkokDayWindow(rangeEnd).end;
      query = query
        .lte("start_at", to)
        .or(`end_at.is.null,end_at.gte.${from}`);
    }
    query = archived
      ? query.order("archived_at", { ascending: false })
      : query.order("updated_at", { ascending: false });

    const { data, error, count } = await query;
    if (error) throw new HttpError(500, error.message);

    const notes = (await hydrateLogbookNotes(supabase, (data ?? []) as LogbookNoteRow[])).sort((a, b) => {
      if (archived) {
        const aArchivedAt = Date.parse(a.archived_at ?? a.updated_at);
        const bArchivedAt = Date.parse(b.archived_at ?? b.updated_at);
        return bArchivedAt - aArchivedAt;
      }
      const aPriority = PRIORITY_RANK[a.priority] ?? 0;
      const bPriority = PRIORITY_RANK[b.priority] ?? 0;
      if (aPriority !== bPriority) return bPriority - aPriority;
      const aEnd = a.end_at ? Date.parse(a.end_at) : Number.POSITIVE_INFINITY;
      const bEnd = b.end_at ? Date.parse(b.end_at) : Number.POSITIVE_INFINITY;
      if (aEnd !== bEnd) return aEnd - bEnd;
      return Date.parse(b.updated_at) - Date.parse(a.updated_at);
    });

    return NextResponse.json({
      success: true,
      data: notes,
      total: count ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    console.error("api/logbook/notes GET failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const auth = await requireStaffAuth(supabase, request);
    if (auth.error) return auth.error;

    const json = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const payload = parsed.data;
    const richBody = buildRichBody({ body: payload.body ?? "", body_rich: payload.body_rich ?? null });
    const window = resolveLogbookWindow({
      start_at: payload.start_at,
      end_at: payload.end_at,
      preset: payload.preset,
    });

    const actorStaffId = await resolveLogbookActorStaffId(supabase, auth.user.id);

    const zIndex = payload.z_index ?? (await getNextLogbookZIndex(supabase));
    const x = payload.x ?? 40;
    const y = payload.y ?? 40;
    const boardMode = payload.board_mode ?? (payload.is_minimized ? "minimized" : "middle");
    const width = boardMode === "minimized" ? 300 : payload.width;
    const height = boardMode === "minimized" ? 44 : payload.height;

    const { data: inserted, error: insertError } = await supabase
      .from("logbook_notes")
      .insert({
        title: payload.title,
        body: richBody.body,
        body_rich: richBody.body_rich,
        note_type: payload.note_type,
        status: payload.status,
        priority: payload.priority,
        remind_at: payload.remind_at ?? null,
        start_at: window.start_at,
        end_at: window.end_at,
        x,
        y,
        width,
        height,
        z_index: zIndex,
        is_minimized: boardMode === "minimized",
        board_mode: boardMode,
        created_by: actorStaffId,
      })
      .select(LOGBOOK_NOTE_SELECT)
      .maybeSingle();

    if (insertError) throw new HttpError(500, insertError.message);
    if (!inserted) throw new HttpError(500, "Failed to create logbook note.");

    const linkRows = [];
    for (const item of payload.links) {
      linkRows.push(await normalizeLogbookLinkInput(supabase, item));
    }

    const inlineRefs = extractLogbookInlineRefs(payload.body ?? "");
    for (const link of inlineRefs.links) {
      linkRows.push(
        await normalizeLogbookLinkInput(supabase, {
          link_type: link.link_type,
          ref_id: null,
          ref_code: link.ref_code,
          label: link.label,
        })
      );
    }
    const dedupedLinkRows = Array.from(
      new Map(
        linkRows.map((row) => [
          `${row.link_type}:${row.ref_id ?? ""}:${row.ref_code ?? ""}:${row.label}`,
          row,
        ])
      ).values()
    );

    if (dedupedLinkRows.length > 0) {
      const { error: linkInsertError } = await supabase.from("logbook_note_links").insert(
        dedupedLinkRows.map((row) => ({
          note_id: String(inserted.id),
          link_type: row.link_type,
          ref_id: row.ref_id,
          ref_code: row.ref_code,
          room_link_mode: row.room_link_mode ?? "static",
          label: row.label,
        }))
      );
      if (linkInsertError) throw new HttpError(500, linkInsertError.message);
    }

    const normalizedMentions = [];
    for (const mention of payload.mentions) {
      normalizedMentions.push(await normalizeLogbookMentionInput(supabase, mention));
    }
    for (const mention of inlineRefs.mentions) {
      normalizedMentions.push(mention);
    }
    const mentionRows = dedupeMentionInputs(normalizedMentions);

    if (mentionRows.length > 0) {
      const { error: mentionInsertError } = await supabase
        .from("logbook_note_mentions")
        .insert(
          mentionRows.map((row) => ({
            note_id: String(inserted.id),
            mention_type: row.mention_type,
            staff_id: row.staff_id,
          }))
        );
      if (mentionInsertError) throw new HttpError(500, mentionInsertError.message);
    }

    const hydrated = await hydrateLogbookNotes(supabase, [
      inserted as unknown as LogbookNoteRow,
    ]);

    return NextResponse.json({ success: true, data: hydrated[0] ?? null });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    console.error("api/logbook/notes POST failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
