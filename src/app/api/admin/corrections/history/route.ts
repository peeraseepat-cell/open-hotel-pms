import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  AdminCorrectionError,
  getCorrectionHistory,
  isAdminCorrectionError,
} from "@/lib/admin-corrections";
import { getAuthenticatedUser } from "@/lib/server-auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const querySchema = z.object({
  reservation_id: z.string().uuid(),
});

export async function GET(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const user = await getAuthenticatedUser(supabase, request);
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const parsed = querySchema.safeParse({
      reservation_id: request.nextUrl.searchParams.get("reservation_id"),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid query.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const corrections = await getCorrectionHistory(supabase as any, parsed.data.reservation_id);
    return NextResponse.json({ success: true, corrections });
  } catch (err) {
    if (isAdminCorrectionError(err) || err instanceof AdminCorrectionError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
