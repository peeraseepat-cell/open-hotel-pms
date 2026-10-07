import { NextResponse } from "next/server";
import { scoreRooms, DEFAULT_WEIGHTS, type CandidateRoom, type ReservationForAssign } from "@/lib/auto-assign";
import { listOverlappingPlannedRoomHolds, syncReservationNightDependencyMetadata } from "@/lib/planned-room-moves";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getRoomIdsBlockedForStay, ROOM_UNSELLABLE_BLOCK_TYPES } from "@/lib/room-block-availability";
import { listNights } from "@/lib/dates";
import { loadRoomStayNights } from "@/lib/room-stay-nights";

function parseDateString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
    return trimmed;
}

function getBangkokToday(): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
}

async function resolveTargetDate(supabase: ReturnType<typeof createServerSupabaseClient>, requestedDate: unknown): Promise<string> {
    const explicit = parseDateString(requestedDate);
    if (explicit) return explicit;

    const { data, error } = await supabase
        .from("hotel_settings")
        .select("business_date")
        .eq("id", 1)
        .maybeSingle();

    if (!error && data?.business_date && /^\d{4}-\d{2}-\d{2}$/.test(String(data.business_date))) {
        return String(data.business_date);
    }

    return getBangkokToday();
}

/**
 * POST /api/bookings/auto-assign
 * Body: { date?: string, dry_run?: boolean }
 * 
 * Scores and assigns unassigned arrivals on a given date.
 * dry_run=true returns recommendations without committing.
 */
