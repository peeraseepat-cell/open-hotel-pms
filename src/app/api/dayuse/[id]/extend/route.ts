import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireStaffAuth } from "@/lib/server-auth";
import { normalizeAuditSource } from "@/lib/audit-utils";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const paramsSchema = z.object({
  id: z.string().uuid(),
});

const bodySchema = z.object({
  payment_method: z.enum(["cash", "transfer", "credit_card"]),
  payment_amount: z.coerce.number().min(0).optional(),
  payment_note: z.string().max(500).optional(),
});

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function POST(request: NextRequest, context: { params: { id: string } }) {
  try {
    const params = paramsSchema.safeParse(context.params);
    if (!params.success) {
      return NextResponse.json(
        { success: false, error: "Invalid reservation id.", details: params.error.flatten() },
        { status: 400 }
      );
    }

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const reservationId = params.data.id;
    const supabase = createServerSupabaseClient();
    const auth = await requireStaffAuth(supabase, request, { allowRoles: ["admin", "supervisor", "frontdesk"] });
    if (auth.error) return auth.error;

    const { data: settings, error: settingsError } = await supabase
      .from("hotel_settings")
      .select("business_date, dayuse_extend_rate, dayuse_extend_min")
      .eq("id", 1)
      .maybeSingle();

    if (settingsError || !settings?.business_date) {
      return NextResponse.json({ success: false, error: "Hotel settings not found." }, { status: 500 });
    }

    const businessDate = String(settings.business_date);
    const extendRate = round2(Number(settings.dayuse_extend_rate ?? 100));
    const extendMin = Math.max(1, Number(settings.dayuse_extend_min ?? 60));

    const { data: reservation, error: reservationError } = await supabase
      .from("reservations")
      .select("id, booking_code, guest_name, status, is_dayuse, total_price, dayuse_expires_at")
      .eq("id", reservationId)
      .maybeSingle();

    if (reservationError) {
      return NextResponse.json({ success: false, error: reservationError.message }, { status: 500 });
    }
    if (!reservation || reservation.is_dayuse !== true || reservation.status !== "active") {
      return NextResponse.json({ success: false, error: "Day use reservation not found or not active." }, { status: 404 });
    }

    const charge = round2(parsed.data.payment_amount ?? extendRate);
    const previousExpiry = reservation.dayuse_expires_at ? String(reservation.dayuse_expires_at) : null;
    const previousTotal = round2(Number(reservation.total_price ?? 0));
    const { data: activeNightRow, error: activeNightError } = await supabase
      .from("reservation_nights")
      .select("id, nightly_price")
      .eq("reservation_id", reservationId)
      .is("cancelled_at", null)
      .order("stay_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (activeNightError) {
      return NextResponse.json({ success: false, error: activeNightError.message }, { status: 500 });
    }

    const activeNightId = activeNightRow?.id ? String(activeNightRow.id) : null;
    const previousNightlyPrice = round2(Number(activeNightRow?.nightly_price ?? previousTotal));
    const baseExpiry = reservation.dayuse_expires_at
      ? new Date(String(reservation.dayuse_expires_at))
      : new Date();
    if (Number.isNaN(baseExpiry.getTime())) {
      return NextResponse.json({ success: false, error: "Invalid current dayuse expiry timestamp." }, { status: 400 });
    }

    const newExpiry = new Date(baseExpiry.getTime() + extendMin * 60 * 1000);
    const newExpiryIso = newExpiry.toISOString();
    const newTotal = round2(previousTotal + charge);
    const nowIso = new Date().toISOString();

    const { error: updateError } = await supabase
      .from("reservations")
      .update({
        dayuse_expires_at: newExpiryIso,
        total_price: newTotal,
      })
      .eq("id", reservationId);

    if (updateError) {
      return NextResponse.json({ success: false, error: updateError.message }, { status: 500 });
    }

    if (activeNightId) {
      const { error: syncNightError } = await supabase
        .from("reservation_nights")
        .update({
          nightly_price: newTotal,
        })
        .eq("id", activeNightId);

      if (syncNightError) {
        await supabase
          .from("reservations")
          .update({
            dayuse_expires_at: previousExpiry,
            total_price: previousTotal,
          })
          .eq("id", reservationId);
        return NextResponse.json({ success: false, error: syncNightError.message }, { status: 500 });
      }
    }

    const { error: paymentError } = await supabase.from("folio_payments").insert({
      reservation_id: reservationId,
      tx_type: "payment",
      method: parsed.data.payment_method,
      amount: charge,
      revenue_category: "dayuse_revenue",
      cashier_name: "System",
      note: parsed.data.payment_note?.trim() || "Day use extension",
      paid_date: businessDate,
      paid_at: nowIso,
    });

    if (paymentError) {
      const { error: rollbackError } = await supabase
        .from("reservations")
        .update({
          dayuse_expires_at: previousExpiry,
          total_price: previousTotal,
        })
        .eq("id", reservationId);

      if (rollbackError) {
        return NextResponse.json(
          {
            success: false,
            error: `${paymentError.message} (rollback failed: ${rollbackError.message})`,
          },
          { status: 500 }
        );
      }
      if (activeNightId) {
        await supabase
          .from("reservation_nights")
          .update({ nightly_price: previousNightlyPrice })
          .eq("id", activeNightId);
      }
      return NextResponse.json({ success: false, error: paymentError.message }, { status: 500 });
    }

    await supabase.from("audit_logs").insert({
      action: "dayuse_extended",
      entity_type: "reservation",
      entity_id: reservationId,
      after_json: {
        booking_code: reservation.booking_code,
        guest_name: reservation.guest_name,
        extension_charge: charge,
        new_expires_at: newExpiryIso,
        extend_minutes: extendMin,
        payment_method: parsed.data.payment_method,
        extended_at: nowIso,
      },
      business_date: businessDate,
      source: normalizeAuditSource("manual"),
    });

    return NextResponse.json({
      success: true,
      new_expires_at: newExpiryIso,
      extension_charge: charge,
      new_total: newTotal,
    });
  } catch (err) {
    console.error("dayuse/[id]/extend POST failed", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
