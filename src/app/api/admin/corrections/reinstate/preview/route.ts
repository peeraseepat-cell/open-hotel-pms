import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  AdminCorrectionError,
  isAdminCorrectionError,
  previewReinstateAvailability,
} from "@/lib/admin-corrections";
import { assertAdminOrSupervisor, getAuthenticatedUser } from "@/lib/server-auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const querySchema = z.object({
  reservation_id: z.string().trim().min(1),
  target_room_id: z.string().uuid().optional(),
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
      reservation_id: request.nextUrl.searchParams.get("reservation_id"),
      target_room_id: request.nextUrl.searchParams.get("target_room_id") || undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid query.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const preview = await previewReinstateAvailability(
      supabase as any,
      parsed.data.reservation_id,
      parsed.data.target_room_id ?? null
    );

    return NextResponse.json({
      success: true,
      preview,
    });
  } catch (err) {
    if (isAdminCorrectionError(err) || err instanceof AdminCorrectionError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
