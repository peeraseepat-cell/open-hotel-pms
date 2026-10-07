import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireStaffAuth } from "@/lib/server-auth";
import { normalizeAuditSource } from "@/lib/audit-utils";
import {
  getFrontdeskFinancialHistoryCutoff,
  getFrontdeskFinancialHistoryError,
} from "@/lib/financial-history-access";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z.object({
  date_from: z.string().regex(dateRegex, "date_from must be YYYY-MM-DD").optional(),
  date_to: z.string().regex(dateRegex, "date_to must be YYYY-MM-DD").optional(),
  transfer_id: z.string().uuid().optional(),
  guest_profile_id: z.string().uuid().optional(),
  tx_type: z.enum(["charge", "refund", "adjustment"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const createSchema = z.object({
  transfer_id: z.string().uuid(),
  tx_type: z.enum(["charge", "refund", "adjustment"]),
  amount: z.number().positive("amount must be > 0"),
  payment_method: z.enum(["cash", "transfer", "credit_card"]).optional().nullable(),
  cashier_name: z.string().trim().max(120).optional().nullable(),
  note: z.string().trim().max(1000).optional().nullable(),
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
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function assertBusinessDayOpen(
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
    throw new Error("Business day already closed. Use reversal.");
  }
}

export async function GET(request: NextRequest) {
  try {
    const parsed = querySchema.safeParse({
      date_from: request.nextUrl.searchParams.get("date_from") ?? undefined,
      date_to: request.nextUrl.searchParams.get("date_to") ?? undefined,
      transfer_id: request.nextUrl.searchParams.get("transfer_id") ?? undefined,
      guest_profile_id: request.nextUrl.searchParams.get("guest_profile_id") ?? undefined,
      tx_type: request.nextUrl.searchParams.get("tx_type") ?? undefined,
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
      offset: request.nextUrl.searchParams.get("offset") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid query.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { date_from, date_to, transfer_id, guest_profile_id, tx_type, limit, offset } = parsed.data;
    const supabase = createServerSupabaseClient();
    const auth = await requireStaffAuth(supabase, request);
    if (auth.error) return auth.error;
    const today = toBangkokDateString();
    const historyError = getFrontdeskFinancialHistoryError(auth.role, today, [date_from, date_to]);
    if (historyError) {
      return NextResponse.json({ success: false, error: historyError }, { status: 403 });
    }
    const isFrontdesk = auth.role === "frontdesk";
    const effectiveDateFrom = isFrontdesk ? (date_from ?? getFrontdeskFinancialHistoryCutoff(today)) : date_from;
    const effectiveDateTo = isFrontdesk ? (date_to ?? today) : date_to;

    let query = supabase
      .from("transfer_transactions")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (effectiveDateFrom) query = query.gte("transaction_date", effectiveDateFrom);
    if (effectiveDateTo) query = query.lte("transaction_date", effectiveDateTo);
    if (transfer_id) query = query.eq("transfer_id", transfer_id);
    if (guest_profile_id) query = query.eq("guest_profile_id", guest_profile_id);
    if (tx_type) query = query.eq("tx_type", tx_type);

    const { data: rows, error, count } = await query;
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      items: rows ?? [],
      total: count ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    console.error("api/accounting/transfer-transactions GET failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const json = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const payload = parsed.data;
    const note = payload.note?.trim() || null;
    if ((payload.tx_type === "adjustment" || payload.tx_type === "refund") && !note) {
      return NextResponse.json(
        { success: false, error: "note is required when tx_type=adjustment/refund." },
        { status: 400 }
      );
    }
    if ((payload.tx_type === "charge" || payload.tx_type === "refund") && !payload.payment_method) {
      return NextResponse.json(
        { success: false, error: "payment_method is required for charge/refund." },
        { status: 400 }
      );
    }

    const supabase = createServerSupabaseClient();
    const businessDate = toBangkokDateString();
    await assertBusinessDayOpen(supabase, businessDate);

    const { data: transfer, error: transferError } = await supabase
      .from("transfers")
      .select("id, reservation_id, selling_price, cost_price")
      .eq("id", payload.transfer_id)
      .maybeSingle();
    if (transferError) {
      return NextResponse.json({ success: false, error: transferError.message }, { status: 500 });
    }
    if (!transfer) {
      return NextResponse.json({ success: false, error: "Transfer not found." }, { status: 404 });
    }

    const reservationId = String(transfer.reservation_id ?? "");
    let guestProfileId: string | null = null;
    if (reservationId) {
      const { data: reservation, error: reservationError } = await supabase
        .from("reservations")
        .select("guest_profile_id")
        .eq("id", reservationId)
        .maybeSingle();
      if (reservationError) {
        return NextResponse.json({ success: false, error: reservationError.message }, { status: 500 });
      }
      guestProfileId = reservation?.guest_profile_id ? String(reservation.guest_profile_id) : null;
    }

    const sellingPrice = transfer.selling_price === null ? null : Number(transfer.selling_price);
    const costPrice = transfer.cost_price === null ? null : Number(transfer.cost_price);
    const margin =
      sellingPrice === null ? null : costPrice === null ? 0 : Number((sellingPrice - costPrice).toFixed(2));

    const { data: inserted, error: insertError } = await supabase
      .from("transfer_transactions")
      .insert({
        transfer_id: payload.transfer_id,
        reservation_id: reservationId || null,
        guest_profile_id: guestProfileId,
        tx_type: payload.tx_type,
        amount: Number(payload.amount.toFixed(2)),
        selling_price: sellingPrice,
        cost_price: costPrice,
        margin,
        payment_method: payload.payment_method ?? null,
        cashier_name: payload.cashier_name?.trim() || null,
        note,
        transaction_date: businessDate,
      })
      .select("*")
      .maybeSingle();

    if (insertError) {
      return NextResponse.json({ success: false, error: insertError.message }, { status: 500 });
    }

    const { error: auditError } = await supabase.from("audit_logs").insert({
      action: "transfer_transaction_created",
      entity_type: "transfer_transaction",
      entity_id: String(inserted?.id ?? ""),
      after_json: inserted,
      change_reason: payload.tx_type === "adjustment" || payload.tx_type === "refund" ? note : null,
      business_date: businessDate,
      source: normalizeAuditSource("manual"),
    });
    if (auditError) {
      console.error("transfer_transactions audit log insert failed", auditError);
    }

    return NextResponse.json({ success: true, transaction: inserted });
  } catch (err) {
    console.error("api/accounting/transfer-transactions POST failed", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
