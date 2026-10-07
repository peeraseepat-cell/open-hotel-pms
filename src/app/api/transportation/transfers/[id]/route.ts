import { createServerSupabaseClient } from "@/lib/supabase/server";
import { normalizeAuditSource } from "@/lib/audit-utils";
import { DEFAULT_TRANSPORT_ALERT_LEAD_MINUTES, normalizeTransportAlertLeadMinutes } from "@/lib/transport-alert-settings";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type RouteParams = { params: { id: string } };

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

const idSchema = z.string().uuid("Invalid transfer id");

const transferPatchSchema = z
  .object({
    status: z.enum(["confirmed", "driver_assigned", "in_progress", "completed", "cancelled", "no_show"]).optional(),
    pickup_datetime: z.string().trim().min(1).optional(),
    driver_id: z.string().uuid().optional().nullable(),
    vehicle_id: z.string().uuid().optional().nullable(),
    selling_price: z.number().min(0).optional().nullable(),
    cost_price: z.number().min(0).optional().nullable(),
    driver_fee: z.number().min(0).optional().nullable(),
    driver_commission: z.number().min(0).optional().nullable(),
    actual_price: z.number().min(0).optional().nullable(),
    staff_note: z.string().trim().max(2000).optional().nullable(),
    guest_note: z.string().trim().max(2000).optional().nullable(),
    payment_status: z.enum(["unpaid", "paid_to_hotel", "paid_to_driver", "settled"]).optional(),
    payment_method: z.enum(["cash", "transfer", "credit_card"]).optional().nullable(),
    alert_enabled: z.boolean().optional(),
    cancel_reason: z.string().trim().min(1).max(500).optional(),  // ★ Phase 11A: required for cancel
  })
  .refine((value) => Object.keys(value).length > 0, { message: "No updates provided." });

const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  pending: ["confirmed", "driver_assigned", "cancelled"],
  confirmed: ["driver_assigned", "in_progress", "cancelled"],
  driver_assigned: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled", "no_show"],
};

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

function pickupDateInBangkok(pickupIso: string): string {
  const date = new Date(pickupIso);
  if (Number.isNaN(date.getTime())) return pickupIso.slice(0, 10);
  return toBangkokDateString(date);
}

