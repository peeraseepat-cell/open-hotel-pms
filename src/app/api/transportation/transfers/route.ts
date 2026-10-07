import { createServerSupabaseClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const paymentMethods = new Set(["cash", "transfer", "credit_card"]);

const listQuerySchema = z.object({
  date: z.string().regex(dateRegex, "date must be YYYY-MM-DD").optional(),
  date_from: z.string().regex(dateRegex, "date_from must be YYYY-MM-DD").optional(),
  date_to: z.string().regex(dateRegex, "date_to must be YYYY-MM-DD").optional(),
  status: z
    .enum(["pending", "confirmed", "driver_assigned", "in_progress", "completed", "cancelled", "no_show"])
    .optional(),
  reservation_id: z.string().uuid().optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const transferCreateSchema = z.object({
  reservation_id: z.string().uuid("reservation_id must be a valid UUID"),
  transfer_type: z.enum(["airport_pickup", "airport_dropoff", "hotel_to_anywhere", "bus_ferry_pickup", "ticket_only"]),
  service_mode: z.enum(["company_pickup", "hotel_arrange", "ticket_only", "driver_only"]),
  pickup_datetime: z.string().min(1, "pickup_datetime is required"),
  pickup_location: z.string().trim().min(1, "pickup_location is required"),
  dropoff_location: z.string().trim().min(1, "dropoff_location is required"),
  pax: z.number().int().min(1, "pax must be >= 1").optional().default(1),
  luggage_count: z.number().int().min(0).optional().default(0),
  driver_id: z.string().uuid().optional().nullable(),
  vehicle_id: z.string().uuid().optional().nullable(),
  boat_company_id: z.string().uuid().optional().nullable(),
  boat_route_id: z.string().uuid().optional().nullable(),
  selling_price: z.number().min(0).optional().nullable(),
  cost_price: z.number().min(0).optional().nullable(),
  driver_fee: z.number().min(0).optional().nullable(),
  driver_commission: z.number().min(0).optional().default(0),
  payment_method: z.enum(["cash", "transfer", "credit_card"]).optional().nullable(),
  staff_note: z.string().trim().max(2000).optional().nullable(),
  created_by: z.string().trim().max(200).optional().nullable(),
});

function toBangkokDateString(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return new Date().toISOString().slice(0, 10);
  return `${year}-${month}-${day}`;
}

function addDays(dateString: string, days: number): string {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function pickupDateInBangkok(pickupIso: string): string {
  const date = new Date(pickupIso);
  if (Number.isNaN(date.getTime())) return pickupIso.slice(0, 10);
  return toBangkokDateString(date);
}

function pickupTimeInBangkok(pickupIso: string): string {
  const date = new Date(pickupIso);
  if (Number.isNaN(date.getTime())) return pickupIso.slice(11, 16);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function isBoatAlertType(transferType: string): boolean {
  return transferType === "bus_ferry_pickup" || transferType === "ticket_only";
}

function canCreateTransferForReservation(
  reservationStatus: string,
  checkoutDate: string | null,
  businessDate: string
): boolean {
  if (reservationStatus === "active") return true;
  return reservationStatus === "checked_out" && checkoutDate === businessDate;
}

function shouldUseFallbackCreate(rpcError: { code?: string | null; message?: string | null }): boolean {
  const code = String(rpcError.code ?? "");
  const message = String(rpcError.message ?? "").toLowerCase();
  return (
    code === "42883" ||
    message.includes("payment_method_type") ||
    message.includes("reservation must be active")
  );
}

type ReservationNightRoom = {
  stay_date: string;
  room_number: string | null;
};

function resolveRoomNumberForDate(
  nights: ReservationNightRoom[] | undefined,
  targetDate: string
): string | null {
  if (!nights || nights.length === 0) return null;

  let exact: string | null = null;
  let latest: ReservationNightRoom | null = null;

  for (const night of nights) {
    if (night.stay_date === targetDate && night.room_number) {
      exact = night.room_number;
      break;
    }
    if (night.stay_date <= targetDate) {
      if (!latest || night.stay_date > latest.stay_date) {
        latest = night;
      }
    }
  }

  if (exact) return exact;
  return latest?.room_number ?? null;
}

type TransferRow = {
  id: string;
  reservation_id: string;
  guest_name: string;
  guest_phone: string | null;
  transfer_type: string;
  service_mode: string;
  pickup_datetime: string;
  pickup_location: string;
  dropoff_location: string;
  pax: number;
  luggage_count: number;
  driver_id: string | null;
  vehicle_id: string | null;
  boat_company_id: string | null;
  boat_route_id: string | null;
  selling_price: number | null;
  cost_price: number | null;
  driver_fee: number | null;
  driver_commission: number | null;
  net_commission: number | null;
  actual_price: number | null;
  payment_status: string;
  payment_method: string | null;
  status: string;
  staff_note: string | null;
  guest_note: string | null;
  voucher_note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

async function enrichTransfers(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  transfers: TransferRow[]
) {
  const driverIds = Array.from(new Set(transfers.map((t) => t.driver_id).filter((id): id is string => Boolean(id))));
  const companyIds = Array.from(
    new Set(transfers.map((t) => t.boat_company_id).filter((id): id is string => Boolean(id)))
  );
  const reservationIds = Array.from(new Set(transfers.map((t) => t.reservation_id)));
  const pickupDates = Array.from(new Set(transfers.map((t) => pickupDateInBangkok(t.pickup_datetime))));
  const maxPickupDate = pickupDates.length > 0 ? pickupDates.reduce((max, d) => (d > max ? d : max), pickupDates[0]) : null;

  const driverMap = new Map<string, { name: string; phone: string | null }>();
  const companyMap = new Map<string, string>();
  const bookingCodeByReservation = new Map<string, string>();
  const reservationNightsByReservation = new Map<string, ReservationNightRoom[]>();

  if (driverIds.length > 0) {
    const { data, error } = await supabase.from("drivers").select("id, name, phone").in("id", driverIds);
    if (error) return { error };
    for (const row of data ?? []) {
      driverMap.set(String(row.id), { name: String(row.name), phone: row.phone ?? null });
    }
  }

  if (companyIds.length > 0) {
    const { data, error } = await supabase.from("boat_companies").select("id, name").in("id", companyIds);
    if (error) return { error };
    for (const row of data ?? []) {
      companyMap.set(String(row.id), String(row.name));
    }
  }

  if (reservationIds.length > 0) {
    const { data, error } = await supabase
      .from("reservations")
      .select("id, booking_code")
      .in("id", reservationIds);
    if (error) return { error };
    for (const row of data ?? []) {
      bookingCodeByReservation.set(String(row.id), String(row.booking_code));
    }
  }

  if (reservationIds.length > 0 && maxPickupDate) {
    const { data, error } = await supabase
      .from("reservation_nights")
      .select("reservation_id, stay_date, rooms:room_id(room_number)")
      .in("reservation_id", reservationIds)
      .lte("stay_date", maxPickupDate)
      .is("cancelled_at", null);
    if (error) return { error };

    for (const row of (data ?? []) as any[]) {
      const reservationId = String(row.reservation_id);
      const stayDate = String(row.stay_date);
      const roomRef = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
      const entry: ReservationNightRoom = {
        stay_date: stayDate,
        room_number: roomRef?.room_number ? String(roomRef.room_number) : null,
      };
      const existing = reservationNightsByReservation.get(reservationId);
      if (existing) existing.push(entry);
      else reservationNightsByReservation.set(reservationId, [entry]);
    }
  }

  const enriched = transfers.map((transfer) => {
    const pickupDate = pickupDateInBangkok(transfer.pickup_datetime);
    const driver = transfer.driver_id ? driverMap.get(transfer.driver_id) : null;
    return {
      ...transfer,
      booking_code: bookingCodeByReservation.get(transfer.reservation_id) ?? null,
      room_number: resolveRoomNumberForDate(
        reservationNightsByReservation.get(transfer.reservation_id),
        pickupDate
      ),
      driver_name: driver?.name ?? null,
      driver_phone: driver?.phone ?? null,
      boat_company_name: transfer.boat_company_id ? (companyMap.get(transfer.boat_company_id) ?? null) : null,
    };
  });

  return { data: enriched };
}

async function fallbackCreateTransfer(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  payload: z.infer<typeof transferCreateSchema>
) {
  // ★ Phase 11A: Also fetch guest_profile_id for transfer_transactions + commission_ledger
  const { data: reservation, error: reservationError } = await supabase
    .from("reservations")
    .select("id, status, guest_name, phone, guest_profile_id, checkout_date")
    .eq("id", payload.reservation_id)
    .maybeSingle();

  if (reservationError) throw new Error(reservationError.message);
  if (!reservation) throw new Error("Reservation not found.");
  const businessDate = toBangkokDateString();
  const reservationStatus = String(reservation.status ?? "");
  const checkoutDate = reservation.checkout_date ? String(reservation.checkout_date) : null;
  if (!canCreateTransferForReservation(reservationStatus, checkoutDate, businessDate)) {
    throw new Error("Reservation must be active or checked out today.");
  }

  const pickupDate = pickupDateInBangkok(payload.pickup_datetime);
  const pickupTime = pickupTimeInBangkok(payload.pickup_datetime);

  const selling = payload.selling_price ?? null;
  const cost = payload.cost_price ?? null;
  const driverFee = payload.driver_fee ?? null;
  const driverCom = payload.driver_commission ?? 0;

  const paymentStatus = payload.payment_method ? "paid_to_hotel" : "unpaid";
  const status = payload.driver_id ? "driver_assigned" : "pending";
  const netCommission = Number(
    (
      (selling ?? 0) -
      (cost ?? 0) -
      (driverFee ?? 0) +
      (driverCom ?? 0)
    ).toFixed(2)
  );
  const margin = selling !== null ? (cost === null ? 0 : Number((selling - cost).toFixed(2))) : null;

  const { data: transfer, error: transferError } = await supabase
    .from("transfers")
    .insert({
      reservation_id: payload.reservation_id,
      guest_name: reservation.guest_name,
      guest_phone: reservation.phone ?? null,
      transfer_type: payload.transfer_type,
      service_mode: payload.service_mode,
      pickup_datetime: payload.pickup_datetime,
      pickup_location: payload.pickup_location,
      dropoff_location: payload.dropoff_location,
      pax: payload.pax,
      luggage_count: payload.luggage_count,
      driver_id: payload.driver_id ?? null,
      vehicle_id: payload.vehicle_id ?? null,
      boat_company_id: payload.boat_company_id ?? null,
      boat_route_id: payload.boat_route_id ?? null,
      selling_price: selling,
      cost_price: cost,
      driver_fee: driverFee,
      driver_commission: driverCom,
      net_commission: netCommission,
      payment_status: paymentStatus,
      payment_method: payload.payment_method ?? null,
      status,
      staff_note: payload.staff_note ?? null,
      created_by: payload.created_by ?? null,
    })
    .select("id")
    .single();

  if (transferError) throw new Error(transferError.message);

  const transferId = String(transfer.id);

  let voucherNumber: string;
  const voucherRpc = await supabase.rpc("generate_transfer_voucher_number");
  if (voucherRpc.error || !voucherRpc.data) {
    voucherNumber = `TRF-${pickupDate.replace(/-/g, "")}-${String(Date.now()).slice(-6)}`;
  } else {
    voucherNumber = String(voucherRpc.data);
  }

  const operatorLabel = isBoatAlertType(payload.transfer_type) ? "Boat Transfer" : "Car Transfer";

  const { error: voucherError } = await supabase.from("transfer_vouchers").insert({
    transfer_id: transferId,
    voucher_number: voucherNumber,
    guest_name: reservation.guest_name,
    route_description: `${payload.pickup_location} -> ${payload.dropoff_location}`,
    pickup_time: pickupTime,
    pickup_location: payload.pickup_location,
    special_instructions: payload.staff_note ?? null,
  });
  if (voucherError) throw new Error(voucherError.message);

  const alertCode = isBoatAlertType(payload.transfer_type) ? "BOAT" : "CAR";
  const alertLine = `[${voucherNumber}] ${pickupTime} ${operatorLabel}`;
  const { data: existingAlert, error: existingAlertError } = await supabase
    .from("reservation_alerts")
    .select("id, note")
    .eq("reservation_id", payload.reservation_id)
    .eq("alert_code", alertCode)
    .maybeSingle();
  if (existingAlertError) throw new Error(existingAlertError.message);

  if (!existingAlert) {
    const { error: insertAlertError } = await supabase.from("reservation_alerts").insert({
      reservation_id: payload.reservation_id,
      alert_code: alertCode,
      note: alertLine,
    });
    if (insertAlertError) throw new Error(insertAlertError.message);
  } else {
    const oldNote = (existingAlert.note ?? "").trim();
    const newNote = oldNote.length === 0 ? alertLine : oldNote.includes(alertLine) ? oldNote : `${oldNote}\n${alertLine}`;
    const { error: updateAlertError } = await supabase
      .from("reservation_alerts")
      .update({ note: newNote })
      .eq("id", existingAlert.id);
    if (updateAlertError) throw new Error(updateAlertError.message);
  }

  const traceText = `[TRANSFER][${voucherNumber}] ${payload.transfer_type} pickup ${pickupTime} - ${operatorLabel}`;
  const { error: traceError } = await supabase.from("reservation_traces").insert({
    reservation_id: payload.reservation_id,
    created_by: payload.created_by ?? null,
    dept: "FD",
    trace_text: traceText,
    from_date: pickupDate,
    to_date: pickupDate,
    status: "open",
  });
  if (traceError) throw new Error(traceError.message);

  // ══════════════════════════════════════════════════════
  // ★ PHASE 11A: Insert transfer_transactions instead of folio_payments
  // ══════════════════════════════════════════════════════
  let transferTxPosted = false;
  if (paymentStatus === "paid_to_hotel" && selling !== null && selling > 0 && payload.payment_method) {
    if (!paymentMethods.has(payload.payment_method)) {
      throw new Error("payment_method is invalid.");
    }
    const { error: txError } = await supabase.from("transfer_transactions").insert({
      transfer_id: transferId,
      reservation_id: payload.reservation_id,
      guest_profile_id: reservation.guest_profile_id ?? null,
      tx_type: "charge",
      amount: selling,
      selling_price: selling,
      cost_price: cost,
      margin,
      payment_method: payload.payment_method,
      cashier_name: payload.created_by ?? null,
      note: `Transfer: ${payload.transfer_type} - ${voucherNumber}`,
    });
    if (txError) throw new Error(txError.message);
    transferTxPosted = true;
  }

  // ══════════════════════════════════════════════════════
  // ★ PHASE 11A: Auto-create commission_ledger (1:1 with transfer)
  // ══════════════════════════════════════════════════════
  let commissionCreated = false;
  if (selling !== null && selling > 0) {
    const { error: comError } = await supabase.from("commission_ledger").insert({
      transfer_id: transferId,
      reservation_id: payload.reservation_id,
      guest_profile_id: reservation.guest_profile_id ?? null,
      staff_name: payload.created_by ?? "N/A",
      rule_type: "pct_sell",
      rule_value: selling > 0 ? Number(((driverCom / selling) * 100).toFixed(2)) : 0,
      base_amount: selling,
      commission_amount: driverCom,
      status: "pending",
      payout_cycle: "monthly",
    });
    if (comError) throw new Error(comError.message);
    commissionCreated = true;
  }

  return {
    success: true,
    transfer_id: transferId,
    voucher_number: voucherNumber,
    alert_created: true,
    trace_created: true,
    transfer_tx_posted: transferTxPosted,
    commission_created: commissionCreated,
  };
}

export async function GET(request: NextRequest) {
  try {
    const parsed = listQuerySchema.safeParse({
      date: request.nextUrl.searchParams.get("date") ?? undefined,
      date_from: request.nextUrl.searchParams.get("date_from") ?? undefined,
      date_to: request.nextUrl.searchParams.get("date_to") ?? undefined,
      status: request.nextUrl.searchParams.get("status") ?? undefined,
      reservation_id: request.nextUrl.searchParams.get("reservation_id") ?? undefined,
      q: request.nextUrl.searchParams.get("q") ?? undefined,
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
      offset: request.nextUrl.searchParams.get("offset") ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid query params.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { date, date_from, date_to, status, reservation_id, q, limit, offset } = parsed.data;
    const supabase = createServerSupabaseClient();

    let query = supabase
      .from("transfers")
      .select("*", { count: "exact" })
      .order("pickup_datetime", { ascending: true })
      .range(offset, offset + limit - 1);

    if (date) {
      const endDate = addDays(date, 1);
      query = query.gte("pickup_datetime", `${date}T00:00:00+07:00`).lt("pickup_datetime", `${endDate}T00:00:00+07:00`);
    } else if (date_from || date_to) {
      if (date_from) query = query.gte("pickup_datetime", `${date_from}T00:00:00+07:00`);
      if (date_to) {
        const endDate = addDays(date_to, 1);
        query = query.lt("pickup_datetime", `${endDate}T00:00:00+07:00`);
      }
    } else {
      const today = toBangkokDateString();
      const tomorrow = addDays(today, 1);
      query = query.gte("pickup_datetime", `${today}T00:00:00+07:00`).lt("pickup_datetime", `${tomorrow}T00:00:00+07:00`);
    }

    if (status) query = query.eq("status", status);
    if (reservation_id) query = query.eq("reservation_id", reservation_id);
    if (q && q.length > 0) query = query.ilike("guest_name", `%${q}%`);

    const { data, count, error } = await query;
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    const transfers = (data ?? []) as TransferRow[];
    const enrichedResult = await enrichTransfers(supabase, transfers);
    if (enrichedResult.error) {
      return NextResponse.json({ success: false, error: enrichedResult.error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      transfers: enrichedResult.data ?? [],
      total: count ?? 0,
    });
  } catch (err) {
    console.error("transportation/transfers GET failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const json = await request.json().catch(() => null);
    const parsed = transferCreateSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const payload = parsed.data;
    const pickup = new Date(payload.pickup_datetime);
    if (Number.isNaN(pickup.getTime())) {
      return NextResponse.json({ success: false, error: "pickup_datetime is invalid." }, { status: 400 });
    }
    if (pickup.getTime() <= Date.now()) {
      return NextResponse.json({ success: false, error: "pickup_datetime must be in the future." }, { status: 400 });
    }

    const supabase = createServerSupabaseClient();

    const rpcResult = await supabase.rpc("transfer_create_booking", {
      p_reservation_id: payload.reservation_id,
      p_transfer_type: payload.transfer_type,
      p_service_mode: payload.service_mode,
      p_pickup_datetime: payload.pickup_datetime,
      p_pickup_location: payload.pickup_location,
      p_dropoff_location: payload.dropoff_location,
      p_pax: payload.pax,
      p_luggage_count: payload.luggage_count,
      p_driver_id: payload.driver_id ?? null,
      p_vehicle_id: payload.vehicle_id ?? null,
      p_boat_company_id: payload.boat_company_id ?? null,
      p_boat_route_id: payload.boat_route_id ?? null,
      p_selling_price: payload.selling_price ?? null,
      p_cost_price: payload.cost_price ?? null,
      p_driver_fee: payload.driver_fee ?? null,
      p_driver_commission: payload.driver_commission ?? 0,
      p_payment_method: payload.payment_method ?? null,
      p_staff_note: payload.staff_note ?? null,
      p_created_by: payload.created_by ?? null,
    });

    let result: any;
    if (rpcResult.error) {
      if (!shouldUseFallbackCreate(rpcResult.error)) {
        return NextResponse.json({ success: false, error: rpcResult.error.message }, { status: 400 });
      }
      result = await fallbackCreateTransfer(supabase, payload);
    } else {
      result = typeof rpcResult.data === "string" ? JSON.parse(rpcResult.data) : rpcResult.data;
    }

    if (!result?.success) {
      return NextResponse.json({ success: false, error: result?.error ?? "Failed to create transfer." }, { status: 500 });
    }

    const { data: transfer, error: transferError } = await supabase
      .from("transfers")
      .select("*")
      .eq("id", result.transfer_id)
      .maybeSingle();
    if (transferError) {
      return NextResponse.json({ success: false, error: transferError.message }, { status: 500 });
    }

    return NextResponse.json(
      {
        success: true,
        transfer: transfer ?? { id: result.transfer_id },
        voucher_number: result.voucher_number ?? null,
        alert_created: Boolean(result.alert_created),
        trace_created: Boolean(result.trace_created),
        transfer_tx_posted: Boolean(result.transfer_tx_posted),
        commission_created: Boolean(result.commission_created),
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("transportation/transfers POST failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
