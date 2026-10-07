import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
    mergeLoanCollectionReservationContexts,
    shouldShowLoanCollectionForReservation,
} from "@/lib/hk-loan-collections";
import { filterAlertsForSurface, mapEffectiveReservationAlert, summarizeAlerts } from "@/lib/reservation-alerts";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const statusActionSchema = z.object({
    action: z.literal("status").optional(),
    room_id: z.string().uuid(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    new_status: z.enum(["available", "dirty", "in_progress", "paused", "cleaned", "approved"]),
});

const assignActionSchema = z.object({
    action: z.literal("assign"),
    room_id: z.string().uuid(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    assigned_maid: z.string().trim().min(1),
    priority: z.number().int().min(1).max(9999),
});

const unassignActionSchema = z.object({
    action: z.literal("unassign"),
    room_id: z.string().uuid(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const roomDiaryDirtyActionSchema = z.object({
    action: z.literal("room_diary_mark_dirty"),
    room_id: z.string().uuid(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().trim().max(500).optional().nullable(),
});

const roomDiaryNoServiceActionSchema = z.object({
    action: z.literal("room_diary_mark_no_service"),
    room_id: z.string().uuid(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().trim().max(500).optional().nullable(),
});

type DiaryState = "available" | "due_in" | "inhouse" | "back_to_back" | "due_out";

function computeElapsedMs(
    status: string | null | undefined,
    startedAt: string | null | undefined,
    accumulatedMs: number | null | undefined
): number {
    const base = accumulatedMs ?? 0;
    if (status !== "in_progress" || !startedAt) return base;
    const started = new Date(startedAt).getTime();
    if (Number.isNaN(started)) return base;
    const now = Date.now();
    return base + Math.max(now - started, 0);
}

function shiftDate(dateStr: string, diffDays: number): string {
    const d = new Date(`${dateStr}T12:00:00.000Z`);
    if (Number.isNaN(d.getTime())) return dateStr;
    d.setUTCDate(d.getUTCDate() + diffDays);
    return d.toISOString().slice(0, 10);
}

function getThailandDateString(date = new Date()): string {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (!year || !month || !day) return new Date().toISOString().slice(0, 10);
    return `${year}-${month}-${day}`;
}

function toBangkokWindow(dateString: string): { from: string; to: string } {
    return {
        from: `${dateString}T00:00:00+07:00`,
        to: `${dateString}T24:00:00+07:00`,
    };
}

function isCheckedInAtColumnMissing(message: string | null | undefined): boolean {
    return /checked_in_at/i.test(String(message ?? ""));
}

type CarryForwardTask = {
    id: string;
    room_id: string;
    status: "dirty" | "in_progress" | "paused";
    assigned_maid_name: string | null;
    is_no_service: boolean | null;
    no_service_note?: string | null;
    accumulated_ms: number | null;
    started_at: string | null;
};

type ActiveRoomNightReservation = {
    id: string;
    status: string | null;
    checked_in_at?: string | null;
    parent_reservation_id?: string | null;
};

type LinkedContinuationReservation = ActiveRoomNightReservation & {
    source?: string | null;
    checkin_date?: string | null;
    checkout_date?: string | null;
    checkin_time?: string | null;
    booking_code?: string | null;
    guest_name?: string | null;
};

function unwrapReservationRef(value: unknown): LinkedContinuationReservation | null {
    if (Array.isArray(value)) return (value[0] as LinkedContinuationReservation | undefined) ?? null;
    return (value as LinkedContinuationReservation | null | undefined) ?? null;
}

function getBangkokTimeHHmm(date = new Date()): string {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Bangkok",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
    const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
    return `${hour}:${minute}`;
}

async function hasCheckedInAudit(
    supabase: ReturnType<typeof createServerSupabaseClient>,
    reservationId: string
): Promise<boolean> {
    const { data, error } = await supabase
        .from("audit_logs")
        .select("id")
        .eq("entity_type", "reservation")
        .eq("action", "checked_in")
        .eq("entity_id", reservationId)
        .limit(1)
        .maybeSingle();
    if (error && error.code !== "PGRST116") throw new Error(error.message);
    return Boolean(data);
}

async function maybeActivateLinkedWalkInForRoomDiary(
    supabase: ReturnType<typeof createServerSupabaseClient>,
    roomId: string,
    date: string,
    markAsNoService: boolean
): Promise<{ activated: boolean; childReservationId: string | null; parentReservationId: string | null }> {
    const { data: childNightRows, error: childNightError } = await supabase
        .from("reservation_nights")
        .select(`
            room_id,
            stay_date,
            reservations!reservation_nights_reservation_id_fkey(
                id,
                parent_reservation_id,
                status,
                source,
                checkin_date,
                checkout_date,
                checked_in_at,
                checkin_time,
                booking_code,
                guest_name
            )
        `)
        .eq("stay_date", date)
        .is("cancelled_at", null)
        .eq("room_id", roomId);
    if (childNightError) throw new Error(childNightError.message);

    const childCandidates = ((childNightRows ?? []) as Array<{ reservations?: unknown }>)
        .map((row) => unwrapReservationRef(row.reservations))
        .filter((reservation): reservation is LinkedContinuationReservation => {
            if (!reservation?.id || !reservation.parent_reservation_id) return false;
            if (String(reservation.status ?? "").toLowerCase() !== "active") return false;
            if (String(reservation.source ?? "").toLowerCase() !== "walkin") return false;
            return String(reservation.checkin_date ?? "") === date;
        })
        .sort((left, right) =>
            String(left.checkin_date ?? "").localeCompare(String(right.checkin_date ?? "")) ||
            String(left.id).localeCompare(String(right.id))
        );
    const child = childCandidates[0] ?? null;
    if (!child?.parent_reservation_id) {
        return { activated: false, childReservationId: null, parentReservationId: null };
    }

    const { data: parentRow, error: parentError } = await supabase
        .from("reservations")
        .select("id, parent_reservation_id, status, source, checkin_date, checkout_date, checked_in_at, checkin_time, booking_code, guest_name")
        .eq("id", child.parent_reservation_id)
        .maybeSingle();
    if (parentError) throw new Error(parentError.message);

    const parent = (parentRow as LinkedContinuationReservation | null) ?? null;
    if (!parent?.id) {
        return { activated: false, childReservationId: child.id, parentReservationId: child.parent_reservation_id };
    }
    if (String(parent.source ?? "").toLowerCase() !== "ota" || String(parent.checkout_date ?? "") !== date) {
        return { activated: false, childReservationId: child.id, parentReservationId: parent.id };
    }

    const parentHasCheckedInEvidence = Boolean(parent.checked_in_at) || await hasCheckedInAudit(supabase, parent.id);
    if (!parentHasCheckedInEvidence) {
        return { activated: false, childReservationId: child.id, parentReservationId: parent.id };
    }
    if (child.checked_in_at) {
        return { activated: true, childReservationId: child.id, parentReservationId: parent.id };
    }

    const nowIso = new Date().toISOString();
    const inheritedCheckinAt = child.checked_in_at ?? parent.checked_in_at ?? nowIso;
    const inheritedCheckinTime = child.checkin_time ?? parent.checkin_time ?? getBangkokTimeHHmm();

    const childUpdatePayload: Record<string, unknown> = {
        status: "active",
        updated_at: nowIso,
    };
    if (!child.checked_in_at) childUpdatePayload.checked_in_at = inheritedCheckinAt;
    if (!child.checkin_time) childUpdatePayload.checkin_time = inheritedCheckinTime;
    const { error: childUpdateError } = await supabase.from("reservations").update(childUpdatePayload).eq("id", child.id);
    if (childUpdateError) throw new Error(childUpdateError.message);

    if (!child.checked_in_at && !(await hasCheckedInAudit(supabase, child.id))) {
        await supabase.from("audit_logs").insert({
            action: "checked_in",
            entity_type: "reservation",
            entity_id: child.id,
            after_json: {
                reason: "room_diary_linked_walkin_activation",
                parent_reservation_id: parent.id,
                room_id: roomId,
                business_date: date,
            },
            business_date: date,
        });
    }

    await supabase.from("audit_logs").insert({
        action: "linked_walkin_activated_from_room_diary",
        entity_type: "reservation",
        entity_id: child.id,
        before_json: {
            parent_reservation_id: parent.id,
            parent_status: parent.status,
            child_checked_in_at: child.checked_in_at ?? null,
        },
        after_json: {
            parent_status: parent.status,
            child_status: "active",
            child_checked_in_at: inheritedCheckinAt,
            room_id: roomId,
            hk_action: markAsNoService ? "no_service" : "dirty",
        },
        business_date: date,
    });

    return { activated: true, childReservationId: child.id, parentReservationId: parent.id };
}

async function autoCarryForwardOpenHousekeepingTasks(
    supabase: ReturnType<typeof createServerSupabaseClient>,
    targetDate: string,
    roomIds: string[]
) {
    if (roomIds.length === 0) return;
    if (targetDate !== getThailandDateString()) return;

    const yesterday = shiftDate(targetDate, -1);
    const { data: prevRowsRaw, error: prevError } = await supabase
        .from("housekeeping_tasks")
        .select("id, room_id, status, assigned_maid_name, is_no_service, no_service_note, accumulated_ms, started_at")
        .eq("stay_date", yesterday)
        .in("room_id", roomIds)
        .in("status", ["dirty", "in_progress", "paused"]);
    if (prevError) throw new Error(prevError.message);

    const prevRows = ((prevRowsRaw ?? []) as unknown as CarryForwardTask[]);
    if (prevRows.length === 0) return;

    const prevRoomIds = Array.from(new Set(prevRows.map((row) => row.room_id)));
    const { data: todayRows, error: todayError } = await supabase
        .from("housekeeping_tasks")
        .select("room_id")
        .eq("stay_date", targetDate)
        .in("room_id", prevRoomIds);
    if (todayError) throw new Error(todayError.message);

    const todayRoomSet = new Set((todayRows ?? []).map((row) => String(row.room_id)));
    const nowMs = Date.now();

    for (const prev of prevRows) {
        if (todayRoomSet.has(prev.room_id)) continue;

        const carryStatus: "dirty" | "paused" = prev.status === "dirty" ? "dirty" : "paused";
        let carryAccumulatedMs = Math.max(Number(prev.accumulated_ms ?? 0), 0);
        if (prev.status === "in_progress" && prev.started_at) {
            const startedMs = new Date(prev.started_at).getTime();
            if (!Number.isNaN(startedMs)) {
                carryAccumulatedMs += Math.max(nowMs - startedMs, 0);
            }
        }

        const { error: carryError } = await supabase
            .from("housekeeping_tasks")
            .upsert(
                {
                    room_id: prev.room_id,
                    stay_date: targetDate,
                    task_seq: 1,
                    status: carryStatus,
                    assigned_maid_name: prev.assigned_maid_name ?? null,
                    is_no_service: prev.is_no_service ?? false,
                    no_service_note: prev.no_service_note ?? null,
                    accumulated_ms: carryStatus === "paused" ? carryAccumulatedMs : 0,
                    started_at: null,
                    finished_at: null,
                    approved_at: null,
                },
                { onConflict: "room_id,stay_date,task_seq", ignoreDuplicates: true }
            );
        if (carryError) throw new Error(carryError.message);

        if (prev.status === "in_progress") {
            const { error: normalizePrevError } = await supabase
                .from("housekeeping_tasks")
                .update({
                    status: "paused",
                    started_at: null,
                    accumulated_ms: carryAccumulatedMs,
                })
                .eq("id", prev.id)
                .eq("status", "in_progress");
            if (normalizePrevError) throw new Error(normalizePrevError.message);
        }

        const { data: todayTask, error: todayTaskError } = await supabase
            .from("housekeeping_tasks")
            .select("id")
            .eq("room_id", prev.room_id)
            .eq("stay_date", targetDate)
            .order("task_seq", { ascending: false })
            .limit(1)
            .maybeSingle();
        if (todayTaskError) throw new Error(todayTaskError.message);
        if (todayTask?.id) {
            const note =
                carryStatus === "dirty"
                    ? `Carry-forward from ${yesterday}: dirty not finished`
                    : `Carry-forward from ${yesterday}: ${prev.status} -> paused`;
            const { error: logError } = await supabase.from("housekeeping_logs").insert({
                task_id: todayTask.id,
                status: carryStatus,
                note,
            });
            if (logError) throw new Error(logError.message);
        }
    }
}

async function isRoomInHouseOnDate(
    supabase: ReturnType<typeof createServerSupabaseClient>,
    roomId: string,
    date: string
): Promise<boolean> {
    const nightSelectWithCheckedInAt = `
            reservation_id,
            reservations!reservation_nights_reservation_id_fkey(
                id,
                status,
                checked_in_at,
                parent_reservation_id
            )
            `;
    const nightSelectFallback = `
            reservation_id,
            reservations!reservation_nights_reservation_id_fkey(
                id,
                status,
                parent_reservation_id
            )
            `;

    let includesCheckedInAt = true;
    let nightRows: Array<Record<string, unknown>> = [];

    const withCheckedInAt = await supabase
        .from("reservation_nights")
        .select(nightSelectWithCheckedInAt)
        .eq("stay_date", date)
        .is("cancelled_at", null)
        .eq("room_id", roomId);

    if (withCheckedInAt.error && isCheckedInAtColumnMissing(withCheckedInAt.error.message)) {
        includesCheckedInAt = false;
        const fallback = await supabase
            .from("reservation_nights")
            .select(nightSelectFallback)
            .eq("stay_date", date)
            .is("cancelled_at", null)
            .eq("room_id", roomId);
        if (fallback.error) throw new Error(fallback.error.message);
        nightRows = (fallback.data ?? []) as Array<Record<string, unknown>>;
    } else {
        if (withCheckedInAt.error) throw new Error(withCheckedInAt.error.message);
        nightRows = (withCheckedInAt.data ?? []) as Array<Record<string, unknown>>;
    }

    const activeReservations: ActiveRoomNightReservation[] = [];
    for (const row of nightRows ?? []) {
        const reservationRef = Array.isArray((row as { reservations?: unknown }).reservations)
            ? ((row as { reservations?: Array<ActiveRoomNightReservation> }).reservations ?? [])[0]
            : ((row as { reservations?: ActiveRoomNightReservation | null }).reservations ?? null);
        if (!reservationRef || reservationRef.status !== "active" || !reservationRef.id) continue;
        activeReservations.push({
            id: String(reservationRef.id),
            status: reservationRef.status,
            checked_in_at: includesCheckedInAt ? reservationRef.checked_in_at ?? null : null,
            parent_reservation_id: reservationRef.parent_reservation_id ? String(reservationRef.parent_reservation_id) : null,
        });
    }

    const activeReservationIds = activeReservations.map((row) => row.id);
    if (activeReservationIds.length === 0) return false;
    if (activeReservations.some((row) => row.checked_in_at)) return true;

    const { data: checkedInRows, error: checkedInError } = await supabase
        .from("audit_logs")
        .select("entity_id")
        .eq("entity_type", "reservation")
        .eq("action", "checked_in")
        .in("entity_id", activeReservationIds);
    if (checkedInError) throw new Error(checkedInError.message);

    const checkedInSet = new Set((checkedInRows ?? []).map((row) => String(row.entity_id)));
    if (activeReservationIds.some((id) => checkedInSet.has(id))) return true;

    const linkedRootIds = Array.from(
        new Set(activeReservations.map((row) => row.parent_reservation_id ?? row.id).filter(Boolean))
    );
    if (linkedRootIds.length === 0) return false;

    const { data: linkedRoots, error: linkedRootsError } = await supabase
        .from("reservations")
        .select("id, parent_reservation_id, status, checked_in_at")
        .in("id", linkedRootIds);
    if (linkedRootsError) throw new Error(linkedRootsError.message);

    const { data: linkedChildren, error: linkedChildrenError } = await supabase
        .from("reservations")
        .select("id, parent_reservation_id, status, checked_in_at")
        .in("parent_reservation_id", linkedRootIds);
    if (linkedChildrenError) throw new Error(linkedChildrenError.message);

    const linkedReservations = [
        ...((linkedRoots ?? []) as ActiveRoomNightReservation[]),
        ...((linkedChildren ?? []) as ActiveRoomNightReservation[]),
    ].filter((row) => row.status !== "cancelled" && row.status !== "no_show");
    const linkedReservationIds = Array.from(new Set(linkedReservations.map((row) => row.id).filter(Boolean)));
    if (linkedReservations.some((row) => row.checked_in_at)) return true;
    if (linkedReservationIds.length === 0) return false;

    const { data: linkedCheckedInRows, error: linkedCheckedInError } = await supabase
        .from("audit_logs")
        .select("entity_id")
        .eq("entity_type", "reservation")
        .eq("action", "checked_in")
        .in("entity_id", linkedReservationIds);
    if (linkedCheckedInError) throw new Error(linkedCheckedInError.message);

    const linkedCheckedInSet = new Set((linkedCheckedInRows ?? []).map((row) => String(row.entity_id)));
    return linkedReservationIds.some((id) => linkedCheckedInSet.has(id));
}

type MaintenanceAssignmentRow = {
    assignment_id: string;
    room_id: string;
    task_id: string;
    task_name: string;
    sync_to_housekeeper: boolean | null;
    checklist_items: string[] | null;
    estimated_minutes: number | null;
    notes: string | null;
};

type HkTaskRow = {
    id: string;
    room_id: string;
    stay_date: string;
    status: string;
    started_at: string | null;
    finished_at: string | null;
    approved_at: string | null;
    accumulated_ms: number | null;
    is_no_service: boolean | null;
    assigned_maid_name: string | null;
    no_service_note?: string | null;
};

type HkTaskLogRow = {
    status: string;
    note: string | null;
    created_at: string;
};

function isRoomDiaryServiceRequest(logs: HkTaskLogRow[]): boolean {
    return logs.some((log) => /^Marked (Dirty|No Service) from Room (Diary|Rack)/.test(String(log.note ?? "")));
}

type RecentReservationRow = {
    reservation_id: string;
    status: string | null;
};

type LoanCollectionSummary = {
    item_name: string;
    quantity: number;
    due_date: string | null;
};

type PlannedMoveGuestSummary = {
    reservation_id: string;
    guest_name: string | null;
    checkin_date: string | null;
    checkout_date: string | null;
};

type DepartureOccupancyRow = {
    room_id: string;
    reservation_id: string;
    guest_name: string | null;
    checkin_date: string | null;
    checkout_date: string | null;
    checked_in_at: string | null;
};

function isAutoSplitPlannedMove(row: { move_reason?: string | null }): boolean {
    return String(row.move_reason ?? "").toLowerCase().includes("auto split stay");
}

export async function GET(request: NextRequest) {
    try {
        const supabase = createServerSupabaseClient();
        const sp = request.nextUrl.searchParams;
        const dateParam = sp.get("date") ?? getThailandDateString();

        // Base room metadata for board/timeline rendering
        const { data: rooms, error: roomsErr } = await supabase
            .from("rooms")
            .select(`
        id,
        room_number,
        floor_number,
        wing,
        sort_order,
        is_sellable,
        room_types(name_en, code, cleaning_duration_min)
      `)
            .eq("is_visible_on_board", true)
            .order("floor_number", { ascending: true, nullsFirst: false })
            .order("wing", { ascending: true, nullsFirst: false })
            .order("sort_order", { ascending: true, nullsFirst: false })
            .order("room_number", { ascending: true });

        if (roomsErr) return NextResponse.json({ error: roomsErr.message }, { status: 500 });
        if (!rooms || rooms.length === 0) {
            return NextResponse.json({
                success: true,
                date: dateParam,
                summary: { dirty: 0, cleaning: 0, clean: 0, available: 0, no_service: 0 },
                rooms: [],
            });
        }

        const roomIds = rooms.map((r) => r.id);
        const roomIdSet = new Set(roomIds);

        // Hotfix: auto carry-over unresolved tasks from yesterday into today's board.
        await autoCarryForwardOpenHousekeepingTasks(supabase, dateParam, roomIds);

        // Housekeeping runtime rows for the date
        const hkSelectBase =
            "id, room_id, stay_date, status, started_at, finished_at, approved_at, accumulated_ms, is_no_service, assigned_maid_name";
        let { data: hkRowsRaw, error: hkError } = await supabase
            .from("housekeeping_tasks")
            .select(`${hkSelectBase}, no_service_note`)
            .eq("stay_date", dateParam)
            .in("room_id", roomIds)
            .order("task_seq", { ascending: true }); // ascending so highest seq wins in hkByRoomId map
        if (hkError) {
            const message = String(hkError.message ?? "").toLowerCase();
            if (
                message.includes("no_service_note") ||
                message.includes("no_service_marked_at") ||
                message.includes("no_service_marked_by")
            ) {
                return NextResponse.json(
                    {
                        error:
                            "DB migration required: apply 20260303_phase11_hk_no_service_note.sql before using housekeeping status API.",
                    },
                    { status: 500 }
                );
            }
            return NextResponse.json({ error: hkError.message }, { status: 500 });
        }
        const hkRows = (hkRowsRaw ?? []) as unknown as HkTaskRow[];

        // hkByRoomId keeps the LATEST (highest task_seq) task per room — the active actionable task.
        // hkPriorByRoomId collects all EARLIER completed tasks for the same room today.
        const hkByRoomId = new Map<string, HkTaskRow>();
        const hkPriorByRoomId = new Map<string, HkTaskRow[]>();
        for (const row of hkRows) {
            const existing = hkByRoomId.get(row.room_id);
            if (existing) {
                // existing is now superseded → move it to prior list
                const priors = hkPriorByRoomId.get(row.room_id) ?? [];
                priors.push(existing);
                hkPriorByRoomId.set(row.room_id, priors);
            }
            hkByRoomId.set(row.room_id, row);
        }

        const taskIds = Array.from(new Set(hkRows.map((row) => row.id)));
        const logsByTaskId = new Map<string, HkTaskLogRow[]>();

        if (taskIds.length > 0) {
            const { data: hkLogs, error: hkLogsError } = await supabase
                .from("housekeeping_logs")
                .select("task_id, status, note, created_at")
                .in("task_id", taskIds)
                .order("created_at", { ascending: true });
            if (hkLogsError) return NextResponse.json({ error: hkLogsError.message }, { status: 500 });

            for (const log of hkLogs ?? []) {
                const taskId = String(log.task_id);
                if (!logsByTaskId.has(taskId)) logsByTaskId.set(taskId, []);
                logsByTaskId.get(taskId)?.push({
                    status: String(log.status),
                    note: log.note ?? null,
                    created_at: String(log.created_at),
                });
            }
        }

        // Planned maid + priority for the date (assignment board)
        const { data: planRows, error: planError } = await supabase
            .from("daily_plans")
            .select("room_id, assigned_maid, priority")
            .eq("plan_date", dateParam)
            .in("room_id", roomIds);
        if (planError) return NextResponse.json({ error: planError.message }, { status: 500 });

        const planByRoomId = new Map<string, { assigned_maid: string; priority: number }>();
        for (const row of planRows ?? []) {
            planByRoomId.set(row.room_id, {
                assigned_maid: row.assigned_maid,
                priority: row.priority,
            });
        }

        const maintenanceByRoomId = new Map<
            string,
            Array<{
                assignment_id: string;
                task_id: string;
                task_name: string;
                sync_to_housekeeper: boolean;
                checklist_items: string[] | null;
                estimated_minutes: number;
                notes: string | null;
            }>
        >();

        const { data: maintenanceRows, error: maintenanceError } = await supabase.rpc(
            "get_todays_maintenance_assignments",
            { p_target_date: dateParam }
        );
        if (maintenanceError) {
            console.error("housekeeping/status GET maintenance rpc failed", maintenanceError);
        } else {
            for (const row of ((maintenanceRows ?? []) as MaintenanceAssignmentRow[])) {
                const roomId = String(row.room_id);
                if (!roomIdSet.has(roomId)) continue;
                if (!maintenanceByRoomId.has(roomId)) maintenanceByRoomId.set(roomId, []);
                maintenanceByRoomId.get(roomId)?.push({
                    assignment_id: String(row.assignment_id),
                    task_id: String(row.task_id),
                    task_name: String(row.task_name ?? ""),
                    sync_to_housekeeper: Boolean(row.sync_to_housekeeper),
                    checklist_items: Array.isArray(row.checklist_items) ? row.checklist_items : null,
                    estimated_minutes: Number(row.estimated_minutes ?? 0),
                    notes: row.notes ?? null,
                });
            }
        }

        // Occupancy metadata (Room Rack state + guest context)
        const occupancyNightSelectWithCheckedInAt = `
                room_id,
                reservation_id,
                reservations!reservation_nights_reservation_id_fkey(
                    id,
                    status,
                    guest_name,
                    checkin_date,
                    checkout_date,
                    checked_in_at
                )
                `;
        const occupancyNightSelectFallback = `
                room_id,
                reservation_id,
                reservations!reservation_nights_reservation_id_fkey(
                    id,
                    status,
                    guest_name,
                    checkin_date,
                    checkout_date
                )
                `;

        let occupancyIncludesCheckedInAt = true;
        let nightRows: Array<Record<string, unknown>> = [];

        const nightRowsWithCheckedInAt = await supabase
            .from("reservation_nights")
            .select(occupancyNightSelectWithCheckedInAt)
            .eq("stay_date", dateParam)
            .is("cancelled_at", null)
            .in("room_id", roomIds);

        if (nightRowsWithCheckedInAt.error && isCheckedInAtColumnMissing(nightRowsWithCheckedInAt.error.message)) {
            occupancyIncludesCheckedInAt = false;
            const fallbackNightRows = await supabase
                .from("reservation_nights")
                .select(occupancyNightSelectFallback)
                .eq("stay_date", dateParam)
                .is("cancelled_at", null)
                .in("room_id", roomIds);
            if (fallbackNightRows.error) {
                return NextResponse.json({ error: fallbackNightRows.error.message }, { status: 500 });
            }
            nightRows = (fallbackNightRows.data ?? []) as Array<Record<string, unknown>>;
        } else {
            if (nightRowsWithCheckedInAt.error) {
                return NextResponse.json({ error: nightRowsWithCheckedInAt.error.message }, { status: 500 });
            }
            nightRows = (nightRowsWithCheckedInAt.data ?? []) as Array<Record<string, unknown>>;
        }

        const activeStayRows = (nightRows ?? [])
            .map((row) => {
                const reservationRef = Array.isArray((row as { reservations?: unknown }).reservations)
                    ? ((row as { reservations?: Array<{ id?: string; status?: string; guest_name?: string | null; checkin_date?: string | null; checkout_date?: string | null; checked_in_at?: string | null }> }).reservations ?? [])[0]
                    : ((row as { reservations?: { id?: string; status?: string; guest_name?: string | null; checkin_date?: string | null; checkout_date?: string | null; checked_in_at?: string | null } | null }).reservations ?? null);
                if (!reservationRef || reservationRef.status !== "active" || !reservationRef.id) return null;
                return {
                    room_id: String((row as { room_id: string }).room_id),
                    reservation_id: String(reservationRef.id),
                    guest_name: reservationRef.guest_name ?? null,
                    checkin_date: reservationRef.checkin_date ?? null,
                    checkout_date: reservationRef.checkout_date ?? null,
                    checked_in_at: occupancyIncludesCheckedInAt ? (reservationRef.checked_in_at ?? null) : null,
                };
            })
            .filter(
                (
                    row
                ): row is {
                    room_id: string;
                    reservation_id: string;
                    guest_name: string | null;
                    checkin_date: string | null;
                    checkout_date: string | null;
                    checked_in_at: string | null;
                } => Boolean(row)
            );

        const departuresSelectWithCheckedInAt = `
                id,
                guest_name,
                checkin_date,
                checkout_date,
                checked_in_at,
                reservation_nights(
                    stay_date,
                    room_id,
                    cancelled_at
                )
                `;
        const departuresSelectFallback = `
                id,
                guest_name,
                checkin_date,
                checkout_date,
                reservation_nights(
                    stay_date,
                    room_id,
                    cancelled_at
                )
                `;

        let departuresIncludeCheckedInAt = true;
        let departuresRaw: Array<Record<string, unknown>> = [];

        const departuresWithCheckedInAt = await supabase
            .from("reservations")
            .select(departuresSelectWithCheckedInAt)
            .eq("status", "active")
            .eq("is_dayuse", false)
            .eq("checkout_date", dateParam);

        if (departuresWithCheckedInAt.error && isCheckedInAtColumnMissing(departuresWithCheckedInAt.error.message)) {
            departuresIncludeCheckedInAt = false;
            const departuresFallback = await supabase
                .from("reservations")
                .select(departuresSelectFallback)
                .eq("status", "active")
                .eq("is_dayuse", false)
                .eq("checkout_date", dateParam);
            if (departuresFallback.error) {
                return NextResponse.json({ error: departuresFallback.error.message }, { status: 500 });
            }
            departuresRaw = (departuresFallback.data ?? []) as Array<Record<string, unknown>>;
        } else {
            if (departuresWithCheckedInAt.error) {
                return NextResponse.json({ error: departuresWithCheckedInAt.error.message }, { status: 500 });
            }
            departuresRaw = (departuresWithCheckedInAt.data ?? []) as Array<Record<string, unknown>>;
        }

        const departuresTodayRows: DepartureOccupancyRow[] = (departuresRaw ?? [])
            .map((reservationRow) => {
                const reservationId = String((reservationRow as { id?: string | null }).id ?? "");
                if (!reservationId) return null;

                const nightsRaw = Array.isArray((reservationRow as { reservation_nights?: unknown }).reservation_nights)
                    ? ((reservationRow as { reservation_nights?: Array<{ stay_date?: string | null; room_id?: string | null; cancelled_at?: string | null }> }).reservation_nights ?? [])
                    : ((reservationRow as { reservation_nights?: { stay_date?: string | null; room_id?: string | null; cancelled_at?: string | null } | null }).reservation_nights
                        ? [(reservationRow as { reservation_nights?: { stay_date?: string | null; room_id?: string | null; cancelled_at?: string | null } }).reservation_nights!]
                        : []);

                const nights = nightsRaw
                    .filter((night) => !night?.cancelled_at && night?.room_id && String(night?.stay_date ?? "") <= dateParam)
                    .sort((a, b) => String(b?.stay_date ?? "").localeCompare(String(a?.stay_date ?? "")));

                const latestNight = nights[0] ?? null;
                const roomId = String(latestNight?.room_id ?? "");
                if (!roomId || !roomIdSet.has(roomId)) return null;

                return {
                    room_id: roomId,
                    reservation_id: reservationId,
                    guest_name: ((reservationRow as { guest_name?: string | null }).guest_name ?? null),
                    checkin_date: ((reservationRow as { checkin_date?: string | null }).checkin_date ?? null),
                    checkout_date: ((reservationRow as { checkout_date?: string | null }).checkout_date ?? null),
                    checked_in_at: departuresIncludeCheckedInAt
                        ? (((reservationRow as { checked_in_at?: string | null }).checked_in_at ?? null))
                        : null,
                };
            })
            .filter((row): row is DepartureOccupancyRow => Boolean(row));

        const { data: plannedMoveRowsRaw, error: plannedMoveRowsError } = await supabase
            .from("reservation_room_plans")
            .select("id, reservation_id, start_date, end_date, from_room_id_snapshot, to_room_id, to_room_type_id, move_reason")
            .eq("status", "planned")
            .lte("start_date", dateParam)
            .gt("end_date", dateParam);
        if (plannedMoveRowsError) return NextResponse.json({ error: plannedMoveRowsError.message }, { status: 500 });

        const plannedMoveRows = (plannedMoveRowsRaw ?? []) as Array<{
            reservation_id?: string | null;
            from_room_id_snapshot?: string | null;
            to_room_id?: string | null;
            move_reason?: string | null;
        }>;

        // Ignore stale planned moves when the reservation has already left its source room.
        // Auto-split stays prewrite reservation_nights to the target room, but the guest
        // must remain physically in the source room until the planned move is executed.
        const activeStayRoomByReservationId = new Map<string, string>();
        for (const row of activeStayRows) {
            const reservationId = String(row?.reservation_id ?? "");
            const roomId = String(row?.room_id ?? "");
            if (!reservationId || !roomId) continue;
            if (!activeStayRoomByReservationId.has(reservationId)) {
                activeStayRoomByReservationId.set(reservationId, roomId);
            }
        }

        const effectivePlannedMoveRows = plannedMoveRows.filter((row) => {
            const reservationId = String(row?.reservation_id ?? "");
            if (!reservationId) return false;
            const sourceRoomId = String(row?.from_room_id_snapshot ?? "");
            if (!sourceRoomId) return true;
            const todayAssignedRoomId = activeStayRoomByReservationId.get(reservationId);
            if (!todayAssignedRoomId) return true;
            const targetRoomId = String(row?.to_room_id ?? "");
            return todayAssignedRoomId === sourceRoomId || (isAutoSplitPlannedMove(row) && todayAssignedRoomId === targetRoomId);
        });

        const plannedReservationIds = Array.from(
            new Set(
                effectivePlannedMoveRows
                    .map((row) => String(row?.reservation_id ?? ""))
                    .filter(Boolean)
            )
        );
        const plannedGuestByReservationId = new Map<string, PlannedMoveGuestSummary>();

        if (plannedReservationIds.length > 0) {
            const { data: plannedReservationRows, error: plannedReservationError } = await supabase
                .from("reservations")
                .select("id, status, guest_name, checkin_date, checkout_date")
                .in("id", plannedReservationIds)
                .eq("status", "active");
            if (plannedReservationError) {
                return NextResponse.json({ error: plannedReservationError.message }, { status: 500 });
            }
            for (const row of plannedReservationRows ?? []) {
                const reservationId = String((row as { id?: string | null }).id ?? "");
                if (!reservationId) continue;
                plannedGuestByReservationId.set(reservationId, {
                    reservation_id: reservationId,
                    guest_name: (row as { guest_name?: string | null }).guest_name ?? null,
                    checkin_date: (row as { checkin_date?: string | null }).checkin_date ?? null,
                    checkout_date: (row as { checkout_date?: string | null }).checkout_date ?? null,
                });
            }
        }

        const plannedSourceRoomIds = new Set<string>();
        const plannedTargetRoomIds = new Set<string>();
        const plannedSourceGuestByRoomId = new Map<string, PlannedMoveGuestSummary>();
        const plannedTargetGuestByRoomId = new Map<string, PlannedMoveGuestSummary>();

        for (const row of effectivePlannedMoveRows) {
            const reservationId = String(row?.reservation_id ?? "");
            const plannedGuest = plannedGuestByReservationId.get(reservationId) ?? null;

            const sourceRoomId = String(row?.from_room_id_snapshot ?? "");
            if (sourceRoomId && roomIdSet.has(sourceRoomId)) {
                plannedSourceRoomIds.add(sourceRoomId);
                if (plannedGuest) plannedSourceGuestByRoomId.set(sourceRoomId, plannedGuest);
            }

            const targetRoomId = String(row?.to_room_id ?? "");
            if (targetRoomId && roomIdSet.has(targetRoomId)) {
                plannedTargetRoomIds.add(targetRoomId);
                if (plannedGuest) plannedTargetGuestByRoomId.set(targetRoomId, plannedGuest);
            }
        }

        const activeReservationIds = Array.from(
            new Set([
                ...activeStayRows.map((row) => row.reservation_id),
                ...departuresTodayRows.map((row) => row.reservation_id),
                ...plannedReservationIds,
            ])
        );
        const checkedInSet = new Set<string>();
        if (activeReservationIds.length > 0) {
            const { data: checkedInRows, error: checkedInError } = await supabase
                .from("audit_logs")
                .select("entity_id")
                .eq("entity_type", "reservation")
                .eq("action", "checked_in")
                .in("entity_id", activeReservationIds);
            if (checkedInError) return NextResponse.json({ error: checkedInError.message }, { status: 500 });
            for (const row of checkedInRows ?? []) checkedInSet.add(String(row.entity_id));
        }

        const occupancyByRoomId = new Map<
            string,
            {
                guest_name: string | null;
                has_arrival_pending: boolean;
                has_departure_today: boolean;
                has_checked_in: boolean;
                has_planned_source: boolean;
                has_planned_target: boolean;
                diary_state: DiaryState;
                due_in: boolean;
                due_out: boolean;
                back_to_back: boolean;
                in_house: boolean;
                due_in_guest_name: string | null;
            }
        >();

        for (const row of activeStayRows) {
            const isCheckedIn = Boolean(row.checked_in_at) || checkedInSet.has(row.reservation_id);
            const hasArrivalPending = row.checkin_date === dateParam && !isCheckedIn;
            const hasDepartureToday = row.checkout_date === dateParam && isCheckedIn;
            const current = occupancyByRoomId.get(row.room_id) ?? {
                guest_name: null,
                has_arrival_pending: false,
                has_departure_today: false,
                has_checked_in: false,
                has_planned_source: false,
                has_planned_target: false,
                diary_state: "available" as DiaryState,
                due_in: false,
                due_out: false,
                back_to_back: false,
                in_house: false,
                due_in_guest_name: null,
            };
            current.has_arrival_pending = current.has_arrival_pending || hasArrivalPending;
            current.has_departure_today = current.has_departure_today || hasDepartureToday;
            current.has_checked_in = current.has_checked_in || isCheckedIn;
            if (hasArrivalPending && row.guest_name && !current.due_in_guest_name) {
                current.due_in_guest_name = row.guest_name;
            }
            if (isCheckedIn && row.guest_name && !current.guest_name) {
                current.guest_name = row.guest_name;
            }
            occupancyByRoomId.set(row.room_id, current);
        }

        for (const row of departuresTodayRows) {
            const isCheckedIn = Boolean(row.checked_in_at) || checkedInSet.has(row.reservation_id);
            if (!isCheckedIn) continue;

            const current = occupancyByRoomId.get(row.room_id) ?? {
                guest_name: null,
                has_arrival_pending: false,
                has_departure_today: false,
                has_checked_in: false,
                has_planned_source: false,
                has_planned_target: false,
                diary_state: "available" as DiaryState,
                due_in: false,
                due_out: false,
                back_to_back: false,
                in_house: false,
                due_in_guest_name: null,
            };
            current.has_departure_today = true;
            current.has_checked_in = true;
            if (row.guest_name && !current.guest_name) {
                current.guest_name = row.guest_name;
            }
            occupancyByRoomId.set(row.room_id, current);
        }

        for (const roomId of plannedSourceRoomIds) {
            const plannedGuest = plannedSourceGuestByRoomId.get(roomId) ?? null;
            const current = occupancyByRoomId.get(roomId) ?? {
                guest_name: null,
                has_arrival_pending: false,
                has_departure_today: false,
                has_checked_in: false,
                has_planned_source: false,
                has_planned_target: false,
                diary_state: "available" as DiaryState,
                due_in: false,
                due_out: false,
                back_to_back: false,
                in_house: false,
                due_in_guest_name: null,
            };
            current.has_planned_source = true;
            if (plannedGuest?.guest_name && !current.guest_name) {
                current.guest_name = plannedGuest.guest_name;
            }
            occupancyByRoomId.set(roomId, current);
        }

        for (const roomId of plannedTargetRoomIds) {
            const plannedGuest = plannedTargetGuestByRoomId.get(roomId) ?? null;
            const current = occupancyByRoomId.get(roomId) ?? {
                guest_name: null,
                has_arrival_pending: false,
                has_departure_today: false,
                has_checked_in: false,
                has_planned_source: false,
                has_planned_target: false,
                diary_state: "available" as DiaryState,
                due_in: false,
                due_out: false,
                back_to_back: false,
                in_house: false,
                due_in_guest_name: null,
            };
            current.has_planned_target = true;
            if (plannedGuest?.guest_name && !current.due_in_guest_name) {
                current.due_in_guest_name = plannedGuest.guest_name;
            }
            occupancyByRoomId.set(roomId, current);
        }

        for (const [roomId, occupancy] of occupancyByRoomId.entries()) {
            const isDueOut = occupancy.has_departure_today || occupancy.has_planned_source;
            const isDueIn = occupancy.has_arrival_pending || occupancy.has_planned_target;
            const diaryState: DiaryState = isDueOut && isDueIn
                ? "back_to_back"
                : isDueOut
                    ? "due_out"
                    : isDueIn
                        ? "due_in"
                        : occupancy.has_checked_in
                            ? "inhouse"
                            : "available";
            occupancy.diary_state = diaryState;
            occupancy.due_in = diaryState === "due_in";
            occupancy.due_out = diaryState === "due_out";
            occupancy.back_to_back = diaryState === "back_to_back";
            occupancy.in_house = diaryState === "inhouse";
            if (diaryState === "due_in" && !occupancy.guest_name && occupancy.due_in_guest_name) {
                occupancy.guest_name = occupancy.due_in_guest_name;
            }
            occupancyByRoomId.set(roomId, occupancy);
        }

        const yesterday = shiftDate(dateParam, -1);
        const { data: soldLastNightRows, error: soldLastNightError } = await supabase
            .from("reservation_nights")
            .select("room_id")
            .eq("stay_date", yesterday)
            .is("cancelled_at", null)
            .in("room_id", roomIds);
        if (soldLastNightError) return NextResponse.json({ error: soldLastNightError.message }, { status: 500 });
        const soldLastNightRoomIds = new Set((soldLastNightRows ?? []).map((row) => String(row.room_id)));

        const { data: checkedOutTodayReservations, error: checkedOutTodayError } = await supabase
            .from("reservations")
            .select("id, reservation_nights(room_id, stay_date, cancelled_at)")
            .eq("status", "checked_out")
            .eq("checkout_date", dateParam);
        if (checkedOutTodayError) return NextResponse.json({ error: checkedOutTodayError.message }, { status: 500 });

        const checkedOutTodayRoomIds = new Set<string>();
        const checkedOutTodayReservationByRoomId = new Map<string, RecentReservationRow>();
        for (const reservation of checkedOutTodayReservations ?? []) {
            const nights = Array.isArray((reservation as { reservation_nights?: unknown }).reservation_nights)
                ? ((reservation as { reservation_nights?: Array<{ room_id?: string; stay_date?: string; cancelled_at?: string | null }> }).reservation_nights ?? [])
                : ((reservation as { reservation_nights?: { room_id?: string; stay_date?: string; cancelled_at?: string | null } | null }).reservation_nights
                    ? [(reservation as { reservation_nights?: { room_id?: string; stay_date?: string; cancelled_at?: string | null } }).reservation_nights!]
                    : []);
            const activeNights = nights.filter((night) => !night?.cancelled_at && night?.room_id);
            if (activeNights.length === 0) continue;
            activeNights.sort((a, b) =>
                String(b?.stay_date ?? "").localeCompare(String(a?.stay_date ?? ""))
            );
            const roomId = String(activeNights[0]?.room_id ?? "");
            if (!roomId || !roomIdSet.has(roomId)) continue;
            checkedOutTodayRoomIds.add(roomId);
            if (!checkedOutTodayReservationByRoomId.has(roomId)) {
                const reservationId = String((reservation as { id?: string | null }).id ?? "");
                if (reservationId) {
                    checkedOutTodayReservationByRoomId.set(roomId, {
                        reservation_id: reservationId,
                        status: "checked_out",
                    });
                }
            }
        }

        const recentReservationByRoomId = new Map<string, RecentReservationRow>();
        // Reservation context used for loan collection + HK runtime surfaces.
        // Intentionally excludes deep history fallback to avoid stale carry-over loan items.
        const collectionReservationByRoomId = new Map<string, RecentReservationRow>();
        // Priority source for room-linked runtime context:
        // 1) active stay on date (incl. due-out active bookings),
        // 2) checked-out today,
        // 3) cancelled today.
        for (const row of activeStayRows) {
            if (!row.room_id || !row.reservation_id || recentReservationByRoomId.has(row.room_id)) continue;
            const reservationRef: RecentReservationRow = {
                reservation_id: row.reservation_id,
                status: "active",
            };
            recentReservationByRoomId.set(row.room_id, reservationRef);
            if (!collectionReservationByRoomId.has(row.room_id)) {
                collectionReservationByRoomId.set(row.room_id, reservationRef);
            }
        }
        for (const row of departuresTodayRows) {
            if (!row.room_id || !row.reservation_id || recentReservationByRoomId.has(row.room_id)) continue;
            const reservationRef: RecentReservationRow = {
                reservation_id: row.reservation_id,
                status: "active",
            };
            recentReservationByRoomId.set(row.room_id, reservationRef);
            if (!collectionReservationByRoomId.has(row.room_id)) {
                collectionReservationByRoomId.set(row.room_id, reservationRef);
            }
        }
        checkedOutTodayReservationByRoomId.forEach((reservation, roomId) => {
            const existingRecent = recentReservationByRoomId.get(roomId);
            if (!existingRecent || existingRecent.status !== "active") {
                recentReservationByRoomId.set(roomId, reservation);
            }
            const existingCollection = collectionReservationByRoomId.get(roomId);
            if (!existingCollection || existingCollection.status !== "active") {
                collectionReservationByRoomId.set(roomId, reservation);
            }
        });

        const { from: bangkokDayFrom, to: bangkokDayTo } = toBangkokWindow(dateParam);
        const { data: cancelledAuditRows, error: cancelledAuditError } = await supabase
            .from("audit_logs")
            .select("entity_id")
            .eq("entity_type", "reservation")
            .eq("action", "booking_cancelled")
            .gte("created_at", bangkokDayFrom)
            .lt("created_at", bangkokDayTo);
        if (cancelledAuditError) return NextResponse.json({ error: cancelledAuditError.message }, { status: 500 });

        const cancelledTodayReservationIds = Array.from(
            new Set(
                (cancelledAuditRows ?? [])
                    .map((row) => String((row as { entity_id?: string | null }).entity_id ?? ""))
                    .filter(Boolean)
            )
        );

        if (cancelledTodayReservationIds.length > 0) {
            const { data: cancelledReservations, error: cancelledReservationsError } = await supabase
                .from("reservations")
                .select("id")
                .in("id", cancelledTodayReservationIds)
                .eq("status", "cancelled");
            if (cancelledReservationsError) {
                return NextResponse.json({ error: cancelledReservationsError.message }, { status: 500 });
            }

            const validCancelledIds = Array.from(
                new Set(
                    (cancelledReservations ?? [])
                        .map((row) => String((row as { id?: string | null }).id ?? ""))
                        .filter(Boolean)
                )
            );

            if (validCancelledIds.length > 0) {
                const { data: cancelledNightRows, error: cancelledNightRowsError } = await supabase
                    .from("reservation_nights")
                    .select("reservation_id, room_id, stay_date")
                    .in("reservation_id", validCancelledIds)
                    .in("room_id", roomIds)
                    .order("stay_date", { ascending: false });
                if (cancelledNightRowsError) {
                    return NextResponse.json({ error: cancelledNightRowsError.message }, { status: 500 });
                }

                const cancelledRoomByReservationId = new Map<string, string>();
                for (const row of cancelledNightRows ?? []) {
                    const reservationId = String((row as { reservation_id?: string | null }).reservation_id ?? "");
                    const roomId = String((row as { room_id?: string | null }).room_id ?? "");
                    if (!reservationId || !roomId || cancelledRoomByReservationId.has(reservationId)) continue;
                    cancelledRoomByReservationId.set(reservationId, roomId);
                }

                cancelledRoomByReservationId.forEach((roomId, reservationId) => {
                    if (!roomIdSet.has(roomId)) return;
                    const reservationRef: RecentReservationRow = {
                        reservation_id: reservationId,
                        status: "cancelled",
                    };
                    const existingRecent = recentReservationByRoomId.get(roomId);
                    if (!existingRecent || existingRecent.status !== "active") {
                        recentReservationByRoomId.set(roomId, reservationRef);
                    }
                    const existingCollection = collectionReservationByRoomId.get(roomId);
                    if (!existingCollection || existingCollection.status !== "active") {
                        // Cancelled on the same day should override older checked_out context.
                        collectionReservationByRoomId.set(roomId, reservationRef);
                    }
                });
            }
        }

        // Fallback for carry-forward / older unresolved HK tasks:
        // resolve latest reservation by room (including cancelled nights).
        const unresolvedRoomIds = roomIds.filter((roomId) => !recentReservationByRoomId.has(roomId));
        if (unresolvedRoomIds.length > 0) {
            const { data: fallbackNightRows, error: fallbackNightError } = await supabase
                .from("reservation_nights")
                .select("room_id, reservation_id, stay_date")
                .lte("stay_date", dateParam)
                .in("room_id", unresolvedRoomIds)
                .order("stay_date", { ascending: false });
            if (fallbackNightError) return NextResponse.json({ error: fallbackNightError.message }, { status: 500 });

            const fallbackReservationIds = Array.from(
                new Set(
                    (fallbackNightRows ?? [])
                        .map((row) => String((row as { reservation_id?: string | null }).reservation_id ?? ""))
                        .filter(Boolean)
                )
            );

            if (fallbackReservationIds.length > 0) {
                const { data: fallbackReservations, error: fallbackReservationsError } = await supabase
                    .from("reservations")
                    .select("id, status")
                    .in("id", fallbackReservationIds);
                if (fallbackReservationsError) {
                    return NextResponse.json({ error: fallbackReservationsError.message }, { status: 500 });
                }

                const fallbackReservationLookup = new Map<string, RecentReservationRow>();
                for (const row of fallbackReservations ?? []) {
                    const reservationId = String((row as { id?: string | null }).id ?? "");
                    if (!reservationId) continue;
                    fallbackReservationLookup.set(reservationId, {
                        reservation_id: reservationId,
                        status: ((row as { status?: string | null }).status ?? null),
                    });
                }

                for (const row of fallbackNightRows ?? []) {
                    const roomId = String((row as { room_id?: string | null }).room_id ?? "");
                    const reservationId = String((row as { reservation_id?: string | null }).reservation_id ?? "");
                    if (!roomId || !reservationId || recentReservationByRoomId.has(roomId)) continue;
                    const reservation = fallbackReservationLookup.get(reservationId);
                    if (!reservation) continue;
                    recentReservationByRoomId.set(roomId, reservation);
                }
            }
        }

        const loanCollectionReservationsByRoomId = new Map<string, RecentReservationRow[]>();
        for (const room of rooms) {
            const contexts = mergeLoanCollectionReservationContexts(
                collectionReservationByRoomId.get(room.id) ?? null,
                checkedOutTodayReservationByRoomId.get(room.id) ?? null
            );
            if (contexts.length > 0) loanCollectionReservationsByRoomId.set(room.id, contexts);
        }

        const loanCollectionsByReservationId = new Map<string, LoanCollectionSummary[]>();
        const loanCollectionReservationIds = Array.from(
            new Set(
                Array.from(loanCollectionReservationsByRoomId.values())
                    .flat()
                    .map((row) => row.reservation_id)
            )
        );
        const runtimeSurfaceReservationIds = Array.from(
            new Set(
                Array.from(collectionReservationByRoomId.values())
                    .filter((row) => row.status === "active")
                    .map((row) => row.reservation_id)
            )
        );

        if (loanCollectionReservationIds.length > 0) {
            const { data: loanTraceRows, error: loanTraceError } = await supabase
                .from("reservation_traces")
                .select("reservation_id, loan_qty, due_date, loan_items(name, requires_hk_collection)")
                .in("reservation_id", loanCollectionReservationIds)
                .eq("status", "open")
                .not("loan_item_code", "is", null);
            if (loanTraceError) return NextResponse.json({ error: loanTraceError.message }, { status: 500 });

            for (const row of loanTraceRows ?? []) {
                const reservationId = String((row as { reservation_id?: string | null }).reservation_id ?? "");
                if (!reservationId) continue;
                const loanItem = (row as { loan_items?: { name?: string | null; requires_hk_collection?: boolean } | null }).loan_items;
                if (!loanItem?.requires_hk_collection) continue;
                if (!loanCollectionsByReservationId.has(reservationId)) {
                    loanCollectionsByReservationId.set(reservationId, []);
                }
                loanCollectionsByReservationId.get(reservationId)?.push({
                    item_name: String(loanItem.name ?? "Loan Item"),
                    quantity: Math.max(Number((row as { loan_qty?: number | null }).loan_qty ?? 1), 1),
                    due_date: (row as { due_date?: string | null }).due_date ?? null,
                });
            }
        }

        const hkAlertSummaryByReservationId = new Map<string, {
            count: number;
            firstMessage: string | null;
            highestSeverity: "info" | "warning" | "critical" | null;
        }>();
        const hkTraceItemsByReservationId = new Map<string, Array<{ id: string; text: string }>>();

        if (runtimeSurfaceReservationIds.length > 0) {
            const { data: alertRows, error: alertRowsError } = await supabase
                .from("reservation_alerts")
                .select("id, reservation_id, alert_code, alert_template_id, note, custom_message, display_surfaces, severity, is_dismissed, created_at, created_by, alert_codes(code, description, dept, auto_on_co, icon), alert_templates(id, code, name, description, category, display_surfaces, severity, icon)")
                .in("reservation_id", runtimeSurfaceReservationIds);
            if (alertRowsError) return NextResponse.json({ error: alertRowsError.message }, { status: 500 });

            const groupedAlerts = new Map<string, any[]>();
            for (const row of alertRows ?? []) {
                const reservationId = String((row as any)?.reservation_id ?? "");
                if (!reservationId) continue;
                if (!groupedAlerts.has(reservationId)) groupedAlerts.set(reservationId, []);
                groupedAlerts.get(reservationId)?.push(row);
            }

            groupedAlerts.forEach((rows, reservationId) => {
                const alerts = rows
                    .map((row) => mapEffectiveReservationAlert(row))
                    .filter((alert) => !alert.is_dismissed && alert.category === "housekeeping");
                const visibleAlerts = filterAlertsForSurface(alerts, "hk_dashboard");
                const summary = summarizeAlerts(visibleAlerts);
                if (summary.count > 0) hkAlertSummaryByReservationId.set(reservationId, summary);
            });

            const { data: hkTraceRows, error: hkTraceRowsError } = await supabase
                .from("reservation_traces")
                .select("id, reservation_id, trace_text, dept, loan_item_code, status")
                .in("reservation_id", runtimeSurfaceReservationIds)
                .eq("status", "open")
                .eq("dept", "HK")
                .is("loan_item_code", null);
            if (hkTraceRowsError) return NextResponse.json({ error: hkTraceRowsError.message }, { status: 500 });

            for (const row of hkTraceRows ?? []) {
                const reservationId = String((row as any)?.reservation_id ?? "");
                const traceText = String((row as any)?.trace_text ?? "").trim();
                if (!reservationId || !traceText) continue;
                if (!hkTraceItemsByReservationId.has(reservationId)) {
                    hkTraceItemsByReservationId.set(reservationId, []);
                }
                hkTraceItemsByReservationId.get(reservationId)?.push({
                    id: String((row as any)?.id ?? ""),
                    text: traceText,
                });
            }
        }

        const data = (rooms ?? []).map((room) => {
            const rt = (room.room_types as unknown) as {
                name_en: string;
                code: string;
                cleaning_duration_min: number | null;
            } | null;
            const task = hkByRoomId.get(room.id) ?? null;
            const plan = planByRoomId.get(room.id) ?? null;
            const occupancy = occupancyByRoomId.get(room.id) ?? null;
            const recentReservation = recentReservationByRoomId.get(room.id) ?? null;
            const collectionReservation = collectionReservationByRoomId.get(room.id) ?? null;
            const maintenanceAssignments = maintenanceByRoomId.get(room.id) ?? [];
            const maintenanceMinutesTotal = maintenanceAssignments.reduce(
                (sum, item) => sum + Math.max(Number(item.estimated_minutes ?? 0), 0),
                0
            );
            const hkStatus = task?.status ?? (room.is_sellable ? "available" : "closed");
            const isDirtyTask = hkStatus === "dirty";
            const normalizedStartedAt = isDirtyTask ? null : task?.started_at ?? null;
            const normalizedFinishedAt = isDirtyTask ? null : task?.finished_at ?? null;
            const normalizedApprovedAt = isDirtyTask ? null : task?.approved_at ?? null;
            const normalizedAccumulatedMs = isDirtyTask ? 0 : task?.accumulated_ms ?? 0;
            const elapsedMs = computeElapsedMs(task?.status, normalizedStartedAt, normalizedAccumulatedMs);
            const cleaningDurationMin = rt?.cleaning_duration_min ?? 60;
            const effectiveCleaningDurationMin = cleaningDurationMin + maintenanceMinutesTotal;
            const remainingMs = Math.max(effectiveCleaningDurationMin * 60_000 - elapsedMs, 0);
            const diaryState: DiaryState = occupancy?.diary_state ?? "available";
            const inHouseSoldLastNight = diaryState === "inhouse" && soldLastNightRoomIds.has(room.id);
            const isCheckoutDirtyToday = checkedOutTodayRoomIds.has(room.id) && hkStatus === "dirty";
            const taskStatusForCollections = String(task?.status ?? "");
            const isCollectionVisibleStatus =
                taskStatusForCollections === "dirty" ||
                taskStatusForCollections === "in_progress" ||
                taskStatusForCollections === "paused";
            const loanCollectionReservations = loanCollectionReservationsByRoomId.get(room.id) ?? [];
            const visibleLoanCollections = loanCollectionReservations.flatMap((reservation) =>
                (loanCollectionsByReservationId.get(reservation.reservation_id) ?? []).filter((item) =>
                    shouldShowLoanCollectionForReservation({
                        reservationStatus: reservation.status,
                        isCollectionVisibleStatus,
                        dueDate: item.due_date,
                        date: dateParam,
                    })
                )
            );
            const hkCollectCount = visibleLoanCollections.length;
            const hkCollectUnits = visibleLoanCollections.reduce(
                (sum, item) => sum + Math.max(Number(item.quantity ?? 1), 1),
                0
            );
            const hkCollectItemsByName = new Map<string, number>();
            for (const item of visibleLoanCollections) {
                const itemName = String(item.item_name ?? "Loan Item").trim() || "Loan Item";
                const qty = Math.max(Number(item.quantity ?? 1), 1);
                hkCollectItemsByName.set(itemName, (hkCollectItemsByName.get(itemName) ?? 0) + qty);
            }
            const hkCollectItems = Array.from(hkCollectItemsByName.entries())
                .map(([item_name, quantity]) => ({ item_name, quantity }))
                .sort((a, b) =>
                    a.item_name.localeCompare(b.item_name, undefined, { sensitivity: "base", numeric: true })
                );
            const hkAlertSummary = collectionReservation
                ? hkAlertSummaryByReservationId.get(collectionReservation.reservation_id)
                : null;
            const hkTraceItems = collectionReservation
                ? (hkTraceItemsByReservationId.get(collectionReservation.reservation_id) ?? [])
                : [];
            const taskLogs = task?.id ? (logsByTaskId.get(String(task.id)) ?? []) : [];

            return {
                room_id: room.id,
                room_number: room.room_number,
                floor_number: (room as { floor_number?: number | null }).floor_number ?? null,
                wing: (room as { wing?: string | null }).wing ?? null,
                sort_order: (room as { sort_order?: number | null }).sort_order ?? null,
                room_type: rt?.name_en ?? "Unknown",
                room_type_code: rt?.code ?? "",
                cleaning_duration_min: cleaningDurationMin,
                maintenance_minutes_total: maintenanceMinutesTotal,
                maintenance_assignments: maintenanceAssignments,
                effective_cleaning_duration_min: effectiveCleaningDurationMin,
                is_sellable: room.is_sellable,
                hk_task_id: task?.id ?? null,
                hk_status: hkStatus,
                started_at: normalizedStartedAt,
                finished_at: normalizedFinishedAt,
                approved_at: normalizedApprovedAt,
                accumulated_ms: normalizedAccumulatedMs,
                is_no_service: task?.is_no_service ?? false,
                no_service_note: task?.no_service_note ?? null,
                assigned_maid_name: task?.assigned_maid_name ?? null,
                plan_assigned_maid: plan?.assigned_maid ?? null,
                plan_priority: plan?.priority ?? null,
                diary_state: diaryState,
                due_in: occupancy?.due_in ?? false,
                due_out: occupancy?.due_out ?? false,
                back_to_back: occupancy?.back_to_back ?? false,
                in_house: occupancy?.in_house ?? false,
                in_house_sold_last_night: inHouseSoldLastNight,
                is_checkout_dirty_today: isCheckoutDirtyToday,
                guest_name: occupancy?.guest_name ?? null,
                due_in_guest_name: occupancy?.due_in_guest_name ?? null,
                due_out_guest_name:
                    occupancy && (occupancy.due_out || occupancy.back_to_back)
                        ? occupancy.guest_name ?? null
                        : null,
                hk_alert_count: hkAlertSummary?.count ?? 0,
                hk_first_alert_message: hkAlertSummary?.firstMessage ?? null,
                hk_alert_severity: hkAlertSummary?.highestSeverity ?? null,
                hk_trace_count: hkTraceItems.length,
                hk_trace_items: hkTraceItems,
                hk_collect_count: hkCollectCount,
                hk_collect_units: hkCollectUnits,
                hk_collect_items: hkCollectItems,
                elapsed_ms: elapsedMs,
                remaining_ms: remainingMs,
                is_stayover_service_request: isRoomDiaryServiceRequest(taskLogs),
                hk_logs: taskLogs,
                hk_prior_tasks: (hkPriorByRoomId.get(room.id) ?? []).map((pt) => ({
                    task_id: pt.id,
                    status: pt.status,
                    finished_at: pt.finished_at ?? null,
                    approved_at: pt.approved_at ?? null,
                    assigned_maid_name: pt.assigned_maid_name ?? null,
                })),
            };
        });

        // Append prior completed task entries so they show as separate cards in the dashboard.
        // Each prior task generates a full room entry with its own HK state, flagged with is_prior_task.
        for (const room of (rooms ?? [])) {
            const priors = hkPriorByRoomId.get(room.id) ?? [];
            if (priors.length === 0) continue;
            const mainEntry = data.find((d) => d.room_id === room.id);
            if (!mainEntry) continue;
            for (const pt of priors) {
                const priorLogs = logsByTaskId.get(String(pt.id)) ?? [];
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (data as any[]).push({
                    ...mainEntry,
                    hk_task_id: pt.id,
                    hk_status: pt.status as typeof mainEntry.hk_status,
                    started_at: pt.started_at ?? null,
                    finished_at: pt.finished_at ?? null,
                    approved_at: pt.approved_at ?? null,
                    accumulated_ms: pt.accumulated_ms ?? 0,
                    is_no_service: pt.is_no_service ?? false,
                    assigned_maid_name: pt.assigned_maid_name ?? null,
                    is_stayover_service_request: isRoomDiaryServiceRequest(priorLogs),
                    hk_logs: priorLogs,
                    hk_prior_tasks: [],
                    is_prior_task: true,
                });
            }
        }

        // Summary counts — exclude prior task entries to avoid inflating numbers
        const primaryRooms = data.filter((r) => !(r as any).is_prior_task);
        const summary = {
            dirty: primaryRooms.filter((r) => r.hk_status === "dirty" || r.hk_status === "in_progress" || r.hk_status === "paused").length,
            cleaning: primaryRooms.filter((r) => r.hk_status === "in_progress").length,
            clean: primaryRooms.filter((r) => r.hk_status === "approved").length,
            available: primaryRooms.filter((r) => r.hk_status === "available").length,
            no_service: primaryRooms.filter((r) => r.is_no_service).length,
        };

        return NextResponse.json({ success: true, date: dateParam, summary, rooms: data });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const supabase = createServerSupabaseClient();
        const body: unknown = await request.json();
        const action = (body as { action?: string } | null)?.action ?? "status";

        if (action === "assign") {
            const parsedAssign = assignActionSchema.safeParse(body);
            if (!parsedAssign.success) {
                return NextResponse.json(
                    { error: "Invalid assign payload.", details: parsedAssign.error.flatten() },
                    { status: 400 }
                );
            }

            const { room_id, date, assigned_maid, priority } = parsedAssign.data;
            const normalizedAssignedMaid = assigned_maid.trim();
            const { error } = await supabase
                .from("daily_plans")
                .upsert(
                    {
                        plan_date: date,
                        room_id,
                        assigned_maid: normalizedAssignedMaid,
                        priority,
                    },
                    { onConflict: "plan_date,room_id" }
                );

            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            const { error: syncTaskError } = await supabase
                .from("housekeeping_tasks")
                .update({ assigned_maid_name: normalizedAssignedMaid })
                .eq("room_id", room_id)
                .eq("stay_date", date)
                .eq("status", "dirty");
            if (syncTaskError) return NextResponse.json({ error: syncTaskError.message }, { status: 500 });
            return NextResponse.json({ success: true });
        }

        if (action === "unassign") {
            const parsedUnassign = unassignActionSchema.safeParse(body);
            if (!parsedUnassign.success) {
                return NextResponse.json(
                    { error: "Invalid unassign payload.", details: parsedUnassign.error.flatten() },
                    { status: 400 }
                );
            }

            const { room_id, date } = parsedUnassign.data;
            const { error } = await supabase
                .from("daily_plans")
                .delete()
                .eq("plan_date", date)
                .eq("room_id", room_id);
            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            const { error: syncTaskError } = await supabase
                .from("housekeeping_tasks")
                .update({ assigned_maid_name: null })
                .eq("room_id", room_id)
                .eq("stay_date", date)
                .eq("status", "dirty");
            if (syncTaskError) return NextResponse.json({ error: syncTaskError.message }, { status: 500 });
            return NextResponse.json({ success: true });
        }

        if (action === "room_diary_mark_dirty" || action === "room_diary_mark_no_service") {
            const parsedDiaryAction = action === "room_diary_mark_dirty"
                ? roomDiaryDirtyActionSchema.safeParse(body)
                : roomDiaryNoServiceActionSchema.safeParse(body);

            if (!parsedDiaryAction.success) {
                return NextResponse.json(
                    { error: "Invalid Room Rack payload.", details: parsedDiaryAction.error.flatten() },
                    { status: 400 }
                );
            }

            const { room_id, date } = parsedDiaryAction.data;
            const note = (parsedDiaryAction.data.note ?? "").trim() || null;
            const markAsNoService = action === "room_diary_mark_no_service";

            const linkedActivation = await maybeActivateLinkedWalkInForRoomDiary(supabase, room_id, date, markAsNoService);
            const inHouse = linkedActivation.activated || await isRoomInHouseOnDate(supabase, room_id, date);
            if (!inHouse) {
                return NextResponse.json(
                    { error: "Only in-house rooms can be marked Dirty / No Service from Room Rack." },
                    { status: 400 }
                );
            }

            const { data: existingTask, error: existingTaskError } = await supabase
                .from("housekeeping_tasks")
                .select("id, task_seq, status, assigned_maid_name, started_at, finished_at, approved_at")
                .eq("room_id", room_id)
                .eq("stay_date", date)
                .order("task_seq", { ascending: false })
                .limit(1)
                .maybeSingle();
            if (existingTaskError && existingTaskError.code !== "PGRST116") {
                return NextResponse.json({ error: existingTaskError.message }, { status: 500 });
            }

            const taskStatus = existingTask?.status ?? null;
            const taskLockedStarted = taskStatus === "in_progress" || taskStatus === "paused";
            const taskLockedCompleted =
                taskStatus === "cleaned" ||
                taskStatus === "approved" ||
                Boolean(existingTask?.finished_at) ||
                Boolean(existingTask?.approved_at);

            if (taskLockedStarted) {
                return NextResponse.json(
                    {
                        error: "Housekeeping has started for this room. Dirty / No Service is locked.",
                        reason_code: "hk_task_locked_started",
                        current_status: taskStatus,
                        assigned_maid_name: existingTask?.assigned_maid_name ?? null,
                    },
                    { status: 409 }
                );
            }
            if (taskLockedCompleted) {
                return NextResponse.json(
                    {
                        error: "Housekeeping has already finished for this room. Dirty / No Service is locked.",
                        reason_code: "hk_task_locked_completed",
                        current_status: taskStatus,
                        assigned_maid_name: existingTask?.assigned_maid_name ?? null,
                    },
                    { status: 409 }
                );
            }

            if (markAsNoService && Number(existingTask?.task_seq ?? 1) > 1) {
                return NextResponse.json(
                    {
                        error: "No Service is only available on the first housekeeping cycle.",
                        reason_code: "hk_task_reclean_no_service_blocked",
                        task_seq: Number(existingTask?.task_seq ?? 1),
                    },
                    { status: 409 }
                );
            }

            const nowIso = new Date().toISOString();
            const upsertBasePayload = {
                room_id,
                stay_date: date,
                task_seq: 1,
                status: "dirty",
                is_no_service: markAsNoService,
                started_at: null,
                finished_at: null,
                approved_at: null,
                accumulated_ms: 0,
            };

            let { data: upsertedTask, error: upsertTaskError } = await supabase
                .from("housekeeping_tasks")
                .upsert(
                    {
                        ...upsertBasePayload,
                        no_service_note: markAsNoService ? note : null,
                        no_service_marked_at: markAsNoService ? nowIso : null,
                        no_service_marked_by: markAsNoService ? "Front Desk" : null,
                    },
                    { onConflict: "room_id,stay_date,task_seq" }
                )
                .select("id")
                .maybeSingle();
            if (upsertTaskError) {
                const message = String(upsertTaskError.message ?? "").toLowerCase();
                if (
                    message.includes("no_service_note") ||
                    message.includes("no_service_marked_at") ||
                    message.includes("no_service_marked_by")
                ) {
                    return NextResponse.json(
                        {
                            error:
                                "DB migration required: apply 20260303_phase11_hk_no_service_note.sql before writing no-service data.",
                        },
                        { status: 500 }
                    );
                }
                return NextResponse.json({ error: upsertTaskError.message }, { status: 500 });
            }

            const taskId = upsertedTask?.id ?? existingTask?.id ?? null;
            if (taskId) {
                const logNote = markAsNoService
                    ? `Marked No Service from Room Rack${note ? `: ${note}` : ""}`
                    : `Marked Dirty from Room Rack${note ? `: ${note}` : ""}`;
                const { error: logError } = await supabase.from("housekeeping_logs").insert({
                    task_id: taskId,
                    status: "dirty",
                    note: logNote,
                });
                if (logError) {
                    return NextResponse.json({ error: logError.message }, { status: 500 });
                }
            }

            return NextResponse.json({
                success: true,
                room_id,
                marked_as: markAsNoService ? "no_service" : "dirty",
                linked_walkin_activated: linkedActivation.activated,
                linked_walkin_reservation_id: linkedActivation.childReservationId,
                linked_ota_reservation_id: linkedActivation.parentReservationId,
                housekeeping: {
                    status: "dirty",
                    is_no_service: markAsNoService,
                    no_service_note: markAsNoService ? note : null,
                    assigned_maid_name: existingTask?.assigned_maid_name ?? null,
                    started_at: null,
                    finished_at: null,
                    approved_at: null,
                },
            });
        }

        const parsedStatus = statusActionSchema.safeParse(body);
        if (!parsedStatus.success) {
            return NextResponse.json(
                { error: "Invalid status payload.", details: parsedStatus.error.flatten() },
                { status: 400 }
            );
        }

        const { room_id, date, new_status } = parsedStatus.data;

        // Compatibility path: "available" means clear HK task for the day
        if (new_status === "available") {
            const { error } = await supabase
                .from("housekeeping_tasks")
                .delete()
                .eq("room_id", room_id)
                .eq("stay_date", date);

            if (error) return NextResponse.json({ error: error.message }, { status: 500 });
            return NextResponse.json({ success: true });
        }

        // Compatibility path for old callers that update in_progress/paused via status endpoint.
        if (new_status === "in_progress" || new_status === "paused") {
            const { data: task, error: taskErr } = await supabase
                .from("housekeeping_tasks")
                .select("id, status, started_at, accumulated_ms, assigned_maid_name")
                .eq("room_id", room_id)
                .eq("stay_date", date)
                .maybeSingle();

            if (taskErr && taskErr.code !== "PGRST116") {
                return NextResponse.json({ error: taskErr.message }, { status: 500 });
            }
            if (!task) {
                return NextResponse.json(
                    { error: "Task not found for this date. Mark room dirty first." },
                    { status: 400 }
                );
            }

            if (new_status === "in_progress") {
                if (task.status === "in_progress") {
                    return NextResponse.json({ success: true });
                }
                if (task.status !== "dirty" && task.status !== "paused") {
                    return NextResponse.json(
                        { error: `Cannot move task from ${task.status} to in_progress.` },
                        { status: 400 }
                    );
                }

                const updatePayload: {
                    status: "in_progress";
                    started_at: string;
                    assigned_maid_name?: string;
                } = {
                    status: "in_progress",
                    started_at: new Date().toISOString(),
                };

                if (!task.assigned_maid_name) {
                    const { data: planRow, error: planErr } = await supabase
                        .from("daily_plans")
                        .select("assigned_maid")
                        .eq("plan_date", date)
                        .eq("room_id", room_id)
                        .maybeSingle();
                    if (planErr && planErr.code !== "PGRST116") {
                        return NextResponse.json({ error: planErr.message }, { status: 500 });
                    }
                    if (planRow?.assigned_maid) {
                        updatePayload.assigned_maid_name = planRow.assigned_maid;
                    }
                }

                const { error: updateError } = await supabase
                    .from("housekeeping_tasks")
                    .update(updatePayload)
                    .eq("id", task.id);
                if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

                return NextResponse.json({ success: true });
            }

            if (task.status === "paused") {
                return NextResponse.json({ success: true });
            }
            if (task.status !== "in_progress") {
                return NextResponse.json(
                    { error: `Cannot move task from ${task.status} to paused.` },
                    { status: 400 }
                );
            }
            if (!task.started_at) {
                return NextResponse.json(
                    { error: "Task is in_progress but started_at is missing." },
                    { status: 400 }
                );
            }

            const startedMs = new Date(task.started_at).getTime();
            if (Number.isNaN(startedMs)) {
                return NextResponse.json({ error: "Invalid started_at value." }, { status: 400 });
            }
            const elapsedMs = Math.max(Date.now() - startedMs, 0);
            const nextAccumulatedMs = (task.accumulated_ms ?? 0) + elapsedMs;

            const { error: pauseError } = await supabase
                .from("housekeeping_tasks")
                .update({
                    status: "paused",
                    started_at: null,
                    accumulated_ms: nextAccumulatedMs,
                })
                .eq("id", task.id);
            if (pauseError) return NextResponse.json({ error: pauseError.message }, { status: 500 });

            return NextResponse.json({ success: true });
        }

        if (new_status === "dirty") {
            await maybeActivateLinkedWalkInForRoomDiary(supabase, room_id, date, false);
        }

        const statusPayload =
            new_status === "dirty"
                ? {
                    room_id,
                    stay_date: date,
                    task_seq: 1,
                    status: new_status,
                    is_no_service: false,
                    no_service_note: null,
                    no_service_marked_at: null,
                    no_service_marked_by: null,
                    started_at: null,
                    finished_at: null,
                    approved_at: null,
                    accumulated_ms: 0,
                }
                : {
                    room_id,
                    stay_date: date,
                    task_seq: 1,
                    status: new_status,
                };

        const { error } = await supabase
            .from("housekeeping_tasks")
            .upsert(statusPayload, { onConflict: "room_id,stay_date,task_seq" });

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ success: true });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
