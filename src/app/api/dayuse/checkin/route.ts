import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireStaffAuth } from "@/lib/server-auth";
import { normalizeAuditSource } from "@/lib/audit-utils";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const blockedHousekeepingStatuses = new Set(["dirty", "in_progress", "paused"]);

const schema = z.object({
  room_id: z.string().uuid(),
  guest_name: z.string().max(200).optional().default(""),
  phone: z.string().max(50).optional().default(""),
  rate: z.coerce.number().min(0).optional(),
  payment_method: z.enum(["cash", "transfer", "credit_card"]),
  payment_amount: z.coerce.number().min(0),
  payment_note: z.string().max(500).optional(),
  note: z.string().max(500).optional(),
});

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function recordComplimentaryPosStockDeduction(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  params: {
    businessDate: string;
    orderId: string;
    productId: string;
    quantity: number;
    performedBy: string | null;
    nowIso: string;
  }
): Promise<void> {
  const quantity = Math.max(Number(params.quantity ?? 0), 0);
  if (!params.orderId || !params.productId || quantity <= 0) return;

  const { error: ensureMainError } = await supabase
    .from("main_stock")
    .upsert(
      {
        product_id: params.productId,
        quantity: 0,
        reorder_level: 10,
        updated_at: params.nowIso,
      },
      { onConflict: "product_id", ignoreDuplicates: true }
    );
  if (ensureMainError) throw new Error(ensureMainError.message);

  const { data: currentRow, error: currentError } = await supabase
    .from("main_stock")
    .select("quantity")
    .eq("product_id", params.productId)
    .single();
  if (currentError || !currentRow) {
    throw new Error(currentError?.message || "Main stock row not found");
  }

  const currentQty = Math.max(Number((currentRow as { quantity?: number | null }).quantity ?? 0), 0);
  const deductQty = Math.min(currentQty, quantity);
  const oversell = Math.max(quantity - currentQty, 0);
  const newQty = Math.max(currentQty - quantity, 0);

  const { error: updateMainError } = await supabase
    .from("main_stock")
    .update({ quantity: newQty, updated_at: params.nowIso })
    .eq("product_id", params.productId);
  if (updateMainError) throw new Error(updateMainError.message);

  const { error: txError } = await supabase.from("stock_transactions_v2").insert({
    transaction_date: params.businessDate,
    product_id: params.productId,
    action: "sale",
    quantity_change: -deductQty,
    from_location: "main",
    to_location: null,
    reference_type: "pos_order",
    reference_id: params.orderId,
    performed_by: params.performedBy,
    note:
      oversell > 0
        ? `[DAYUSE OVERSELL] requested=${quantity}, available=${currentQty}, shortfall=${oversell}`
        : `Day use complimentary water auto-deduct ${quantity}`,
    created_at: params.nowIso,
  });
  if (txError) throw new Error(txError.message);
}