async function assertTransferBusinessDayOpen(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  targetDate: string
) {
  const { data, error } = await supabase
    .from("daily_snapshots")
    .select("business_date")
    .gte("business_date", targetDate)
    .order("business_date", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (data?.business_date) {
    throw new Error("Business day already closed by Night Audit. Use transfer adjustment/reversal.");
  }
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

function formatDateTimeInBangkok(pickupIso: string): string {
  const date = new Date(pickupIso);
  if (Number.isNaN(date.getTime())) return pickupIso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

async function fetchTransportAlertLeadMinutes(
  supabase: ReturnType<typeof createServerSupabaseClient>
): Promise<number> {
  const { data, error } = await supabase
    .from("hotel_settings")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) return DEFAULT_TRANSPORT_ALERT_LEAD_MINUTES;
  return normalizeTransportAlertLeadMinutes(data?.transport_alert_lead_min);
}

function isBoatAlertType(transferType: string): boolean {
  return transferType === "bus_ferry_pickup" || transferType === "ticket_only";
}

async function enrichTransfer(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  transfer: TransferRow
) {
  let driver_name: string | null = null;
  let driver_phone: string | null = null;
  let vehicle_info: string | null = null;
  let boat_company_name: string | null = null;
  let route_description: string | null = null;
  let booking_code: string | null = null;
  let room_number: string | null = null;

  if (transfer.driver_id) {
    const { data, error } = await supabase
      .from("drivers")
      .select("name, phone")
      .eq("id", transfer.driver_id)
      .maybeSingle();
    if (error) return { error };
    if (data) {
      driver_name = data.name ?? null;
      driver_phone = data.phone ?? null;
    }
  }

  if (transfer.vehicle_id) {
    const { data, error } = await supabase
      .from("vehicles")
      .select("vehicle_type, plate_number, color")
      .eq("id", transfer.vehicle_id)
      .maybeSingle();
    if (error) return { error };
    if (data) {
      vehicle_info = [data.vehicle_type, data.plate_number, data.color].filter(Boolean).join(" - ");
    }
  }

  if (transfer.boat_company_id) {
    const { data, error } = await supabase
      .from("boat_companies")
      .select("name")
      .eq("id", transfer.boat_company_id)
      .maybeSingle();
    if (error) return { error };
    boat_company_name = data?.name ?? null;
  }

  if (transfer.boat_route_id) {
    const { data, error } = await supabase
      .from("boat_routes")
      .select("origin, destination")
      .eq("id", transfer.boat_route_id)
      .maybeSingle();
    if (error) return { error };
    if (data) route_description = `${data.origin} -> ${data.destination}`;
  }

  const { data: reservation, error: reservationError } = await supabase
    .from("reservations")
    .select("booking_code")
    .eq("id", transfer.reservation_id)
    .maybeSingle();
  if (reservationError) return { error: reservationError };
  booking_code = reservation?.booking_code ?? null;

  const pickupDate = pickupDateInBangkok(transfer.pickup_datetime);
  const { data: nights, error: nightError } = await supabase
    .from("reservation_nights")
    .select("stay_date, rooms:room_id(room_number)")
    .eq("reservation_id", transfer.reservation_id)
    .lte("stay_date", pickupDate)
    .is("cancelled_at", null)
    .order("stay_date", { ascending: false })
    .limit(20);
  if (nightError) return { error: nightError };
  const nightRows = (nights ?? []) as any[];
  const exact = nightRows.find((n) => String(n.stay_date) === pickupDate) ?? null;
  const target = exact ?? nightRows[0] ?? null;
  const roomRef = Array.isArray(target?.rooms) ? target.rooms[0] : target?.rooms;
  room_number = roomRef?.room_number ? String(roomRef.room_number) : null;

  const { data: voucher, error: voucherError } = await supabase
    .from("transfer_vouchers")
    .select("*")
    .eq("transfer_id", transfer.id)
    .maybeSingle();
  if (voucherError) return { error: voucherError };

  return {
    data: {
      transfer: {
        ...transfer,
        driver_name,
        driver_phone,
        vehicle_info,
        boat_company_name,
        route_description,
        booking_code,
        room_number,
      },
      voucher: voucher ?? null,
    },
  };
}

async function rebuildAlertNoteForCode(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  reservationId: string,
  alertCode: "BOAT" | "CAR"
) {
  const { data: activeTransfers, error: activeTransfersError } = await supabase
    .from("transfers")
    .select("id, transfer_type, pickup_datetime")
    .eq("reservation_id", reservationId)
    .not("status", "in", "(completed,cancelled)");

  if (activeTransfersError) throw new Error(activeTransfersError.message);

  const sameCodeTransfers = (activeTransfers ?? []).filter((row: any) => {
    const transferType = String(row.transfer_type ?? "");
    const code = isBoatAlertType(transferType) ? "BOAT" : "CAR";
    return code === alertCode;
  });

  if (sameCodeTransfers.length === 0) {
    const { error } = await supabase
      .from("reservation_alerts")
      .delete()
      .eq("reservation_id", reservationId)
      .eq("alert_code", alertCode);
    if (error) throw new Error(error.message);
    return;
  }

  const transferIds = sameCodeTransfers.map((row: any) => String(row.id));
  const { data: vouchers, error: vouchersError } = await supabase
    .from("transfer_vouchers")
    .select("transfer_id, voucher_number")
    .in("transfer_id", transferIds);
  if (vouchersError) throw new Error(vouchersError.message);

  const voucherByTransferId = new Map<string, string>();
  for (const row of vouchers ?? []) {
    voucherByTransferId.set(String(row.transfer_id), String(row.voucher_number));
  }

  const lines = sameCodeTransfers
    .map((row: any) => {
      const transferId = String(row.id);
      const voucher = voucherByTransferId.get(transferId) ?? "TRF";
      const pickupTime = pickupTimeInBangkok(String(row.pickup_datetime));
      return `[${voucher}] ${pickupTime}`;
    })
    .sort();

  const note = lines.join("\n");
  const { data: existingAlert, error: existingAlertError } = await supabase
    .from("reservation_alerts")
    .select("id")
    .eq("reservation_id", reservationId)
    .eq("alert_code", alertCode)
    .maybeSingle();
  if (existingAlertError) throw new Error(existingAlertError.message);

  if (!existingAlert) {
    const { error } = await supabase.from("reservation_alerts").insert({
      reservation_id: reservationId,
      alert_code: alertCode,
      note,
    });
    if (error) throw new Error(error.message);
    return;
  }

  const { error } = await supabase.from("reservation_alerts").update({ note }).eq("id", existingAlert.id);
  if (error) throw new Error(error.message);
}

async function incrementDriverTripCount(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  driverId: string
) {
  const rpcResult = await supabase.rpc("increment_driver_total_trips", {
    p_driver_id: driverId,
  });
  if (!rpcResult.error) return;
  if (rpcResult.error.code !== "42883") {
    throw new Error(rpcResult.error.message);
  }

  // Fallback for environments that have not applied the new RPC migration yet.
  const { data: driver, error: driverError } = await supabase
    .from("drivers")
    .select("total_trips")
    .eq("id", driverId)
    .maybeSingle();
  if (driverError) throw new Error(driverError.message);
  if (!driver) throw new Error("Driver not found.");

  const currentTrips = Number(driver.total_trips ?? 0);
  const { error: updateError } = await supabase
    .from("drivers")
    .update({ total_trips: currentTrips + 1 })
    .eq("id", driverId);
  if (updateError) throw new Error(updateError.message);
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const parsedId = idSchema.safeParse(params.id);
    if (!parsedId.success) {
      return NextResponse.json(
        { success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id." },
        { status: 400 }
      );
    }

    const supabase = createServerSupabaseClient();
    const { data: transfer, error } = await supabase
      .from("transfers")
      .select("*")
      .eq("id", parsedId.data)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    if (!transfer) {
      return NextResponse.json({ success: false, error: "Transfer not found." }, { status: 404 });
    }

    const enriched = await enrichTransfer(supabase, transfer as TransferRow);
    if (enriched.error) {
      return NextResponse.json({ success: false, error: enriched.error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, ...enriched.data });
  } catch (err) {
    console.error("transportation/transfers/:id GET failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const parsedId = idSchema.safeParse(params.id);
    if (!parsedId.success) {
      return NextResponse.json(
        { success: false, error: parsedId.error.issues[0]?.message ?? "Invalid id." },
        { status: 400 }
      );
    }
    const transferId = parsedId.data;

    const json = await request.json().catch(() => null);
    const parsed = transferPatchSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const supabase = createServerSupabaseClient();
    const { data: current, error: currentError } = await supabase
      .from("transfers")
      .select("*")
      .eq("id", transferId)
      .maybeSingle();
    if (currentError) {
      return NextResponse.json({ success: false, error: currentError.message }, { status: 500 });
    }
    if (!current) {
      return NextResponse.json({ success: false, error: "Transfer not found." }, { status: 404 });
    }

    const payload = parsed.data;
    const updates: Record<string, unknown> = {};
    let effectivePickupDatetime = String(current.pickup_datetime);

    if (payload.pickup_datetime !== undefined) {
      const pickup = new Date(payload.pickup_datetime);
      if (Number.isNaN(pickup.getTime())) {
        return NextResponse.json({ success: false, error: "pickup_datetime is invalid." }, { status: 400 });
      }
      effectivePickupDatetime = pickup.toISOString();
      updates.pickup_datetime = effectivePickupDatetime;
    }

    if (payload.status && payload.status !== current.status) {
      const allowed = VALID_STATUS_TRANSITIONS[String(current.status)];
      if (!allowed || !allowed.includes(payload.status)) {
        return NextResponse.json(
          { success: false, error: `Cannot transition from '${current.status}' to '${payload.status}'.` },
          { status: 400 }
        );
      }
      // ★ Phase 11A: cancel requires reason
      if (payload.status === "cancelled" && !payload.cancel_reason) {
        return NextResponse.json(
          { success: false, error: "cancel_reason is required when cancelling a transfer." },
          { status: 400 }
        );
      }
      updates.status = payload.status;
    }

    if (payload.driver_id !== undefined) {
      if (payload.driver_id) {
        const { data: driver, error: driverError } = await supabase
          .from("drivers")
          .select("id")
          .eq("id", payload.driver_id)
          .maybeSingle();
        if (driverError) {
          return NextResponse.json({ success: false, error: driverError.message }, { status: 500 });
        }
        if (!driver) {
          return NextResponse.json({ success: false, error: "driver_id not found." }, { status: 400 });
        }
      }
      updates.driver_id = payload.driver_id ?? null;
      if (!updates.status && payload.driver_id && (current.status === "pending" || current.status === "confirmed")) {
        updates.status = "driver_assigned";
      }
    }

    if (payload.vehicle_id !== undefined) {
      if (payload.vehicle_id) {
        const { data: vehicle, error: vehicleError } = await supabase
          .from("vehicles")
          .select("id")
          .eq("id", payload.vehicle_id)
          .maybeSingle();
        if (vehicleError) {
          return NextResponse.json({ success: false, error: vehicleError.message }, { status: 500 });
        }
        if (!vehicle) {
          return NextResponse.json({ success: false, error: "vehicle_id not found." }, { status: 400 });
        }
      }
      updates.vehicle_id = payload.vehicle_id ?? null;
    }

    if (payload.selling_price !== undefined) updates.selling_price = payload.selling_price;
    if (payload.cost_price !== undefined) updates.cost_price = payload.cost_price;
    if (payload.driver_fee !== undefined) updates.driver_fee = payload.driver_fee;
    if (payload.driver_commission !== undefined) updates.driver_commission = payload.driver_commission ?? 0;
    if (payload.actual_price !== undefined) updates.actual_price = payload.actual_price;
    if (payload.staff_note !== undefined) updates.staff_note = payload.staff_note ?? null;
    if (payload.guest_note !== undefined) updates.guest_note = payload.guest_note ?? null;
    if (payload.payment_status !== undefined) updates.payment_status = payload.payment_status;
    if (payload.payment_method !== undefined) updates.payment_method = payload.payment_method ?? null;
    if (payload.alert_enabled !== undefined) {
      const pickupMs = new Date(effectivePickupDatetime).getTime();
      if (Number.isNaN(pickupMs)) {
        return NextResponse.json({ success: false, error: "pickup_datetime is invalid." }, { status: 400 });
      }
      const transportAlertLeadMinutes = await fetchTransportAlertLeadMinutes(supabase);
      const earliestToggleMs = pickupMs - transportAlertLeadMinutes * 60 * 1000;
      if (Date.now() < earliestToggleMs) {
        return NextResponse.json(
          {
            success: false,
            error: `Alert switch is allowed only within ${transportAlertLeadMinutes} minutes before pickup (earliest ${formatDateTimeInBangkok(
              new Date(earliestToggleMs).toISOString()
            )} Asia/Bangkok).`,
          },
          { status: 400 }
        );
      }
      updates.alert_enabled = payload.alert_enabled;
    }

    const nextStatus = String(updates.status ?? current.status);
    const nextPaymentStatus = String(updates.payment_status ?? current.payment_status);
    const nextPaymentMethod = ("payment_method" in updates ? updates.payment_method : current.payment_method ?? null) as string | null;
    if (nextPaymentStatus === "paid_to_hotel" && !nextPaymentMethod) {
      return NextResponse.json(
        { success: false, error: "payment_method is required when payment_status is paid_to_hotel." },
        { status: 400 }
      );
    }
    if (String(current.status) !== "in_progress" && nextStatus === "in_progress") {
      const pickupMs = new Date(effectivePickupDatetime).getTime();
      if (Number.isNaN(pickupMs)) {
        return NextResponse.json({ success: false, error: "pickup_datetime is invalid." }, { status: 400 });
      }
      const earliestInProgressMs = pickupMs - 30 * 60 * 1000;
      if (Date.now() < earliestInProgressMs) {
        return NextResponse.json(
          {
            success: false,
            error: `In progress is allowed only within 30 minutes before pickup (earliest ${formatDateTimeInBangkok(
              new Date(earliestInProgressMs).toISOString()
            )} Asia/Bangkok). Edit pickup time if schedule changed.`,
          },
          { status: 400 }
        );
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ success: false, error: "No updates provided." }, { status: 400 });
    }

    try {
      await assertTransferBusinessDayOpen(supabase, pickupDateInBangkok(String(current.pickup_datetime)));
      await assertTransferBusinessDayOpen(supabase, pickupDateInBangkok(effectivePickupDatetime));
    } catch (closedError) {
      const message = closedError instanceof Error ? closedError.message : "Business day already closed by Night Audit.";
      return NextResponse.json({ success: false, error: message }, { status: 409 });
    }

    const touchesMoney = ["selling_price", "cost_price", "driver_fee", "driver_commission", "payment_status", "payment_method"]
      .some((key) => Object.prototype.hasOwnProperty.call(updates, key));
    const isCancelRequest = updates.status === "cancelled";
    let updated: TransferRow;
    if (touchesMoney || isCancelRequest) {
      let voucherNumber: string | null = null;
      if (isCancelRequest) {
        const { data: voucher, error } = await supabase.from("transfer_vouchers")
          .select("voucher_number").eq("transfer_id", transferId).maybeSingle();
        if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
        voucherNumber = voucher?.voucher_number ?? null;
      }
      const { data, error } = await supabase.rpc("transfer_write_atomic", {
        p_transfer_id: transferId,
        p_patch: updates,
        p_cancel_reason: isCancelRequest ? payload.cancel_reason ?? null : null,
        p_cancel_voucher_number: voucherNumber,
      });
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      const result = typeof data === "string" ? JSON.parse(data) : data;
      if (!result?.found) return NextResponse.json({ success: false, error: "Transfer not found." }, { status: 404 });
      if (result.invalid === "payment_method_required") {
        return NextResponse.json({ success: false, error: "payment_method is required when payment_status is paid_to_hotel." }, { status: 400 });
      }
      updated = result.transfer as TransferRow;
    } else {
      const { data, error } = await supabase.from("transfers")
        .update(updates).eq("id", transferId).select("*").maybeSingle();
      if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
      if (!data) return NextResponse.json({ success: false, error: "Transfer not found." }, { status: 404 });
      updated = data as TransferRow;
    }

    const changedFields = Object.keys(updates);
    const { error: auditError } = await supabase.from("audit_logs").insert({
      action: "transfer_updated",
      entity_type: "transfer",
      entity_id: transferId,
      before_json: current,
      after_json: {
        ...updated,
        changed_fields: changedFields,
      },
      change_reason: payload.cancel_reason ?? null,  // ★ Phase 11A
      business_date: toBangkokDateString(),
      source: normalizeAuditSource("manual"),
    });
    if (auditError) {
      console.error("transport transfer audit_logs insert failed", auditError);
    }

    const oldStatus = String(current.status);
    const newStatus = String(updated.status);
    const becameCompleted = oldStatus !== "completed" && newStatus === "completed";
    const becameCancelled = oldStatus !== "cancelled" && newStatus === "cancelled";
    const pickupChanged = String(current.pickup_datetime) !== String(updated.pickup_datetime);
    const noteChanged = String(current.staff_note ?? "") !== String(updated.staff_note ?? "");
    if (pickupChanged || noteChanged) {
      const voucherUpdates: Record<string, unknown> = {};
      if (pickupChanged) {
        voucherUpdates.pickup_time = pickupTimeInBangkok(String(updated.pickup_datetime));
      }
      if (noteChanged) {
        voucherUpdates.special_instructions = updated.staff_note ?? null;
      }
      if (Object.keys(voucherUpdates).length > 0) {
        const { error: voucherUpdateError } = await supabase
          .from("transfer_vouchers")
          .update(voucherUpdates)
          .eq("transfer_id", transferId);
        if (voucherUpdateError) {
          return NextResponse.json({ success: false, error: voucherUpdateError.message }, { status: 500 });
        }
      }
    }

    const effectiveDriverId = (updated.driver_id ?? current.driver_id) as string | null;
    if (becameCompleted && effectiveDriverId) {
      try {
        await incrementDriverTripCount(supabase, effectiveDriverId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to increment driver trip count.";
        return NextResponse.json({ success: false, error: message }, { status: 500 });
      }
    }

    if (becameCancelled) {
      const alertCode = isBoatAlertType(String(current.transfer_type)) ? "BOAT" : "CAR";
      await rebuildAlertNoteForCode(supabase, String(current.reservation_id), alertCode);

      const { data: voucher, error: voucherError } = await supabase
        .from("transfer_vouchers")
        .select("voucher_number")
        .eq("transfer_id", transferId)
        .maybeSingle();
      if (voucherError) {
        return NextResponse.json({ success: false, error: voucherError.message }, { status: 500 });
      }

      if (voucher?.voucher_number) {
        const { error: traceError } = await supabase
          .from("reservation_traces")
          .update({
            status: "done",
            resolved_at: new Date().toISOString(),
            resolved_by: "Transfer cancel",
          })
          .eq("reservation_id", current.reservation_id)
          .ilike("trace_text", `%${voucher.voucher_number}%`);
        if (traceError) {
          return NextResponse.json({ success: false, error: traceError.message }, { status: 500 });
        }
      }


    }

    if (pickupChanged && String(updated.status) !== "cancelled" && String(updated.status) !== "completed") {
      const alertCode = isBoatAlertType(String(updated.transfer_type)) ? "BOAT" : "CAR";
      await rebuildAlertNoteForCode(supabase, String(updated.reservation_id), alertCode);
    }

    return NextResponse.json({ success: true, transfer: updated });
  } catch (err) {
    console.error("transportation/transfers/:id PATCH failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
