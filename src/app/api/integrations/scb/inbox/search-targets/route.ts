import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertAdminOrSupervisor, getAuthenticatedUser } from "@/lib/server-auth";
import { searchPosTargets, searchReservationTargets } from "@/lib/scb/targets";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const querySchema = z.object({
  type: z.enum(["reservation", "pos_order"]),
  q: z.string().trim().min(1),
});

export async function GET(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const user = await getAuthenticatedUser(supabase, request);
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    await assertAdminOrSupervisor(supabase, user.id);

    const parsed = querySchema.safeParse({
      type: request.nextUrl.searchParams.get("type") ?? undefined,
      q: request.nextUrl.searchParams.get("q") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: "Invalid query.", details: parsed.error.flatten() }, { status: 400 });
    }

    const rows = parsed.data.type === "reservation"
      ? await searchReservationTargets(supabase as any, parsed.data.q, 5)
      : await searchPosTargets(supabase as any, parsed.data.q, 5);

    return NextResponse.json({
      success: true,
      rows: rows.map((row) => ({
        target_id: row.target_id,
        target_code: row.target_code,
        guest_name: row.guest_name,
        outstanding_amount: Number(row.outstanding_amount ?? row.total_amount ?? 0),
        has_pending_request: row.has_pending_request,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    const status = message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
