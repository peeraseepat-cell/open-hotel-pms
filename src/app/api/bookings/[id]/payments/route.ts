import {
    assertBusinessDayOpen,
    computeFeeSummary,
    normalizePaymentMethod,
    resolveBusinessDate,
} from "@/lib/folio-fees";
import {
    buildDepositSnapshotNote,
    computeHeldDepositFromRows,
    extractDepositGeneralNote,
} from "@/lib/deposit-ledger";
import { resolveHotelCheckOutTime, resolveLinkedStay } from "@/lib/linked-stay";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireStaffAuth } from "@/lib/server-auth";
import { fromSatang, toSatang } from "@/lib/money";
import { parseManualTransferDetail } from "@/lib/transfer-detail";
import { buildTransferAuditNote } from "@/lib/transfer-audit";
import { getExactTransferDepositSplit } from "@/lib/transfer-deposit-split";
import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";

const TX_TYPES = new Set(["payment", "refund", "deposit"]);

type RouteParams = { params: { id: string } };

type ReservationPaymentTarget = {
    id: string;
    status: string | null;
    checked_in_at: string | null;
    total_price: number | string | null;
    deposit_amount: number | string | null;
    deposit_note: string | null;
    folio_reopened: boolean;
};

type PaymentRow = {
    id: string;
    tx_type: "payment" | "refund" | "deposit";
    method: "cash" | "transfer" | "credit_card" | "other";
    amount: number | string;
    note: string | null;
    paid_at: string;
    paid_date: string;
    created_at: string;
    revenue_category?: string | null;
    fee_template_code?: string | null;
    is_record_only?: boolean | null;
    extra_fee_templates?: {
        code: string;
        name: string;
        icon: string | null;
        category: string;
    } | null;
};

function isMissingFeeRelationError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
    if (!error) return false;
    const code = String(error.code ?? "").toUpperCase();
    if (code === "42P01" || code === "42703" || code === "PGRST200" || code === "PGRST204") return true;
    const message = String(error.message ?? "").toLowerCase();
    return (
        message.includes("extra_fee_templates")
        || message.includes("fee_template_code")
        || (message.includes("relation") && message.includes("does not exist"))
        || (message.includes("column") && message.includes("does not exist"))
        || message.includes("could not find a relationship")
    );
}

function isMissingReservationFolioReopenedError(error: { message?: string | null } | null | undefined): boolean {
    if (!error) return false;
    const message = String(error.message ?? "").toLowerCase();
    return message.includes("folio_reopened");
}

function toNumber(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
}

function parseTransferDepositSplitAmount(input: unknown): number | null {
    if (!input || typeof input !== "object") return null;
    const raw = (input as { deposit_amount?: unknown }).deposit_amount;
    const satang = toSatang(raw);
    if (satang <= 0) return null;
    return fromSatang(satang);
}

function normalizePaymentRows(rows: any[]): PaymentRow[] {
    return rows.map((row) => {
        const templateValue = Array.isArray(row.extra_fee_templates)
            ? row.extra_fee_templates[0] ?? null
            : row.extra_fee_templates ?? null;

        return {
            id: String(row.id ?? ""),
            tx_type: row.tx_type,
            method: row.method,
            amount: row.amount,
            note: row.note ?? null,
            paid_at: row.paid_at,
            paid_date: row.paid_date,
            created_at: row.created_at,
            revenue_category: row.revenue_category ?? null,
            fee_template_code: row.fee_template_code ?? null,
            is_record_only: row.is_record_only ?? false,
            extra_fee_templates: templateValue
                ? {
                    code: String(templateValue.code ?? ""),
                    name: String(templateValue.name ?? ""),
                    icon: templateValue.icon ?? null,
                    category: String(templateValue.category ?? ""),
                }
                : null,
        };
    });
}