function toBangkokTimeHHmm(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

async function generateDayUseBookingCode(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  businessDate: string
): Promise<string> {
  const datePart = businessDate.replace(/-/g, "");
  for (let i = 0; i < 10; i += 1) {
    const randomPart = Math.floor(Math.random() * 1679616)
      .toString(36)
      .toUpperCase()
      .padStart(4, "0");
    const code = `DU-${datePart}-${randomPart}`;
    const { data, error } = await supabase
      .from("reservations")
      .select("id")
      .eq("booking_code", code)
      .maybeSingle();
    if (error && error.code !== "PGRST116") {
      throw new Error(error.message);
    }
    if (!data) return code;
  }
  throw new Error("Cannot generate unique day use booking code.");
}

export async function POST(request: NextRequest) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = createServerSupabaseClient();
    const auth = await requireStaffAuth(supabase, request, { allowRoles: ["admin", "supervisor", "frontdesk"] });
    if (auth.error) return auth.error;

    const { data: settings, error: settingsError } = await supabase
      .from("hotel_settings")
      .select("business_date, dayuse_rate, dayuse_duration_min")
      .eq("id", 1)
      .maybeSingle();

    if (settingsError || !settings?.business_date) {
      return NextResponse.json({ success: false, error: "Hotel settings not found." }, { status: 500 });
    }

    const businessDate = String(settings.business_date);
    const defaultRate = Number(settings.dayuse_rate ?? 200);
    const durationMin = Math.max(1, Number(settings.dayuse_duration_min ?? 120));

    const { data: room, error: roomError } = await supabase
      .from("rooms")
      .select("id, room_number, room_type_id, is_dayuse")
      .eq("id", parsed.data.room_id)
      .maybeSingle();

    if (roomError) {
      return NextResponse.json({ success: false, error: roomError.message }, { status: 500 });
    }
    if (!room || room.is_dayuse !== true) {
      return NextResponse.json(
        { success: false, error: "Room not found or not a day use room" },
        { status: 404 }
      );
    }

    const { data: hkTask, error: hkError } = await supabase
      .from("housekeeping_tasks")
      .select("status")
      .eq("room_id", room.id)
      .eq("stay_date", businessDate)
      .maybeSingle();

    if (hkError && hkError.code !== "PGRST116") {
      return NextResponse.json({ success: false, error: hkError.message }, { status: 500 });
    }
    const hkStatus = hkTask?.status ? String(hkTask.status) : null;
    if (hkStatus && blockedHousekeepingStatuses.has(hkStatus)) {
      return NextResponse.json(
        {
          success: false,
          error: `Room not ready. HK status: ${hkStatus}`,
          code: "ROOM_NOT_READY",
        },
        { status: 409 }
      );
    }

    const { data: occupiedNight, error: occupiedError } = await supabase
      .from("reservation_nights")
      .select("id, reservations!inner(id, status)")
      .eq("room_id", room.id)
      .eq("stay_date", businessDate)
      .is("cancelled_at", null)
      .eq("reservations.status", "active")
      .limit(1)
      .maybeSingle();

    if (occupiedError) {
      return NextResponse.json({ success: false, error: occupiedError.message }, { status: 500 });
    }
    if (occupiedNight) {
      return NextResponse.json(
        {
          success: false,
          error: "Room already occupied by active day use session",
          code: "ROOM_OCCUPIED",
        },
        { status: 409 }
      );
    }

    const cleanupNowIso = new Date().toISOString();

    const { data: staleDayUseNights, error: staleDayUseError } = await supabase
      .from("reservation_nights")
      .select("id, reservation_id, reservations!inner(status, is_dayuse)")
      .eq("room_id", room.id)
      .eq("stay_date", businessDate)
      .is("cancelled_at", null)
      .eq("reservations.is_dayuse", true)
      .neq("reservations.status", "active");

    if (staleDayUseError) {
      return NextResponse.json({ success: false, error: staleDayUseError.message }, { status: 500 });
    }

    const staleReservationIds = Array.from(
      new Set(
        (staleDayUseNights ?? [])
          .map((row: any) => String(row?.reservation_id ?? "").trim())
          .filter(Boolean)
      )
    );

    if (staleReservationIds.length > 0) {
      const { error: staleCleanupError } = await supabase
        .from("reservation_nights")
        .update({ cancelled_at: cleanupNowIso })
        .in("reservation_id", staleReservationIds)
        .eq("room_id", room.id)
        .eq("stay_date", businessDate)
        .is("cancelled_at", null);

      if (staleCleanupError) {
        return NextResponse.json({ success: false, error: staleCleanupError.message }, { status: 500 });
      }
    }

    const { data: latestSessionRow, error: latestSessionError } = await supabase
      .from("reservation_nights")
      .select("dayuse_session")
      .eq("room_id", room.id)
      .eq("stay_date", businessDate)
      .is("cancelled_at", null)
      .order("dayuse_session", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestSessionError) {
      return NextResponse.json({ success: false, error: latestSessionError.message }, { status: 500 });
    }
    const nextSession = (Number(latestSessionRow?.dayuse_session ?? -1) || -1) + 1;

    const { count: dayUseCount, error: dayUseCountError } = await supabase
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .eq("is_dayuse", true)
      .eq("checkin_date", businessDate);

    if (dayUseCountError) {
      return NextResponse.json({ success: false, error: dayUseCountError.message }, { status: 500 });
    }

    const guestNameRaw = parsed.data.guest_name.trim();
    const guestName = guestNameRaw.length > 0 ? guestNameRaw : `Day Use #${(dayUseCount ?? 0) + 1}`;
    const phone = parsed.data.phone.trim() || null;
    const reservationNote = parsed.data.note?.trim() || null;
    const paymentNote = parsed.data.payment_note?.trim() || null;

    const rate = round2(parsed.data.rate ?? defaultRate);
    const paymentAmount = round2(parsed.data.payment_amount);

    const now = new Date();
    const nowIso = now.toISOString();
    const checkinTime = toBangkokTimeHHmm(now);
    const expiresAt = new Date(now.getTime() + durationMin * 60 * 1000).toISOString();
    const bookingCode = await generateDayUseBookingCode(supabase, businessDate);

    const { data: reservationRow, error: reservationError } = await supabase
      .from("reservations")
      .insert({
        booking_code: bookingCode,
        guest_name: guestName,
        phone,
        source: "walkin",
        status: "active",
        checkin_date: businessDate,
        checkout_date: businessDate,
        checkin_time: checkinTime,
        note: reservationNote,
        total_price: rate,
        is_dayuse: true,
        dayuse_expires_at: expiresAt,
        checked_in_at: nowIso,
      })
      .select("id")
      .single();

    if (reservationError || !reservationRow) {
      return NextResponse.json({ success: false, error: reservationError?.message ?? "Failed to create reservation." }, { status: 500 });
    }

    const reservationId = String(reservationRow.id);

    const { error: nightError } = await supabase
      .from("reservation_nights")
      .insert({
        reservation_id: reservationId,
        room_id: room.id,
        room_type_id: room.room_type_id,
        stay_date: businessDate,
        nightly_price: rate,
        is_ota: false,
        dayuse_session: nextSession,
      });

    if (nightError) {
      await supabase.from("reservations").delete().eq("id", reservationId);
      return NextResponse.json({ success: false, error: nightError.message }, { status: 500 });
    }

    const { error: paymentError } = await supabase.from("folio_payments").insert({
      reservation_id: reservationId,
      tx_type: "payment",
      method: parsed.data.payment_method,
      amount: paymentAmount,
      revenue_category: "dayuse_revenue",
      cashier_name: "System",
      note: paymentNote ?? "Day use check-in",
      paid_date: businessDate,
      paid_at: nowIso,
    });

    if (paymentError) {
      await supabase.from("reservation_nights").update({ cancelled_at: nowIso }).eq("reservation_id", reservationId);
      await supabase.from("reservations").update({ status: "cancelled" }).eq("id", reservationId);
      return NextResponse.json({ success: false, error: paymentError.message }, { status: 500 });
    }

    try {
      const { data: waterProduct } = await supabase
        .from("products")
        .select("id, name")
        .ilike("name", "%water%")
        .eq("is_active", true)
        .in("category", ["pos", "both"])
        .limit(1)
        .maybeSingle();

      if (waterProduct?.id) {
        const orderNumberRpc = await supabase.rpc("generate_pos_order_number");
        const orderNumber =
          !orderNumberRpc.error && orderNumberRpc.data
            ? String(orderNumberRpc.data)
            : `POS-DU-${Date.now()}`;

        const { data: orderRow, error: orderError } = await supabase
          .from("pos_orders")
          .insert({
            order_number: orderNumber,
            order_type: "guest_charge",
            reservation_id: reservationId,
            guest_name: guestName,
            status: "completed",
            subtotal: 0,
            total: 0,
            note: "Day use water - no charge",
            created_by: "System",
            order_date: businessDate,
            created_at: nowIso,
            updated_at: nowIso,
          })
          .select("id")
          .single();

        if (!orderError && orderRow?.id) {
          const waterQuantity = 1;
          const { error: itemInsertError } = await supabase.from("pos_order_items").insert({
            order_id: orderRow.id,
            product_id: waterProduct.id,
            product_name: String(waterProduct.name ?? "Water"),
            quantity: waterQuantity,
            unit_price: 0,
            line_total: 0,
          });
          if (itemInsertError) {
            throw itemInsertError;
          }

          await recordComplimentaryPosStockDeduction(supabase, {
            businessDate,
            orderId: String(orderRow.id),
            productId: String(waterProduct.id),
            quantity: waterQuantity,
            performedBy: "System",
            nowIso,
          });
        }
      }
    } catch (waterErr) {
      console.warn("dayuse/checkin water auto-charge skipped", waterErr);
    }

    await supabase.from("audit_logs").insert({
      action: "dayuse_checkin",
      entity_type: "reservation",
      entity_id: reservationId,
      after_json: {
        room_id: room.id,
        room_number: room.room_number,
        guest_name: guestName,
        rate,
        payment_amount: paymentAmount,
        payment_method: parsed.data.payment_method,
        dayuse_session: nextSession,
        dayuse_expires_at: expiresAt,
        checked_in_at: nowIso,
      },
      business_date: businessDate,
      source: normalizeAuditSource("manual"),
    });

    return NextResponse.json({
      success: true,
      reservation_id: reservationId,
      booking_code: bookingCode,
      guest_name: guestName,
      room_number: room.room_number,
      rate,
      dayuse_expires_at: expiresAt,
      payment_recorded: true,
      payment_amount: paymentAmount,
    });
  } catch (err) {
    console.error("dayuse/checkin POST failed", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