export async function POST(request: Request) {
    try {
        const supabase = createServerSupabaseClient();
        const json = await request.json().catch(() => ({}));
        const targetDate: string = await resolveTargetDate(supabase, (json as any).date);
        const dryRun: boolean = json.dry_run ?? false;

        // ── 1. Fetch scoring weights ───────────────────────────────────────
        const { data: configRows } = await supabase
            .from("scoring_config")
            .select("key, value");
        const weights = { ...DEFAULT_WEIGHTS };
        for (const row of configRows ?? []) {
            if (row.key in weights) (weights as any)[row.key] = Number(row.value);
        }

        // ── 2. Fetch unassigned arrivals on targetDate ────────────────────
        const { data: arrivals, error: arrivalsErr } = await supabase
            .from("reservations")
            .select(`
                id, guest_name, adults, checkin_date, checkout_date, checkin_time,
                reservation_nights(room_id, room_type_id, stay_date, cancelled_at),
                reservation_preferences(feature_code)
            `)
            .eq("checkin_date", targetDate)
            .eq("status", "active");
        if (arrivalsErr) throw arrivalsErr;

        // Filter: only reservations with at least one unassigned night
        const unassigned = (arrivals ?? []).filter((a: any) => {
            const nights = a.reservation_nights?.filter((n: any) => !n.cancelled_at) ?? [];
            return nights.some((n: any) => !n.room_id);
        });

        if (unassigned.length === 0) {
            return NextResponse.json({ success: true, results: [], message: "All arrivals already assigned" });
        }

        // ── 3. Fetch all available rooms with detail ──────────────────────
        const { data: allRooms } = await supabase
            .from("rooms")
            .select(`
                id, room_number, room_type_id,
                floor_number, sort_order, wing,
                room_types(max_guests, extra_guest_charge),
                room_feature_mapping(feature_code),
                room_beds(bed_type_code, quantity),
                room_detail(quality_score)
            `)
            .eq("is_sellable", true)
            .eq("is_dayuse", false);

        // Fetch today's HK statuses
        const { data: hkTasks } = await supabase
            .from("housekeeping_tasks")
            .select("room_id, status")
            .eq("stay_date", targetDate);
        const hkMap: Record<string, string> = {};
        for (const t of hkTasks ?? []) hkMap[t.room_id] = t.status;

        // Fetch stay history totals. Paged: room_stay_history is row-per-room-per-night and
        // exceeds the 1000-row cap in production, so an un-paged read scored rooms off an arbitrary
        // slice. A failed read now throws (caught below as a 500) instead of silently
        // reading as "no history" and scoring every room 0 nights.
        const nightsMap: Record<string, number> = (await loadRoomStayNights(supabase)) ?? {};

        // Build candidate rooms
        const candidates: CandidateRoom[] = (allRooms ?? []).map((r: any) => ({
            id: r.id,
            room_number: r.room_number,
            room_type_id: r.room_type_id,
            max_guests: r.room_types?.max_guests ?? 2,
            extra_guest_charge: r.room_types?.extra_guest_charge ?? 0,
            features: (r.room_feature_mapping ?? []).map((f: any) => f.feature_code),
            beds: (r.room_beds ?? []).map((b: any) => ({ type: b.bed_type_code, qty: b.quantity })),
            quality_score: r.room_detail?.quality_score ?? null,
            total_nights: nightsMap[r.id] || 0,
            hk_status: hkMap[r.id] as any ?? null,
            floor_number: r.floor_number ?? null,
            sort_order: r.sort_order ?? null,
            wing: r.wing ?? null,
        }));

        // ── 4. Process each unassigned reservation ────────────────────────
        const results = [];
        const assignedRoomIds = new Set<string>(); // prevent double-assign

        for (const res of unassigned) {
            const nights = (res as any).reservation_nights?.filter((n: any) => !n.cancelled_at) ?? [];
            const roomTypeId = nights[0]?.room_type_id;
            if (!roomTypeId) continue;

            const checkin = (res as any).checkin_date;
            const checkout = (res as any).checkout_date;
            const prefs = ((res as any).reservation_preferences ?? []).map((p: any) => p.feature_code);
            const adults = (res as any).adults ?? 1;

            // Check conflicts: rooms already occupied during these dates
            const { data: conflicts } = await supabase
                .from("reservation_nights")
                .select("room_id")
                .gte("stay_date", checkin)
                .lt("stay_date", checkout)
                .is("cancelled_at", null)
                .not("room_id", "is", null);
            const conflictedIds = new Set([
                ...(conflicts?.map((c: any) => c.room_id) ?? []),
                ...assignedRoomIds,
            ]);

            // Check unsellable blocks
            const { data: oooBlocks } = await supabase
                .from("room_blocks")
                .select("room_id, block_type, start_date, end_date")
                .in("block_type", ROOM_UNSELLABLE_BLOCK_TYPES)
                .lt("start_date", checkout)
                .gt("end_date", checkin);
            for (const roomId of getRoomIdsBlockedForStay(oooBlocks, listNights(checkin, checkout))) {
                conflictedIds.add(roomId);
            }

            const plannedRows = await listOverlappingPlannedRoomHolds(supabase as any, {
                checkinDate: checkin,
                checkoutDate: checkout,
                roomIds: (allRooms ?? []).map((r: any) => String(r.id)),
                excludeReservationId: String(res.id),
            });
            for (const row of plannedRows) if (row.to_room_id) conflictedIds.add(String(row.to_room_id));

            // Filter to correct type + available
            const typeCandidates = candidates.filter(c =>
                c.room_type_id === roomTypeId && !conflictedIds.has(c.id)
            );

            if (typeCandidates.length === 0) {
                results.push({ reservation_id: res.id, guest: (res as any).guest_name, status: "failed", reason: "No available rooms" });
                continue;
            }

            // Build companion_rooms context from rooms already assigned in this batch
            const companionRooms = [...assignedRoomIds]
                .map(rid => allRooms?.find((r: any) => r.id === rid))
                .filter(Boolean)
                .map((r: any) => ({ floor_number: r.floor_number ?? null, sort_order: r.sort_order ?? null }));

            const reservation: ReservationForAssign = {
                id: res.id,
                room_type_id: roomTypeId,
                adults,
                children: 0,
                preferences: prefs,
                checkin_date: checkin,
                checkin_time: (res as any).checkin_time ?? undefined,
                guest_name: (res as any).guest_name,
                companion_rooms: companionRooms,
            };

            const scored = scoreRooms(typeCandidates, reservation, weights);
            const best = scored.find(s => !s.requires_admin && s.total_score >= 0);

            if (!best) {
                results.push({ reservation_id: res.id, guest: (res as any).guest_name, status: "failed", reason: "All rooms require admin override" });
                continue;
            }

            if (!dryRun) {
                // Assign: update all unassigned nights for this reservation
                const { error: assignErr } = await supabase
                    .from("reservation_nights")
                    .update({
                        room_id: best.room_id,
                        assignment_source: "auto_assign",
                        dependency_plan_id: null,
                        dependency_reason: null,
                    })
                    .eq("reservation_id", res.id)
                    .is("room_id", null)
                    .is("cancelled_at", null);

                if (assignErr) {
                    results.push({ reservation_id: res.id, guest: (res as any).guest_name, status: "error", reason: assignErr.message });
                    continue;
                }
                await syncReservationNightDependencyMetadata(supabase as any, {
                    reservationId: String(res.id),
                });
                assignedRoomIds.add(best.room_id);
            }

            results.push({
                reservation_id: res.id,
                guest: (res as any).guest_name,
                status: dryRun ? "recommendation" : "success",
                room: best.room_number,
                score: best.total_score,
                extra_charge: best.extra_charge_flag,
                breakdown: best.breakdown,
                reasons: best.reasons,
                all_scores: scored.slice(0, 5).map(s => ({
                    room: s.room_number,
                    score: s.total_score,
                    requires_admin: s.requires_admin,
                })),
            });
        }

        return NextResponse.json({ success: true, date: targetDate, dry_run: dryRun, results });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