async function fetchPaymentRowsWithOptionalFeeFields(supabase: ReturnType<typeof createServerSupabaseClient>, reservationId: string): Promise<PaymentRow[]> {
    const richSelect = `
                id,
                tx_type,
                method,
                amount,
                note,
                paid_at,
                paid_date,
                created_at,
                revenue_category,
                fee_template_code,
                is_record_only,
                extra_fee_templates(code, name, icon, category)
            `;

    const baseSelect = `
                id,
                tx_type,
                method,
                amount,
                note,
                paid_at,
                paid_date,
                created_at,
                revenue_category,
                is_record_only
            `;

    const richRes = await supabase
        .from("folio_payments")
        .select(richSelect)
        .eq("reservation_id", reservationId)
        .order("paid_at", { ascending: false })
        .order("created_at", { ascending: false });

    if (!richRes.error) {
        return normalizePaymentRows(richRes.data ?? []);
    }

    if (!isMissingFeeRelationError(richRes.error)) {
        throw new Error(richRes.error.message);
    }

    const baseRes = await supabase
        .from("folio_payments")
        .select(baseSelect)
        .eq("reservation_id", reservationId)
        .order("paid_at", { ascending: false })
        .order("created_at", { ascending: false });

    if (baseRes.error) {
        throw new Error(baseRes.error.message);
    }

    const rows = (baseRes.data ?? []).map((row: any) => ({
        ...row,
        fee_template_code: null,
        extra_fee_templates: null,
    }));
    return normalizePaymentRows(rows);
}

async function loadReservationPaymentTarget(
    supabase: ReturnType<typeof createServerSupabaseClient>,
    reservationId: string
): Promise<ReservationPaymentTarget | null> {
    const withFolioReopened = await supabase
        .from("reservations")
        .select("id, status, checked_in_at, total_price, deposit_amount, deposit_note, folio_reopened")
        .eq("id", reservationId)
        .maybeSingle();

    if (!withFolioReopened.error) {
        if (!withFolioReopened.data) return null;
        return {
            id: String(withFolioReopened.data.id),
            status: withFolioReopened.data.status ?? null,
            checked_in_at: withFolioReopened.data.checked_in_at ?? null,
            total_price: withFolioReopened.data.total_price ?? 0,
            deposit_amount: withFolioReopened.data.deposit_amount ?? 0,
            deposit_note: withFolioReopened.data.deposit_note ?? null,
            folio_reopened: Boolean(withFolioReopened.data.folio_reopened ?? false),
        };
    }

    if (!isMissingReservationFolioReopenedError(withFolioReopened.error)) {
        throw new Error(withFolioReopened.error.message);
    }

    const fallback = await supabase
        .from("reservations")
        .select("id, status, checked_in_at, total_price, deposit_amount, deposit_note")
        .eq("id", reservationId)
        .maybeSingle();
    if (fallback.error) {
        throw new Error(fallback.error.message);
    }
    if (!fallback.data) return null;

    return {
        id: String(fallback.data.id),
        status: fallback.data.status ?? null,
        checked_in_at: fallback.data.checked_in_at ?? null,
        total_price: fallback.data.total_price ?? 0,
        deposit_amount: fallback.data.deposit_amount ?? 0,
        deposit_note: fallback.data.deposit_note ?? null,
        folio_reopened: false,
    };
}

async function resolveLinkedActiveReservationId(
    supabase: ReturnType<typeof createServerSupabaseClient>,
    reservationId: string
): Promise<string | null> {
    try {
        const checkOutTime = await resolveHotelCheckOutTime(supabase as any, "12:00");
        const linkedStay = await resolveLinkedStay(supabase as any, reservationId, checkOutTime);
        const activeId = String(linkedStay?.active_segment_id ?? "").trim();
        if (!activeId || activeId === reservationId) return null;
        return activeId;
    } catch {
        return null;
    }
}

