import { createServerSupabaseClient } from "@/lib/supabase/server";
import { syncBookingGroupStatusById } from "@/lib/booking-group-status";
import { normalizeAuditSource } from "@/lib/audit-utils";
import { clearAlertsForInactiveReservations } from "@/lib/alerts/lifecycle";
import { getNightAuditSettings } from "@/lib/night-audit";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
    request: NextRequest,
    { params }: { params: { id: string } }
) {
    try {
        const supabase = createServerSupabaseClient();
        const { businessDate } = await getNightAuditSettings(supabase);
        const reservationId = params.id;

        const { data: reservation, error } = await supabase
            .from("reservations")
            .select("id, booking_group_id, status, guest_name, checkin_date, checked_in_at")
            .eq("id", reservationId)
            .maybeSingle();

        if (error || !reservation) {
            return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
        }
        if (reservation.status !== "active") {
            return NextResponse.json({ error: "Only active reservations can be marked no-show." }, { status: 400 });
        }
        if (reservation.checked_in_at) {
            return NextResponse.json({ error: "Reservation was already checked in." }, { status: 409 });
        }

        const { error: updateError } = await supabase
            .from("reservations")
            .update({ status: "no_show" })
            .eq("id", reservationId);

        if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

        const { error: cancelNightsError } = await supabase
            .from("reservation_nights")
            .update({ cancelled_at: new Date().toISOString() })
            .eq("reservation_id", reservationId)
            .is("cancelled_at", null);

        if (cancelNightsError) return NextResponse.json({ error: cancelNightsError.message }, { status: 500 });

        try {
            const alertCleanupCounts = await clearAlertsForInactiveReservations({
                supabase,
                reservationIds: [reservationId],
                reason: "no_show",
            });
            console.warn("[alerts:lifecycle] cleared on no-show", {
                reservationIds: [reservationId],
                ...alertCleanupCounts,
            });
        } catch (alertCleanupError) {
            console.error("[alerts:lifecycle] cleanup failed (no-show succeeded)", {
                reservationIds: [reservationId],
                error: alertCleanupError instanceof Error ? alertCleanupError.message : String(alertCleanupError),
            });
        }

        await supabase.from("audit_logs").insert({
            action: "no_show",
            entity_type: "reservation",
            entity_id: reservationId,
            after_json: {
                guest_name: reservation.guest_name,
                checkin_date: reservation.checkin_date,
                marked_at: new Date().toISOString()
            },
            business_date: businessDate,
            source: normalizeAuditSource("manual"),
        });

        if (reservation.booking_group_id) {
            try {
                await syncBookingGroupStatusById(supabase, String(reservation.booking_group_id));
            } catch (syncError) {
                console.error("group status sync after no-show failed:", reservation.booking_group_id, syncError);
            }
        }

        return NextResponse.json({ success: true, message: "Marked as no-show." });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
