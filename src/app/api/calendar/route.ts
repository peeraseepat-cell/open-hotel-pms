import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireStaffAuth } from "@/lib/server-auth";
import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { addDays } from "@/lib/dates";
import { attachTemplateFallback, filterAlertsForSurface, mapEffectiveReservationAlert, normalizeAlertCodeKey, summarizeAlerts } from "@/lib/reservation-alerts";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
    noStore();
    try {
        const supabase = createServerSupabaseClient();
        const auth = await requireStaffAuth(supabase, request);
        if (auth.error) return auth.error;
        const sp = request.nextUrl.searchParams;

        // Default: today → today+14 (Bangkok time)
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
        const defaultEnd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date(Date.now() + 14 * 86400000));
        const startDate = sp.get("start") ?? today;
        const endDate = sp.get("end") ?? defaultEnd;

        // ── Batch 1: Independent queries (no data dependencies) ──
        const [
            { data: rooms, error: roomsErr },
            { data: rawNights, error: nightsErr },
            { data: blocks, error: blocksErr },
            { data: plannedMoves, error: plannedMovesError },
            { data: hkTasks },
        ] = await Promise.all([
            // All rooms (visible on board), ordered
            supabase
                .from("rooms")
                .select("id, room_type_id, room_number, is_sellable, closure_reason, is_dayuse, floor_number, wing, sort_order, room_types(name_en, code)")
                .eq("is_visible_on_board", true)
                .order("floor_number", { ascending: true, nullsFirst: false })
                .order("wing", { ascending: true, nullsFirst: false })
                .order("sort_order", { ascending: true, nullsFirst: false }),

            // All reservation_nights in the date range (not cancelled)
            // Include active stays, checked-out stays for Opera-style CO bars,
            // and draft_checkin so mobile draft check-ins remain visible on the assigned room.
            supabase
                .from("reservation_nights")
                .select(`
                    room_id,
                    stay_date,
                    nightly_price,
                    is_ota,
                    cancelled_at,
                    reservation_id,
                    room_type_id,
                    reservations!inner(
                      id,
                      booking_code,
                      booking_group_id,
                      parent_reservation_id,
                      guest_name,
                      phone,
                      source,
                      status,
                      is_dayuse,
                      checked_in_at,
                      checkin_date,
                      checkout_date,
                      total_price,
                      note,
                      do_not_move_assigned_room
                    )
                `)
                .gte("stay_date", startDate)
                .lte("stay_date", endDate)
                .in("reservations.status", ["active", "checked_out", "draft_checkin"]),

            // Fetch Room Blocks
            // Inclusive AND-overlap, matching the client predicate in
            // src/app/pms/calendar/page.tsx (`!(end_date < startDate || start_date > endDate)`).
            // The previous `.or(...)` was a tautology — a row escaped it only when
            // end_date < start_date — so the server shipped the whole table and lost
            // arbitrary blocks past the 1000-row cap.
            supabase
                .from("room_blocks")
                .select("*")
                .lte("start_date", endDate)
                .gte("end_date", startDate),

            // Planned moves
            supabase
                .from("reservation_room_plans")
                .select("id, reservation_id, start_date, end_date, from_room_id_snapshot, to_room_id, to_room_type_id, move_reason, pricing_policy, do_not_move, status, reservations!inner(id, status)")
                .eq("status", "planned")
                .lt("start_date", addDays(endDate, 1))
                .gt("end_date", startDate)
                .order("start_date", { ascending: true }),

            // Today's HK status per room (moved here from later in the function)
            supabase
                .from("housekeeping_tasks")
                .select("room_id, status")
                .eq("stay_date", today),
        ]);

        if (roomsErr) return NextResponse.json({ error: roomsErr.message }, { status: 500 });
        if (nightsErr) return NextResponse.json({ error: nightsErr.message }, { status: 500 });
        if (blocksErr) return NextResponse.json({ error: blocksErr.message }, { status: 500 });
        if (plannedMovesError) return NextResponse.json({ error: plannedMovesError.message }, { status: 500 });

        const nights = (rawNights ?? []).filter((row: any) => {
            if (!row?.cancelled_at) return true;
            const reservation = row?.reservations as { status?: string | null; is_dayuse?: boolean | null } | null;
            return Boolean(reservation?.is_dayuse) && String(reservation?.status ?? "") === "checked_out";
        });

        const plannedMoveRows = plannedMoves ?? [];
        const plannedMoveReservationIds = Array.from(
            new Set(
                plannedMoveRows
                    .map((row: any) => String(row?.reservation_id ?? ""))
                    .filter(Boolean)
            )
        );
        const activePlannedReservationIds = new Set<string>();
        if (plannedMoveReservationIds.length > 0) {
            const [{ data: plannedReservations, error: plannedReservationsError }, { data: plannedNights, error: plannedNightsError }] = await Promise.all([
                supabase
                    .from("reservations")
                    .select("id, status")
                    .in("id", plannedMoveReservationIds),
                supabase
                    .from("reservation_nights")
                    .select("reservation_id")
                    .in("reservation_id", plannedMoveReservationIds)
                    .is("cancelled_at", null),
            ]);

            if (plannedReservationsError) return NextResponse.json({ error: plannedReservationsError.message }, { status: 500 });
            if (plannedNightsError) return NextResponse.json({ error: plannedNightsError.message }, { status: 500 });

            const activeByStatus = new Set(
                (plannedReservations ?? [])
                    .filter((row: any) => String(row?.status ?? "") === "active")
                    .map((row: any) => String(row.id))
                    .filter(Boolean)
            );
            const activeByNights = new Set(
                (plannedNights ?? [])
                    .map((row: any) => String(row?.reservation_id ?? ""))
                    .filter(Boolean)
            );

            activeByStatus.forEach((reservationId) => {
                if (activeByNights.has(reservationId)) {
                    activePlannedReservationIds.add(reservationId);
                }
            });
        }

        const groupIds = new Set<string>();
        (nights ?? []).forEach((n: any) => {
            const res = n?.reservations as { booking_group_id?: string | null } | null;
            if (res?.booking_group_id) {
                groupIds.add(String(res.booking_group_id));
            }
        });

        const reservationIds = Array.from(
            new Set((nights ?? []).map((row: any) => String(row?.reservation_id ?? "")).filter(Boolean))
        );

        // ── Batch 2: Queries that depend on nights data (run in parallel) ──
        const [groupsResult, alertsResult] = await Promise.all([
            groupIds.size > 0
                ? supabase
                    .from("booking_groups")
                    .select("id, group_code, group_name")
                    .in("id", Array.from(groupIds))
                : Promise.resolve({ data: [] as any[], error: null }),
            reservationIds.length > 0
                ? supabase
                    .from("reservation_alerts")
                    .select("id, reservation_id, alert_code, alert_template_id, note, custom_message, display_surfaces, severity, is_dismissed, created_at, created_by, alert_codes(code, description, dept, auto_on_co, icon), alert_templates(id, code, name, description, category, display_surfaces, severity, icon)")
                    .in("reservation_id", reservationIds)
                : Promise.resolve({ data: [] as any[], error: null }),
        ]);

        const groupMetaById = new Map<string, { group_code: string | null; group_name: string | null }>();
        if (groupsResult.error) return NextResponse.json({ error: groupsResult.error.message }, { status: 500 });
        (groupsResult.data ?? []).forEach((g: any) => {
            groupMetaById.set(String(g.id), {
                group_code: g.group_code ?? null,
                group_name: g.group_name ?? null
            });
        });

        const alertSummaryByReservationId = new Map<string, {
            count: number;
            firstMessage: string | null;
            highestSeverity: "info" | "warning" | "critical" | null;
        }>();
        if (alertsResult.error) return NextResponse.json({ error: alertsResult.error.message }, { status: 500 });
        {
            const reservationAlerts = alertsResult.data ?? [];
            const legacyCodes = Array.from(
                new Set(reservationAlerts.filter((row: any) => !row?.alert_template_id && row?.alert_code).map((row: any) => normalizeAlertCodeKey(row.alert_code)).filter(Boolean))
            );
            let templateMap = new Map<string, any>();
            if (legacyCodes.length > 0) {
                const { data: templates, error: templateError } = await supabase
                    .from("alert_templates")
                    .select("id, code, name, description, category, display_surfaces, severity, icon");
                if (templateError) return NextResponse.json({ error: templateError.message }, { status: 500 });
                templateMap = new Map((templates ?? []).map((template: any) => [normalizeAlertCodeKey(template.code), template]));
            }
            const resolvedRows = attachTemplateFallback(reservationAlerts, templateMap);

            const grouped = new Map<string, any[]>();
            for (const row of resolvedRows) {
                const reservationId = String((row as any)?.reservation_id ?? "");
                if (!reservationId) continue;
                if (!grouped.has(reservationId)) grouped.set(reservationId, []);
                grouped.get(reservationId)?.push(row);
            }

            grouped.forEach((rows, reservationId) => {
                const alerts = rows
                    .map((row) => mapEffectiveReservationAlert(row))
                    .filter((alert) => !alert.is_dismissed);
                const visibleAlerts = filterAlertsForSurface(alerts, "calendar");
                const summary = summarizeAlerts(visibleAlerts);
                if (summary.count > 0) {
                    alertSummaryByReservationId.set(reservationId, summary);
                }
            });
        }

        // ── Planned moves visibility logic ──
        const nightRoomByReservationDate = new Map<string, string>();
        for (const row of nights ?? []) {
            const reservationRef = (row as any)?.reservations as { id?: string | null; status?: string | null } | null;
            if (!reservationRef || String(reservationRef.status ?? "") !== "active") continue;
            const reservationId = reservationRef.id ? String(reservationRef.id) : "";
            const stayDate = String((row as any)?.stay_date ?? "");
            const roomId = String((row as any)?.room_id ?? "");
            if (!reservationId || !stayDate || !roomId) continue;
            nightRoomByReservationDate.set(`${reservationId}::${stayDate}`, roomId);
        }

        const visiblePlannedMoves = plannedMoveRows.filter((row: any) => {
            const reservationId = String(row?.reservation_id ?? "");
            if (!reservationId || !activePlannedReservationIds.has(reservationId)) return false;
            const sourceRoomId = String(row?.from_room_id_snapshot ?? "");
            if (!sourceRoomId) return true;
            const moveStartDate = String(row?.start_date ?? "");
            const moveEndDate = String(row?.end_date ?? "");
            if (!moveStartDate || !moveEndDate) return true;

            // Keep future planned moves visible (important for Move-related filters + planning ahead).
            if (moveStartDate > today) return true;

            // For moves that should be effective today, hide stale rows whose source room no longer matches actual stay room.
            const isEffectiveToday = moveStartDate <= today && moveEndDate > today;
            if (!isEffectiveToday) return true;

            const assignedRoomId = nightRoomByReservationDate.get(`${reservationId}::${today}`);
            if (!assignedRoomId) return true;
            return assignedRoomId === sourceRoomId;
        });
        const plannedReservationIds = Array.from(new Set(visiblePlannedMoves.map((row: any) => String(row.reservation_id)).filter(Boolean)));
        const plannedRoomIds = Array.from(
            new Set(
                visiblePlannedMoves
                    .flatMap((row: any) => [row?.to_room_id ? String(row.to_room_id) : "", row?.from_room_id_snapshot ? String(row.from_room_id_snapshot) : ""])
                    .filter(Boolean)
            )
        );

        // ── Batch 3: Planned move metadata (parallel) ──
        const [plannedReservationsResult, plannedRoomsResult] = await Promise.all([
            plannedReservationIds.length > 0
                ? supabase
                    .from("reservations")
                    .select("id, booking_code, guest_name, checkin_date, checkout_date, booking_group_id")
                    .in("id", plannedReservationIds)
                : Promise.resolve({ data: [] as any[], error: null }),
            plannedRoomIds.length > 0
                ? supabase
                    .from("rooms")
                    .select("id, room_number")
                    .in("id", plannedRoomIds)
                : Promise.resolve({ data: [] as any[], error: null }),
        ]);

        const reservationMetaById = new Map<string, {
            booking_code: string | null;
            guest_name: string | null;
            checkin_date: string | null;
            checkout_date: string | null;
            booking_group_id: string | null;
        }>();
        if (!plannedReservationsResult.error) {
            (plannedReservationsResult.data ?? []).forEach((row: any) => {
                reservationMetaById.set(String(row.id), {
                    booking_code: row.booking_code ?? null,
                    guest_name: row.guest_name ?? null,
                    checkin_date: row.checkin_date ?? null,
                    checkout_date: row.checkout_date ?? null,
                    booking_group_id: row.booking_group_id ?? null,
                });
            });
        }

        const plannedRoomNumberById = new Map<string, string>();
        if (!plannedRoomsResult.error) {
            (plannedRoomsResult.data ?? []).forEach((row: any) => {
                plannedRoomNumberById.set(String(row.id), String(row.room_number));
            });
        }

        // Also collect unassigned reservations
        const resMap: Record<
            string,
            {
                reservation_id: string;
                booking_code: string;
                booking_group_id: string | null;
                group_code: string | null;
                group_name: string | null;
                linked_root_id: string | null;
                linked_reservation_ids?: string[];
                guest_name: string;
                phone: string | null;
                source: string;
                status: string;             // 'active' | 'checked_out'
                checked_in_at: string | null;
                checkin_date: string;
                checkout_date: string;
                total_price: number;
                note: string | null;
                nights: string[];
            }[]
        > = {};
        const unassignedMap = new Map<string, any>();

        // Build room_type_id → name lookup from rooms data (already has room_types join)
        const roomTypeNameById = new Map<string, string>();
        for (const room of rooms ?? []) {
            const rt = (room.room_types as unknown) as { name_en: string; code: string } | null;
            if (room.room_type_id && rt?.name_en) {
                roomTypeNameById.set(String(room.room_type_id), rt.name_en);
            }
        }

        const seen = new Map<string, { roomId: string | null, dates: Set<string> }>();
        const perNightRoomsByReservation = new Map<string, Map<string, string>>();
        const linkedRootIds = new Set<string>();
        for (const nightRow of nights ?? []) {
            const reservationRef = (nightRow as any)?.reservations as { id?: string; parent_reservation_id?: string | null } | null;
            const parentReservationId = reservationRef?.parent_reservation_id ? String(reservationRef.parent_reservation_id) : null;
            if (parentReservationId) {
                linkedRootIds.add(parentReservationId);
            }
        }

        for (const n of nights ?? []) {
            const res = (n.reservations as unknown) as {
                id: string; booking_code: string; booking_group_id: string | null; parent_reservation_id: string | null; guest_name: string; phone: string | null;
                source: string; status: string; checked_in_at: string | null; checkin_date: string; checkout_date: string;
                total_price: number; note: string | null; do_not_move_assigned_room?: boolean;
            };
            if (!res) continue;
            const roomId = n.room_id;
            const resId = res.id;
            const key = roomId ? `${roomId}::${resId}` : `unassigned::${resId}`;

            if (resId && roomId) {
                const nightToRoom = perNightRoomsByReservation.get(resId) ?? new Map<string, string>();
                nightToRoom.set(String(n.stay_date), String(roomId));
                perNightRoomsByReservation.set(resId, nightToRoom);
            }

            if (!seen.has(key)) {
                seen.set(key, { roomId, dates: new Set() });
                const groupId = res.booking_group_id ? String(res.booking_group_id) : null;
                const parentReservationId = res.parent_reservation_id ? String(res.parent_reservation_id) : null;
                const linkedRootId = parentReservationId ?? (linkedRootIds.has(String(res.id)) ? String(res.id) : null);
                const groupMeta = groupId ? groupMetaById.get(groupId) : null;
                const entry = {
                    reservation_id: res.id,
                    booking_code: res.booking_code,
                    booking_group_id: groupId,
                    parent_reservation_id: parentReservationId,
                    linked_root_id: linkedRootId,
                    group_code: groupMeta?.group_code ?? null,
                    group_name: groupMeta?.group_name ?? null,
                    guest_name: res.guest_name,
                    phone: res.phone,
                    source: res.source,
                    status: res.status,
                    checked_in_at: res.checked_in_at,
                    checkin_date: res.checkin_date,
                    checkout_date: res.checkout_date,
                    total_price: res.total_price,
                    note: res.note,
                    nights: [],
                    room_type_id: n.room_type_id ? String(n.room_type_id) : "",
                    room_type: n.room_type_id ? (roomTypeNameById.get(String(n.room_type_id)) ?? "") : "",
                    do_not_move: Boolean(res.do_not_move_assigned_room),
                    alert_count: alertSummaryByReservationId.get(String(res.id))?.count ?? 0,
                    first_alert_message: alertSummaryByReservationId.get(String(res.id))?.firstMessage ?? null,
                    alert_severity: alertSummaryByReservationId.get(String(res.id))?.highestSeverity ?? null,
                };

                if (roomId) {
                    if (!resMap[roomId]) resMap[roomId] = [];
                    resMap[roomId].push(entry);
                } else {
                    unassignedMap.set(resId, entry);
                }
            }
            seen.get(key)!.dates.add(n.stay_date);
        }

        // Attach nights arrays
        for (const [key, val] of seen.entries()) {
            const resId = key.split("::")[1];
            if (val.roomId) {
                const entry = resMap[val.roomId]?.find((r) => r.reservation_id === resId);
                if (entry) entry.nights = [...val.dates].sort();
            } else {
                const entry = unassignedMap.get(resId);
                if (entry) entry.nights = [...val.dates].sort();
            }
        }

        // Build HK status from pre-fetched data (Batch 1)
        const hkStatusByRoomId = new Map<string, string>();
        for (const task of hkTasks ?? []) {
            if (task.room_id && task.status) {
                hkStatusByRoomId.set(String(task.room_id), String(task.status));
            }
        }

        const responseEntries: Array<{
            reservation_id: string;
            linked_root_id: string | null;
            linked_reservation_ids?: string[];
            per_night_rooms?: Record<string, string>;
        }> = [];
        for (const roomReservations of Object.values(resMap)) {
            responseEntries.push(...roomReservations);
        }
        responseEntries.push(...Array.from(unassignedMap.values()));

        const linkedRootIdsForResponse = Array.from(
            new Set(
                responseEntries
                    .map((entry) => entry.linked_root_id ? String(entry.linked_root_id) : "")
                    .filter(Boolean)
            )
        );

        const linkedIdsByRoot = new Map<string, Set<string>>();
        if (linkedRootIdsForResponse.length > 0) {
            const { data: linkedRoots, error: linkedRootsError } = await supabase
                .from("reservations")
                .select("id")
                .in("id", linkedRootIdsForResponse);
            if (linkedRootsError) return NextResponse.json({ error: linkedRootsError.message }, { status: 500 });

            const { data: linkedChildren, error: linkedChildrenError } = await supabase
                .from("reservations")
                .select("id, parent_reservation_id")
                .in("parent_reservation_id", linkedRootIdsForResponse);
            if (linkedChildrenError) return NextResponse.json({ error: linkedChildrenError.message }, { status: 500 });

            for (const rootId of linkedRootIdsForResponse) {
                linkedIdsByRoot.set(rootId, new Set<string>());
            }

            for (const row of linkedRoots ?? []) {
                const id = String((row as any).id ?? "");
                if (!id) continue;
                const set = linkedIdsByRoot.get(id) ?? new Set<string>();
                set.add(id);
                linkedIdsByRoot.set(id, set);
            }

            for (const row of linkedChildren ?? []) {
                const reservationId = String((row as any).id ?? "");
                const parentId = String((row as any).parent_reservation_id ?? "");
                if (!reservationId || !parentId) continue;
                const set = linkedIdsByRoot.get(parentId) ?? new Set<string>();
                set.add(parentId);
                set.add(reservationId);
                linkedIdsByRoot.set(parentId, set);
            }
        }

        for (const entry of responseEntries) {
            const linkedRootId = entry.linked_root_id ? String(entry.linked_root_id) : "";
            if (!linkedRootId) continue;
            const linkedSet = linkedIdsByRoot.get(linkedRootId) ?? new Set<string>([entry.reservation_id]);
            linkedSet.add(entry.reservation_id);
            entry.linked_reservation_ids = Array.from(linkedSet.values()).sort();
        }

        const splitPerNightRoomsByReservation = new Map<string, Record<string, string>>();
        for (const [reservationId, nightToRoom] of perNightRoomsByReservation.entries()) {
            const distinctRoomIds = new Set(Array.from(nightToRoom.values()).filter(Boolean));
            if (distinctRoomIds.size <= 1) continue;
            const orderedEntries = Array.from(nightToRoom.entries()).sort(([leftDate], [rightDate]) =>
                leftDate.localeCompare(rightDate)
            );
            splitPerNightRoomsByReservation.set(
                reservationId,
                Object.fromEntries(orderedEntries)
            );
        }

        for (const entry of responseEntries) {
            const splitMap = splitPerNightRoomsByReservation.get(entry.reservation_id);
            if (splitMap) {
                entry.per_night_rooms = splitMap;
            }
        }

        // Build final rooms list with their reservations
        const data = (rooms ?? []).map((room) => {
            const rt = (room.room_types as unknown) as { name_en: string; code: string } | null;
            return {
                room_id: room.id,
                room_type_id: room.room_type_id ? String(room.room_type_id) : "",
                room_number: room.room_number,
                room_type: rt?.name_en ?? "Unknown",
                room_type_code: rt?.code ?? "",
                is_sellable: room.is_sellable,
                is_dayuse: room.is_dayuse ?? false,
                closure_reason: room.closure_reason,
                hk_status: hkStatusByRoomId.get(String(room.id)) ?? null,
                reservations: resMap[room.id] ?? []
            };
        });

        return NextResponse.json({
            success: true,
            start_date: startDate,
            end_date: endDate,
            rooms: data,
            unassigned: Array.from(unassignedMap.values()),
            blocks: blocks ?? [],
            planned_moves: visiblePlannedMoves.map((row: any) => {
                const reservationMeta = reservationMetaById.get(String(row.reservation_id));
                const groupId = reservationMeta?.booking_group_id ? String(reservationMeta.booking_group_id) : null;
                const groupMeta = groupId ? groupMetaById.get(groupId) : null;
                return {
                    id: String(row.id),
                    reservation_id: String(row.reservation_id),
                    booking_code: reservationMeta?.booking_code ?? null,
                    guest_name: reservationMeta?.guest_name ?? null,
                    checkin_date: reservationMeta?.checkin_date ?? null,
                    checkout_date: reservationMeta?.checkout_date ?? null,
                    booking_group_id: groupId,
                    group_code: groupMeta?.group_code ?? null,
                    group_name: groupMeta?.group_name ?? null,
                    start_date: String(row.start_date),
                    end_date: String(row.end_date),
                    from_room_id_snapshot: row.from_room_id_snapshot ? String(row.from_room_id_snapshot) : null,
                    from_room_number: row.from_room_id_snapshot ? plannedRoomNumberById.get(String(row.from_room_id_snapshot)) ?? null : null,
                    to_room_id: String(row.to_room_id),
                    to_room_number: plannedRoomNumberById.get(String(row.to_room_id)) ?? null,
                    to_room_type_id: Number(row.to_room_type_id ?? 0),
                    move_reason: row.move_reason ?? null,
                    pricing_policy: row.pricing_policy ?? "keep_rtc",
                    do_not_move: Boolean(row.do_not_move),
                    status: String(row.status ?? "planned"),
                };
            }),
        });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