export async function GET(request: NextRequest, { params }: RouteParams) {
    noStore();
    try {
        const reservationId = params.id;
        if (!reservationId) {
            return NextResponse.json({ error: "Missing reservation id." }, { status: 400 });
        }

        const supabase = createServerSupabaseClient();
        const auth = await requireStaffAuth(supabase, request, { denyRoles: [] });
        if (auth.error) return auth.error;

        const { data: reservation, error: reservationError } = await supabase
            .from("reservations")
            .select("id, total_price, deposit_amount, deposit_note, deposit_paid_at")
            .eq("id", reservationId)
            .maybeSingle();

        if (reservationError) {
            return NextResponse.json({ error: reservationError.message }, { status: 500 });
        }
        if (!reservation) {
            return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
        }

        const payments = await fetchPaymentRowsWithOptionalFeeFields(supabase, reservationId);
        const mergedPayments = [...payments].sort((a, b) => {
            const left = Date.parse(String(b.paid_at ?? ""));
            const right = Date.parse(String(a.paid_at ?? ""));
            if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
            return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
        });
        const summary = computeFeeSummary(
            toNumber(reservation.total_price),
            toNumber(reservation.deposit_amount),
            mergedPayments
        );

        return NextResponse.json({
            success: true,
            reservation_id: reservationId,
            payments: mergedPayments,
            summary: {
                ...summary,
                total_price: summary.room_charges_total,
            }
        });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
    try {
        const supabase = createServerSupabaseClient();
        const auth = await requireStaffAuth(supabase, request);
        if (auth.error) return auth.error;

        const requestedReservationId = params.id;
        if (!requestedReservationId) {
            return NextResponse.json({ error: "Missing reservation id." }, { status: 400 });
        }

        const body = await request.json().catch(() => ({}));
        const txType = String(body.tx_type ?? "payment");
        const methodRaw = String(body.method ?? "cash");
        const method = normalizePaymentMethod(methodRaw);
        const amountSatang = toSatang(body.amount);
        const amount = fromSatang(amountSatang);
        const note = body.note ? String(body.note) : null;
        const isRecordOnly = body.is_record_only === true;
        const transferDetailRequired = body.require_transfer_detail === true;
        const transferDetailInput = body.transfer_detail;
        const shouldCreateTransferEvent = method === "transfer" && (transferDetailRequired || transferDetailInput != null);
        const transferDepositSplitInput = body.transfer_deposit_split;
        const transferDepositSplitAmount = parseTransferDepositSplitAmount(transferDepositSplitInput);
        const cashierName =
            typeof body.cashier_name === "string" && body.cashier_name.trim().length > 0
                ? body.cashier_name.trim()
                : "FO";
        const allowDuringCheckin = body.allow_during_checkin === true;

        if (!TX_TYPES.has(txType)) {
            return NextResponse.json({ error: "Invalid tx_type." }, { status: 400 });
        }
        if (!method) {
            return NextResponse.json({ error: "Invalid method." }, { status: 400 });
        }
        if (!Number.isFinite(amount) || amountSatang <= 0) {
            return NextResponse.json({ error: "amount must be > 0." }, { status: 400 });
        }
        if (method !== "transfer" && transferDetailInput != null) {
            return NextResponse.json({ error: "Transfer detail can only be used with transfer method." }, { status: 400 });
        }
        if (transferDepositSplitInput != null && transferDepositSplitAmount === null) {
            return NextResponse.json({ error: "transfer_deposit_split.deposit_amount must be > 0." }, { status: 400 });
        }
        if (transferDepositSplitAmount !== null && (method !== "transfer" || !shouldCreateTransferEvent)) {
            return NextResponse.json({ error: "Transfer deposit split requires transfer detail." }, { status: 400 });
        }
        if (transferDepositSplitAmount !== null && (txType !== "payment" || isRecordOnly)) {
            return NextResponse.json({ error: "Transfer deposit split is only allowed for normal transfer payments." }, { status: 400 });
        }

        let effectiveReservationId = requestedReservationId;
        let reservation: ReservationPaymentTarget | null = null;

        try {
            reservation = await loadReservationPaymentTarget(supabase, effectiveReservationId);
        } catch (reservationLoadError) {
            const message = reservationLoadError instanceof Error ? reservationLoadError.message : "Failed to load reservation.";
            return NextResponse.json({ error: message }, { status: 500 });
        }
        if (!reservation) {
            return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
        }

        if (reservation.status === "checked_out" && !reservation.folio_reopened) {
            const linkedActiveId = await resolveLinkedActiveReservationId(supabase, effectiveReservationId);
            if (linkedActiveId) {
                try {
                    const activeReservation = await loadReservationPaymentTarget(supabase, linkedActiveId);
                    if (activeReservation) {
                        effectiveReservationId = linkedActiveId;
                        reservation = activeReservation;
                    }
                } catch {
                    // keep original guard behavior below
                }
            }

            if (reservation.status === "checked_out" && !reservation.folio_reopened) {
                return NextResponse.json(
                    { success: false, error: "Reservation is checked out. Reopen folio first." },
                    { status: 400 }
                );
            }
        }

        if (
            txType === "deposit" &&
            (reservation.status !== "active" || (!reservation.checked_in_at && !allowDuringCheckin))
        ) {
            return NextResponse.json(
                { error: "Deposit is locked before check-in. Use pre-payment until guest is checked in." },
                { status: 409 }
            );
        }

        const businessDate = await resolveBusinessDate(supabase);
        try {
            await assertBusinessDayOpen(supabase, businessDate);
        } catch (guardError) {
            const message = guardError instanceof Error ? guardError.message : "Business day already closed.";
            return NextResponse.json({ error: message }, { status: 400 });
        }

        const revenueCategory = txType === "deposit" ? "deposit" : "room_revenue";
        const paidAt = new Date().toISOString();
        let transferEventId: string | null = null;
        let shouldSyncDepositSnapshot = txType === "deposit";

        if (shouldCreateTransferEvent) {
            const parsedTransfer = parseManualTransferDetail(transferDetailInput);
            if (!parsedTransfer.ok) {
                return NextResponse.json({ error: parsedTransfer.error }, { status: 400 });
            }

            const exactDepositSplit = transferDepositSplitAmount !== null
                ? getExactTransferDepositSplit({
                    folioAmount: amount,
                    actualTransferAmount: parsedTransfer.value.actualAmount,
                    depositTargetAmount: transferDepositSplitAmount,
                })
                : { ok: false as const };
            if (transferDepositSplitAmount !== null && !exactDepositSplit.ok) {
                return NextResponse.json(
                    { error: "Transfer deposit split requires actual transfer amount to equal payment amount plus deposit amount." },
                    { status: 400 }
                );
            }

            const { data: transferCreateRows, error: transferCreateError } = exactDepositSplit.ok
                ? await supabase.rpc(
                    "create_manual_transfer_payment_with_deposit_split",
                    {
                        p_reservation_id: effectiveReservationId,
                        p_folio_amount: exactDepositSplit.folioAmount,
                        p_deposit_amount: exactDepositSplit.depositAmount,
                        p_folio_note: note,
                        p_cashier_name: cashierName,
                        p_paid_date: businessDate,
                        p_paid_at: paidAt,
                        p_recorded_by: auth.user?.id ?? null,
                        p_actual_amount: exactDepositSplit.actualTransferAmount,
                        p_sender_name: parsedTransfer.value.senderName,
                        p_bank_ref: parsedTransfer.value.bankRef,
                        p_transfer_at: parsedTransfer.value.transferAt,
                        p_transfer_note: parsedTransfer.value.note,
                    }
                )
                : await supabase.rpc(
                    "create_manual_transfer_payment",
                    {
                        p_reservation_id: effectiveReservationId,
                        p_tx_type: txType,
                        p_method: method,
                        p_folio_amount: amount,
                        p_folio_note: note,
                        p_revenue_category: revenueCategory,
                        p_cashier_name: cashierName,
                        p_is_record_only: isRecordOnly,
                        p_paid_date: businessDate,
                        p_paid_at: paidAt,
                        p_recorded_by: auth.user?.id ?? null,
                        p_actual_amount: parsedTransfer.value.actualAmount,
                        p_sender_name: parsedTransfer.value.senderName,
                        p_bank_ref: parsedTransfer.value.bankRef,
                        p_transfer_at: parsedTransfer.value.transferAt,
                        p_transfer_note: parsedTransfer.value.note,
                    }
                );

            if (transferCreateError) {
                return NextResponse.json({ error: transferCreateError.message }, { status: 500 });
            }

            const created = Array.isArray(transferCreateRows) ? transferCreateRows[0] : null;
            const paymentId = typeof created?.payment_id === "string"
                ? created.payment_id
                : null;
            const depositPaymentId = typeof created?.deposit_payment_id === "string"
                ? created.deposit_payment_id
                : null;
            transferEventId = typeof created?.transfer_event_id === "string"
                ? created.transfer_event_id
                : null;
            if (paymentId && transferEventId) {
                const totalAmount = exactDepositSplit.ok
                    ? exactDepositSplit.actualTransferAmount
                    : amount;
                const syncedNote = buildTransferAuditNote({
                    transferAt: parsedTransfer.value.transferAt,
                    senderName: parsedTransfer.value.senderName,
                    bankRef: parsedTransfer.value.bankRef,
                    fallbackLabel: null,
                    totalAmount,
                });
                const syncedIds = depositPaymentId ? [paymentId, depositPaymentId] : [paymentId];
                const { error: syncNoteError } = await supabase
                    .from("folio_payments")
                    .update({
                        note: syncedNote,
                        transfer_audit_original_note: note,
                    })
                    .in("id", syncedIds);
                if (syncNoteError) {
                    return NextResponse.json({ error: syncNoteError.message }, { status: 500 });
                }
                if (depositPaymentId) {
                    shouldSyncDepositSnapshot = true;
                }
            }
        } else {
            const { error: insertError } = await supabase
                .from("folio_payments")
                .insert({
                    reservation_id: effectiveReservationId,
                    tx_type: txType,
                    method,
                    amount,
                    note,
                    revenue_category: revenueCategory,
                    cashier_name: cashierName,
                    is_record_only: isRecordOnly,
                    paid_date: businessDate,
                    paid_at: paidAt
                });

            if (insertError) {
                return NextResponse.json({ error: insertError.message }, { status: 500 });
            }
        }

        if (shouldSyncDepositSnapshot) {
            const { data: depositRows, error: depositRowsError } = await supabase
                .from("folio_payments")
                .select("method, amount, note, paid_at, tx_type, revenue_category")
                .eq("reservation_id", effectiveReservationId)
                .eq("revenue_category", "deposit")
                .order("paid_at", { ascending: true });

            if (depositRowsError) {
                return NextResponse.json({ error: depositRowsError.message }, { status: 500 });
            }

            const generalNote = extractDepositGeneralNote(reservation.deposit_note);
            const netByMethod = new Map<string, { method: string; amount: number; note: string | null }>();
            for (const row of depositRows ?? []) {
                const method = String(row.method ?? "other");
                const current = netByMethod.get(method) ?? { method, amount: 0, note: null };
                const amount = fromSatang(toSatang(row.amount ?? 0));
                if (row.tx_type === "deposit" || row.tx_type === "payment") current.amount += amount;
                else if (row.tx_type === "refund") current.amount -= amount;
                if (!current.note && typeof row.note === "string" && row.note.trim()) {
                    current.note = row.note.trim();
                }
                netByMethod.set(method, current);
            }
            const lines = Array.from(netByMethod.values()).filter((line) => line.amount > 0);
            const nextDepositAmount = computeHeldDepositFromRows(depositRows ?? []);
            const nextPaidAt =
                (depositRows ?? []).some((row: any) => row.tx_type === "deposit" || row.tx_type === "payment")
                    ? String(
                        [...(depositRows ?? [])]
                            .filter((row: any) => row.tx_type === "deposit" || row.tx_type === "payment")
                            .slice(-1)[0]?.paid_at ?? new Date().toISOString()
                    )
                    : null;
            const nextDepositNote = buildDepositSnapshotNote(
                lines,
                nextDepositAmount > 0 ? null : generalNote
            );

            const { error: syncReservationDepositError } = await supabase
                .from("reservations")
                .update({
                    deposit_amount: nextDepositAmount,
                    deposit_paid_at: nextPaidAt,
                    deposit_note: nextDepositNote,
                    updated_at: new Date().toISOString(),
                })
                .eq("id", effectiveReservationId);

            if (syncReservationDepositError) {
                return NextResponse.json({ error: syncReservationDepositError.message }, { status: 500 });
            }
        }

        const payments = await fetchPaymentRowsWithOptionalFeeFields(supabase, effectiveReservationId);
        const refreshedReservation =
            shouldSyncDepositSnapshot
                ? await supabase
                    .from("reservations")
                    .select("total_price, deposit_amount")
                    .eq("id", effectiveReservationId)
                    .maybeSingle()
                : null;
        const inserted = payments[0] ?? null;
        const summary = computeFeeSummary(
            toNumber(refreshedReservation?.data?.total_price ?? reservation.total_price),
            toNumber(refreshedReservation?.data?.deposit_amount ?? reservation.deposit_amount),
            payments
        );

        if (txType === "payment" && !isRecordOnly) {
            try {
                await supabase.rpc("alert_auto_clear_by_payment", {
                    p_booking_id: effectiveReservationId,
                });
            } catch (alertError) {
                console.error("[alerts] auto-clear failed", alertError);
            }
        }

        return NextResponse.json({
            success: true,
            requested_reservation_id: requestedReservationId,
            effective_reservation_id: effectiveReservationId,
            transfer_event_id: transferEventId,
            payment: inserted,
            summary: {
                ...summary,
                total_price: summary.room_charges_total,
            }
        }, { status: 201 });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
