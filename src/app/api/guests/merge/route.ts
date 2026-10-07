import { createServerSupabaseClient } from "@/lib/supabase/server";
import { listGuestProfileBookingNames, replaceGuestProfileBookingNames } from "@/lib/guest-booking-names";
import { requireStaffAuth } from "@/lib/server-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const mergeSchema = z.object({
    master_id: z.string().uuid("master_id must be a valid UUID"),
    source_id: z.string().uuid("source_id must be a valid UUID"),
    reason: z.string().trim().min(1).max(500).default("manual_merge"),
});

/**
 * POST /api/guests/merge
 * Merge two guest profiles using the merge_guest_profiles() RPC (D17: atomic transaction)
 */
export async function POST(request: NextRequest) {
    try {
        const json = await request.json().catch(() => null);
        const parsed = mergeSchema.safeParse(json);
        if (!parsed.success) {
            return NextResponse.json(
                { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
                { status: 400 }
            );
        }

        const { master_id, source_id, reason } = parsed.data;

        // Early guard: can't merge self
        if (master_id === source_id) {
            return NextResponse.json(
                { success: false, error: "Cannot merge a profile with itself." },
                { status: 400 }
            );
        }

        const supabase = createServerSupabaseClient();
        const auth = await requireStaffAuth(supabase, request, { allowRoles: ["admin", "supervisor", "frontdesk"] });
        if (auth.error) return auth.error;

        const [masterBookingNames, sourceBookingNames] = await Promise.all([
            listGuestProfileBookingNames(supabase as any, master_id),
            listGuestProfileBookingNames(supabase as any, source_id),
        ]);

        // Call atomic RPC (D17+D25)
        const { data, error } = await supabase.rpc("merge_guest_profiles", {
            p_master_id: master_id,
            p_source_id: source_id,
            p_reason: reason,
        });

        if (error) {
            console.error("merge_guest_profiles RPC failed", error);
            // Map known exceptions to user-friendly messages
            const rawMsg = error.message || "Merge failed.";
            const msg = rawMsg.includes("does not exist")
                ? "DB migration required: apply profile merge hotfix migration before merging profiles."
                : rawMsg;
            const status = msg.includes("not found") ? 404
                : msg.includes("do_not_merge") ? 409
                    : msg.includes("already merged") ? 409
                        : 500;
            return NextResponse.json({ success: false, error: msg }, { status });
        }

        await replaceGuestProfileBookingNames({
            supabase: supabase as any,
            guestProfileId: master_id,
            bookingNames: Array.from(new Set([...masterBookingNames, ...sourceBookingNames])),
        });

        return NextResponse.json({
            success: true,
            result: data,
        });
    } catch (err) {
        console.error("guests/merge POST failed", err);
        const message = err instanceof Error ? err.message : "Internal server error";
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
