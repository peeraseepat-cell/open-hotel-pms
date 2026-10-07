import { NextResponse } from "next/server";
import { isLegacyDayUseRoom } from "@/lib/dayuse-rooms";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loadRoomStayNights } from "@/lib/room-stay-nights";

// GET /api/setup/rooms — all rooms with features, beds, detail, total_nights, max_guests
// Graceful: works both before and after migrations are applied
export async function GET() {
    try {
        const supabase = createServerSupabaseClient();
        // 1. Rooms with room type info (always available)
        const { data: rooms, error: rErr } = await supabase
            .from("rooms")
            .select("id, room_number, is_sellable, is_dayuse, sort_order, room_types(id, name_en, code)")
            .order("sort_order", { ascending: true });
        if (rErr) throw rErr;

        // 1b. Occupancy fields from room_types (post-migration, graceful)
        let rtOccupancy: Record<number, any> = {};
        try {
            const { data: rtd } = await supabase
                .from("room_types")
                .select("id, max_guests, extra_guest_charge, child_free_under_cm, child_extra_charge");
            for (const rt of rtd ?? []) rtOccupancy[rt.id] = rt;
        } catch { /* migration not yet applied */ }

        // 2. All features (always available)
        const { data: features, error: fErr } = await supabase
            .from("room_features")
            .select("*")
            .order("category")
            .order("name");
        if (fErr) throw fErr;

        // 3. Feature mappings — try room_id (post-migration), fallback room_number (pre-migration)
        let featureMappingsRaw: { room_id?: string; room_number?: string; feature_code: string }[] = [];
        try {
            const { data: mData, error: mErr } = await supabase
                .from("room_feature_mapping")
                .select("room_id, feature_code");
            if (!mErr) featureMappingsRaw = mData ?? [];
            else throw mErr;
        } catch {
            try {
                const { data: mData } = await supabase
                    .from("room_feature_mapping")
                    .select("room_number, feature_code");
                featureMappingsRaw = mData ?? [];
            } catch { /* ignore */ }
        }

        // 4. Room beds (post-migration, graceful)
        let beds: any[] = [];
        try {
            const { data: bData } = await supabase
                .from("room_beds")
                .select("room_id, bed_type_code, quantity");
            beds = bData ?? [];
        } catch { /* migration not yet applied */ }

        // 5. Room detail (post-migration, graceful)
        let details: any[] = [];
        try {
            const { data: dData } = await supabase
                .from("room_detail")
                .select("room_id, quality_score, ac_model, last_renovated, tv_size_inch, extra_notes, ac_base, furniture_base, bathroom_base, wifi_base, ac_deduct, furniture_deduct, bathroom_deduct, wifi_deduct");
            details = dData ?? [];
        } catch { /* migration not yet applied */ }

        // 6. Total nights from room_stay_history (post-migration, graceful).
        // Paged past the 1000-row cap. Migration-tolerance is now discriminated by error code
        // (undefined-table -> null -> {}), so a genuine read failure or an incomplete read
        // throws out to the 500 below instead of being swallowed into "no stay history".
        const nightsMap: Record<string, number> = (await loadRoomStayNights(supabase)) ?? {};

        // Build lookup maps
        // room_number → uuid (for pre-migration feature lookups)
        const roomNumberToId: Record<string, string> = {};
        for (const r of rooms ?? []) roomNumberToId[(r as any).room_number] = (r as any).id;

        const featureMap: Record<string, string[]> = {};
        for (const m of featureMappingsRaw) {
            const key = m.room_id ?? (m.room_number ? roomNumberToId[m.room_number] : undefined);
            if (!key) continue;
            if (!featureMap[key]) featureMap[key] = [];
            featureMap[key].push(m.feature_code);
        }

        const bedMap: Record<string, { bed_type_code: string; quantity: number }[]> = {};
        for (const b of beds) {
            if (!bedMap[b.room_id]) bedMap[b.room_id] = [];
            bedMap[b.room_id].push({ bed_type_code: b.bed_type_code, quantity: b.quantity });
        }

        const detailMap: Record<string, any> = {};
        for (const d of details) detailMap[d.room_id] = d;


        const formattedRooms = (rooms ?? []).map((r: any) => {
            const roomNumber = String(r.room_number ?? "");
            const isDayUse = Boolean(r.is_dayuse) || isLegacyDayUseRoom(roomNumber);
            const rtId = r.room_types?.id;
            const occ = rtOccupancy[rtId] ?? {};
            return {
                id: r.id,
                room_number: roomNumber,
                room_type: r.room_types?.name_en || "Unknown",
                room_type_code: r.room_types?.code || "",
                room_type_id: rtId,
                max_guests: occ.max_guests ?? 2,
                extra_guest_charge: occ.extra_guest_charge ?? 0,
                child_free_under_cm: occ.child_free_under_cm ?? 110,
                child_extra_charge: occ.child_extra_charge ?? 100,
                is_sellable: r.is_sellable,
                is_dayuse: isDayUse,
                features: featureMap[r.id] || [],
                beds: bedMap[r.id] || [],
                detail: detailMap[r.id] || null,
                quality_score: detailMap[r.id]?.quality_score ?? null,
                total_nights: nightsMap[r.id] || 0,
            };
        });

        return NextResponse.json({ success: true, rooms: formattedRooms, features });
    } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}

// POST /api/setup/rooms — toggle a feature on/off for a room
// Body: { room_id: string, feature_code: string, action: 'add'|'remove' }
export async function POST(req: Request) {
    try {
        const supabase = createServerSupabaseClient();
        const { room_id, feature_code, action } = await req.json();

        if (!room_id || !feature_code) {
            return NextResponse.json({ success: false, error: "room_id and feature_code required" }, { status: 400 });
        }

        if (action === "add") {
            // Try room_id first (post-migration), fallback to room_number
            const { data: room } = await supabase
                .from("rooms").select("room_number").eq("id", room_id).single();

            // Attempt with room_id
            const { error: upsertErr } = await supabase
                .from("room_feature_mapping")
                .upsert({ room_id, feature_code }, { onConflict: "room_id,feature_code" });

            if (upsertErr) {
                // Fallback: pre-migration using room_number
                const { error: e2 } = await supabase
                    .from("room_feature_mapping")
                    .upsert({ room_number: room?.room_number, feature_code }, { onConflict: "room_number,feature_code" });
                if (e2) throw e2;
            }
        } else if (action === "remove") {
            const { error: delErr } = await supabase
                .from("room_feature_mapping")
                .delete()
                .match({ room_id, feature_code });

            if (delErr) {
                // Fallback: pre-migration
                const { data: room } = await supabase
                    .from("rooms").select("room_number").eq("id", room_id).single();
                const { error: e2 } = await supabase
                    .from("room_feature_mapping")
                    .delete()
                    .match({ room_number: room?.room_number, feature_code });
                if (e2) throw e2;
            }
        } else {
            return NextResponse.json({ success: false, error: "action must be 'add' or 'remove'" }, { status: 400 });
        }

        return NextResponse.json({ success: true });
    } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
