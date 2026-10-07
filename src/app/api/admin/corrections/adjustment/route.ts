import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  AdminCorrectionError,
  isAdminCorrectionError,
  postAdjustment,
} from "@/lib/admin-corrections";
import { assertAdminOrSupervisor, getAuthenticatedUser } from "@/lib/server-auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  reservation_id: z.string().uuid(),
  direction: z.enum(["add_charge", "reduce_charge"]),
  amount: z.coerce.number().positive(),
  method: z.enum(["cash", "transfer", "credit_card", "other"]),
  original_payment_id: z.string().uuid().nullable().optional(),
  reason: z.string().trim().min(1).max(500),
});

export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const user = await getAuthenticatedUser(supabase, request);
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    await assertAdminOrSupervisor(supabase, user.id);

    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    if (parsed.data.direction === "reduce_charge" && !parsed.data.original_payment_id) {
      return NextResponse.json(
        { success: false, error: "reduce_charge requires selecting the charge being reduced" },
        { status: 400 }
      );
    }

    const result = await postAdjustment(supabase as any, user.id, {
      reservationId: parsed.data.reservation_id,
      direction: parsed.data.direction,
      amount: parsed.data.amount,
      method: parsed.data.method,
      originalPaymentId: parsed.data.original_payment_id ?? null,
      reason: parsed.data.reason,
    });

    return NextResponse.json(result);
  } catch (err) {
    if (isAdminCorrectionError(err) || err instanceof AdminCorrectionError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
