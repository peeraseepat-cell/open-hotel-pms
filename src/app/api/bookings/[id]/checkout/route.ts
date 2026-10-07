import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
    fetchExtraFeeTemplate,
    insertExtraFeePayment,
    normalizeOperatorPaymentMethod,
    normalizePaymentMethod,
    resolveBusinessDate,
} from "@/lib/folio-fees";
import { computeCheckoutNetPaidSatang, computeExtraChargeNetSatang } from "@/lib/checkout-balance";
import { formatMoney, fromSatang, toSatang } from "@/lib/money";
import { computeReservationDiscountAmount } from "@/lib/reservation-visible-total";
import { syncDynamicRoomLinksForReservation } from "@/lib/logbook-api";
import { syncBookingGroupStatusById } from "@/lib/booking-group-status";
import { requireStaffAuth } from "@/lib/server-auth";
import { normalizeAuditSource } from "@/lib/audit-utils";
import { markRoomDirtyTask } from "@/lib/hk-dirty";
import { markReservationVehiclesCheckedOut } from "@/lib/vehicles";
import { NextRequest, NextResponse } from "next/server";

function toLocalDate(d: Date, tz = "Asia/Bangkok"): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
}

function formatShortDate(date: string): string {
    const [year, month, day] = String(date || "").split("-");
    if (!year || !month || !day) return "";
    return `${day}/${month}`;
}

function getBangkokMinutes(date = new Date()): number {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Bangkok",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).formatToParts(date);
    const hourPart = parts.find((part) => part.type === "hour")?.value;
    const minutePart = parts.find((part) => part.type === "minute")?.value;
    const hour = Number(hourPart);
    const minute = Number(minutePart);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
    return hour * 60 + minute;
}

type PartyRole = "primary" | "accompanying";

type CheckoutReservationRow = {
    id: string;
    parent_reservation_id: string | null;
    booking_group_id: string | null;
    status: string;
    guest_name: string | null;
    total_price: number | string | null;
    checkin_date: string | null;
    checkout_date: string | null;
    deposit_amount?: number | string | null;
    guest_profile_id: string | null;
    discount_type?: string | null;
    discount_value?: number | string | null;
    discount_percent?: number | string | null;
};

type LinkedCheckoutContext = {
    allReservationIds: string[];
    activeReservationIds: string[];
    fullCheckinDate: string;
    fullCheckoutDate: string;
    fallbackPrimaryGuestProfileId: string | null;
    shouldApplyGuestCounters: boolean;
};

type CheckoutRoomNight = {
    room_id: string;
    stay_date: string;
};

function diffStayNights(checkinDate: string, checkoutDate: string): number {
    const checkinMs = new Date(`${checkinDate}T00:00:00`).getTime();
    const checkoutMs = new Date(`${checkoutDate}T00:00:00`).getTime();
    if (!Number.isFinite(checkinMs) || !Number.isFinite(checkoutMs)) return 1;
    return Math.max(1, Math.round((checkoutMs - checkinMs) / 86400000));
}

function isMissingColumnError(error: unknown): boolean {
    const message = typeof error === "object" && error !== null && "message" in error
        ? String((error as any).message ?? "")
        : String(error ?? "");
    return /column .* does not exist/i.test(message);
}

function minDate(values: Array<string | null | undefined>, fallback: string): string {
    return values.filter(Boolean).map(String).sort()[0] ?? fallback;
}

function maxDate(values: Array<string | null | undefined>, fallback: string): string {
    const sorted = values.filter(Boolean).map(String).sort();
    return sorted[sorted.length - 1] ?? fallback;
}

async function loadLinkedCheckoutContext(
    supabase: ReturnType<typeof createServerSupabaseClient>,
    reservation: CheckoutReservationRow
): Promise<LinkedCheckoutContext> {
    const fallbackRow = {
        id: String(reservation.id),
        parent_reservation_id: reservation.parent_reservation_id ?? null,
        status: String(reservation.status ?? ""),
        guest_profile_id: reservation.guest_profile_id ?? null,
        checkin_date: reservation.checkin_date ?? null,
        checkout_date: reservation.checkout_date ?? null,
    };
    const rootReservationId = reservation.parent_reservation_id ? String(reservation.parent_reservation_id) : String(reservation.id);
    const { data, error } = await supabase
        .from("reservations")
        .select("id, parent_reservation_id, status, guest_profile_id, checkin_date, checkout_date")
        .or(`id.eq.${rootReservationId},parent_reservation_id.eq.${rootReservationId}`);
    if (error) throw error;

    const rows = ((data ?? []) as Array<{
        id?: string | null;
        parent_reservation_id?: string | null;
        status?: string | null;
        guest_profile_id?: string | null;
        checkin_date?: string | null;
        checkout_date?: string | null;
    }>)
        .filter((row) => row?.id)
        .map((row) => ({
            id: String(row.id),
            parent_reservation_id: row.parent_reservation_id ? String(row.parent_reservation_id) : null,
            status: String(row.status ?? ""),
            guest_profile_id: row.guest_profile_id ? String(row.guest_profile_id) : null,
            checkin_date: row.checkin_date ?? null,
            checkout_date: row.checkout_date ?? null,
        }))
        .filter((row) => row.status !== "cancelled" && row.status !== "no_show")
        .sort((left, right) =>
            String(left.checkin_date ?? "").localeCompare(String(right.checkin_date ?? "")) ||
            String(left.id).localeCompare(String(right.id))
        );

    const scopedRows = rows.length > 0 ? rows : [fallbackRow];
    const currentIndex = scopedRows.findIndex((row) => row.id === String(reservation.id));
    const currentRow = currentIndex >= 0 ? scopedRows[currentIndex] : fallbackRow;
    const isTerminalSegment = currentIndex >= 0 ? currentIndex === scopedRows.length - 1 : true;
    const counterScopeRows = isTerminalSegment
        ? (currentIndex >= 0 ? scopedRows.slice(0, currentIndex + 1) : [currentRow])
        : [currentRow];
    const activeReservationIds = counterScopeRows.filter((row) => row.status === "active").map((row) => row.id);

    return {
        allReservationIds: counterScopeRows.map((row) => row.id),
        activeReservationIds: activeReservationIds.length > 0 ? activeReservationIds : [String(reservation.id)],
        fullCheckinDate: minDate(counterScopeRows.map((row) => row.checkin_date), String(reservation.checkin_date ?? "")),
        fullCheckoutDate: maxDate(counterScopeRows.map((row) => row.checkout_date), String(reservation.checkout_date ?? "")),
        fallbackPrimaryGuestProfileId:
            reservation.guest_profile_id ? String(reservation.guest_profile_id) : counterScopeRows.find((row) => row.guest_profile_id)?.guest_profile_id ?? null,
        shouldApplyGuestCounters: isTerminalSegment,
    };
}

async function hasLinkedCheckoutCounterAudit(
    supabase: ReturnType<typeof createServerSupabaseClient>,
    reservationIds: string[]
): Promise<boolean> {
    if (reservationIds.length === 0) return false;
    const { data, error } = await supabase
        .from("audit_logs")
        .select("after_json")
        .eq("entity_type", "reservation")
        .eq("action", "checked_out")
        .in("entity_id", reservationIds);
    if (error) throw error;
    return (data ?? []).some((row) => {
        const afterJson = (row as { after_json?: any }).after_json;
        return Boolean(afterJson?.guest_counter_update && Number(afterJson.guest_counter_update.updated_profiles ?? 0) > 0);
    });
}

async function markReservationsCheckedOut(
    supabase: ReturnType<typeof createServerSupabaseClient>,
    reservationIds: string[],
    payload: Record<string, unknown>
): Promise<void> {
    const ids = Array.from(new Set(reservationIds.filter(Boolean)));
    if (ids.length === 0) return;
    const { error } = await supabase.from("reservations").update(payload).in("id", ids);
    if (!error) return;
    if (Object.prototype.hasOwnProperty.call(payload, "checked_out_at") && /checked_out_at/i.test(error.message)) {
        const fallbackPayload = { ...payload };
        delete fallbackPayload.checked_out_at;
        const fallback = await supabase.from("reservations").update(fallbackPayload).in("id", ids);
        if (fallback.error) throw fallback.error;
        return;
    }
    throw error;
}

async function findCheckoutRoomNight(
    supabase: ReturnType<typeof createServerSupabaseClient>,
    reservationId: string,
    businessDate: string
): Promise<CheckoutRoomNight | null> {
    const select = "room_id, stay_date";
    const normalize = (row: any): CheckoutRoomNight | null => {
        const roomId = row?.room_id ? String(row.room_id) : "";
        const stayDate = row?.stay_date ? String(row.stay_date) : "";
        return roomId && stayDate ? { room_id: roomId, stay_date: stayDate } : null;
    };

    const priorNight = await supabase
        .from("reservation_nights")
        .select(select)
        .eq("reservation_id", reservationId)
        .is("cancelled_at", null)
        .lt("stay_date", businessDate)
        .order("stay_date", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (priorNight.error) throw priorNight.error;
    const prior = normalize(priorNight.data);
    if (prior) return prior;

    const fallbackNight = await supabase
        .from("reservation_nights")
        .select(select)
        .eq("reservation_id", reservationId)
        .is("cancelled_at", null)
        .order("stay_date", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (fallbackNight.error) throw fallbackNight.error;
    return normalize(fallbackNight.data);
}

async function releaseUnusedReservationNightsAfterCheckout(
    supabase: ReturnType<typeof createServerSupabaseClient>,
    reservationIds: string[],
    businessDate: string,
    cancelledAt: string
): Promise<number> {
    const ids = Array.from(new Set(reservationIds.filter(Boolean)));
    if (ids.length === 0) return 0;

    const { data, error } = await supabase
        .from("reservation_nights")
        .update({ cancelled_at: cancelledAt })
        .in("reservation_id", ids)
        .gte("stay_date", businessDate)
        .is("cancelled_at", null)
        .select("id");

    if (error) throw error;
    return data?.length ?? 0;
}

async function applyGuestCheckoutCounters(params: {
    supabase: ReturnType<typeof createServerSupabaseClient>;
    reservationId: string;
    reservationIds?: string[];
    fallbackPrimaryGuestProfileId: string | null;
    checkinDate: string;
    checkoutDate: string;
    stayDate: string;
}) {
    const { supabase, reservationId, fallbackPrimaryGuestProfileId, checkinDate, checkoutDate, stayDate } = params;
    const reservationIds = Array.from(new Set((params.reservationIds?.length ? params.reservationIds : [reservationId]).filter(Boolean)));
    const checkoutStayDate = checkoutDate || stayDate;
    const stayNights = diffStayNights(checkinDate, checkoutDate);

    const partyRoleByProfileId = new Map<string, PartyRole>();
    const reservationGuestsResult = await supabase
        .from("reservation_guests")
        .select("guest_profile_id, role")
        .in("reservation_id", reservationIds);

    if (reservationGuestsResult.error) {
        throw reservationGuestsResult.error;
    }

    for (const row of reservationGuestsResult.data ?? []) {
        const guestProfileId = String((row as any)?.guest_profile_id ?? "").trim();
        if (!guestProfileId) continue;
        const role: PartyRole = (row as any)?.role === "primary" ? "primary" : "accompanying";
        const existingRole = partyRoleByProfileId.get(guestProfileId);
        if (!existingRole || role === "primary") {
            partyRoleByProfileId.set(guestProfileId, role);
        }
    }

    const hasPrimaryInParty = Array.from(partyRoleByProfileId.values()).includes("primary");
    if (!hasPrimaryInParty && fallbackPrimaryGuestProfileId) {
        partyRoleByProfileId.set(fallbackPrimaryGuestProfileId, "primary");
    }

    const participantIds = Array.from(partyRoleByProfileId.keys());
    if (participantIds.length === 0) {
        return { mode: "none" as const, updated_profiles: 0 };
    }

    const updateLastStayDate = (existing: string | null) => {
        if (!existing) return checkoutStayDate;
        return existing >= checkoutStayDate ? existing : checkoutStayDate;
    };

    const profilesV2Result = await supabase
        .from("guest_profiles")
        .select("id, stay_count, night_count, main_stay_count, main_night_count, accompanying_stay_count, accompanying_night_count, last_stay_date")
        .in("id", participantIds);

    if (!profilesV2Result.error) {
        const profileRows = profilesV2Result.data ?? [];
        const profileById = new Map<string, any>();
        for (const row of profileRows) {
            profileById.set(String((row as any).id), row);
        }

        let updatedProfiles = 0;
        for (const profileId of participantIds) {
            const profile = profileById.get(profileId);
            if (!profile) continue;
            const role = partyRoleByProfileId.get(profileId) ?? "accompanying";
            const updates: Record<string, unknown> = {
                stay_count: Number(profile.stay_count ?? 0) + 1,
                night_count: Number(profile.night_count ?? 0) + stayNights,
                last_stay_date: updateLastStayDate(profile.last_stay_date ? String(profile.last_stay_date) : null),
            };
            if (role === "primary") {
                updates.main_stay_count = Number(profile.main_stay_count ?? 0) + 1;
                updates.main_night_count = Number(profile.main_night_count ?? 0) + stayNights;
            } else {
                updates.accompanying_stay_count = Number(profile.accompanying_stay_count ?? 0) + 1;
                updates.accompanying_night_count = Number(profile.accompanying_night_count ?? 0) + stayNights;
            }

            const updateResult = await supabase
                .from("guest_profiles")
                .update(updates)
                .eq("id", profileId);
            if (updateResult.error) throw updateResult.error;
            updatedProfiles += 1;
        }

        return { mode: "v2" as const, updated_profiles: updatedProfiles };
    }

    if (!isMissingColumnError(profilesV2Result.error)) {
        throw profilesV2Result.error;
    }

    // Backward-compatible fallback for environments where v2 columns are not migrated yet.
    const profilesLegacyResult = await supabase
        .from("guest_profiles")
        .select("id, stay_count, last_stay_date")
        .in("id", participantIds);
    if (profilesLegacyResult.error) throw profilesLegacyResult.error;

    const legacyById = new Map<string, any>();
    for (const row of profilesLegacyResult.data ?? []) {
        legacyById.set(String((row as any).id), row);
    }

    let updatedProfiles = 0;
    for (const profileId of participantIds) {
        const profile = legacyById.get(profileId);
        if (!profile) continue;
        const updateResult = await supabase
            .from("guest_profiles")
            .update({
                stay_count: Number(profile.stay_count ?? 0) + 1,
                last_stay_date: updateLastStayDate(profile.last_stay_date ? String(profile.last_stay_date) : null),
            })
            .eq("id", profileId);
        if (updateResult.error) throw updateResult.error;
        updatedProfiles += 1;
    }

    return { mode: "legacy" as const, updated_profiles: updatedProfiles };
}

export async function POST(
    request: NextRequest,
    { params }: { params: { id: string } }
) {
    try {
        const supabase = createServerSupabaseClient();
        const auth = await requireStaffAuth(supabase, request, { allowRoles: ["admin", "supervisor", "frontdesk"] });
        if (auth.error) return auth.error;

        const reservationId = params.id;
        const body = await request.json().catch(() => ({}));

        // Payment details
        const paymentMethod = normalizeOperatorPaymentMethod(body.payment_method ?? "cash");
        const paymentAmountSatang = toSatang(body.payment_amount);
        const paymentAmount: number = fromSatang(paymentAmountSatang);
        const paymentNote: string = body.payment_note ?? "";
        const nowDate = new Date();
        const now = nowDate.toISOString();
        const bangkokMinutes = getBangkokMinutes(nowDate);
        const policyFeeRaw = (body.policy_fee && typeof body.policy_fee === "object")
            ? body.policy_fee as Record<string, unknown>
            : null;
        const policyFeeMethod = policyFeeRaw ? normalizeOperatorPaymentMethod(policyFeeRaw.payment_method) : null;
        const policyFeeAmountSatang = policyFeeRaw ? toSatang(policyFeeRaw.amount) : 0;
        const policyFee = policyFeeRaw
            ? {
                fee_template_code: String(policyFeeRaw.fee_template_code ?? "").trim().toUpperCase(),
                amount: fromSatang(policyFeeAmountSatang),
                method: policyFeeMethod,
                note: typeof policyFeeRaw.note === "string" && policyFeeRaw.note.trim()
                    ? String(policyFeeRaw.note).trim()
                    : null
            }
            : null;

        if (!paymentMethod) {
            return NextResponse.json({ error: "Invalid payment_method." }, { status: 400 });
        }
        if (policyFee) {
            if (policyFee.fee_template_code !== "LATE_CHECKOUT_FEE") {
                return NextResponse.json({ error: "policy_fee must use LATE_CHECKOUT_FEE." }, { status: 400 });
            }
            if (!policyFee.method) {
                return NextResponse.json({ error: "Invalid policy_fee.payment_method." }, { status: 400 });
            }
            if (policyFeeAmountSatang <= 0) {
                return NextResponse.json({ error: "policy_fee.amount must be > 0." }, { status: 400 });
            }
            if (bangkokMinutes < 13 * 60) {
                return NextResponse.json({ error: "LATE_CHECKOUT_FEE is only allowed after 13:00." }, { status: 409 });
            }
        }

        // Deposit handling: support both legacy deposit_action and the extracted drawer booleans.
        const depositAction: "apply" | "refund" =
            body.deposit_action === "apply" || body.apply_deposit === true
                ? "apply"
                : "refund";
        const depositRefundMethod = normalizePaymentMethod(body.deposit_refund_method ?? "cash") ?? "cash";

        // Force checkout bypasses loan/trace warnings (user acknowledged)
        const forceCheckout: boolean = body.force_checkout === true || body.force === true;

        // Verify reservation
        const { data: reservation, error: resError } = await supabase
            .from("reservations")
            .select("id, parent_reservation_id, booking_group_id, status, guest_name, total_price, checkin_date, checkout_date, deposit_amount, guest_profile_id, discount_type, discount_value, discount_percent")
            .eq("id", reservationId)
            .maybeSingle();

        if (resError || !reservation) {
            return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
        }
        if (reservation.status !== "active") {
            return NextResponse.json({ error: "Reservation is not active." }, { status: 400 });
        }
        const linkedCheckoutContext = await loadLinkedCheckoutContext(supabase, reservation as CheckoutReservationRow);

        const totalPriceSatang = toSatang(reservation.total_price);
        const discountSatang = toSatang(
            computeReservationDiscountAmount({
                totalPrice: reservation.total_price,
                discountType: reservation.discount_type,
                discountValue: reservation.discount_value,
                discountPercent: reservation.discount_percent,
                checkinDate: reservation.checkin_date,
                checkoutDate: reservation.checkout_date,
            })
        );
        const discountedRoomTotalSatang = Math.max(0, totalPriceSatang - discountSatang);
        const depositAmountSatang = toSatang(reservation.deposit_amount);
        const totalPrice = fromSatang(discountedRoomTotalSatang);
        const depositAmount = fromSatang(depositAmountSatang);

        // Calculate existing payments
        const { data: existingPayments } = await supabase
            .from("folio_payments")
            .select("amount, tx_type, revenue_category, note, is_record_only")
            .eq("reservation_id", reservationId);

        const { netPaidSatang: priorPaidSatang } = computeCheckoutNetPaidSatang(existingPayments ?? []);
        const priorExtraChargeSatang = computeExtraChargeNetSatang(existingPayments ?? []);
        let policyTemplateCode: string | null = null;
        if (policyFee) {
            const template = await fetchExtraFeeTemplate(supabase, policyFee.fee_template_code);
            if (!template || !template.is_active) {
                return NextResponse.json({ error: "LATE_CHECKOUT_FEE template is not available." }, { status: 409 });
            }
            policyTemplateCode = template.code;
        }

        const creditsBeforeThisPaymentSatang =
            priorPaidSatang + (depositAction === "apply" ? depositAmountSatang : 0);
        const effectiveTotalSatang = discountedRoomTotalSatang + priorExtraChargeSatang + policyFeeAmountSatang;
        // policy_fee is posted as its own extra_charge payment row in the same request.
        // Count it here to avoid forcing FO to enter the fee amount again in payment_amount.
        const currentActionCreditsSatang = paymentAmountSatang + policyFeeAmountSatang;
        const balanceBeforePaymentSatang = effectiveTotalSatang - creditsBeforeThisPaymentSatang;
        const balanceBeforePayment = fromSatang(balanceBeforePaymentSatang);
        const remainingAfterEnteredPaymentSatang = balanceBeforePaymentSatang - currentActionCreditsSatang;

        // If balance is 0 or negative, allow zero payment
        if (currentActionCreditsSatang <= 0 && balanceBeforePaymentSatang > 0) {
            return NextResponse.json({
                error: `Outstanding balance of ฿${formatMoney(balanceBeforePayment)}. Payment required.`
            }, { status: 400 });
        }

        if (remainingAfterEnteredPaymentSatang > 0) {
            return NextResponse.json({
                error: `Outstanding balance of ฿${formatMoney(fromSatang(remainingAfterEnteredPaymentSatang))}. Full payment required before checkout.`
            }, { status: 400 });
        }

        // Check for open non-HK loan items (warn if not force_checkout).
        // HK-collect loans remain open for maid collection flow after checkout.
        if (!forceCheckout) {
            const { data: openLoanTraces } = await supabase
                .from("reservation_traces")
                .select("id, loan_item_code, loan_items(requires_hk_collection)")
                .eq("reservation_id", reservationId)
                .eq("status", "open")
                .not("loan_item_code", "is", null);

            const blockingOpenLoans = (openLoanTraces ?? []).filter((trace: any) => {
                const requiresHkCollection = Boolean(trace?.loan_items?.requires_hk_collection);
                return !requiresHkCollection;
            });

            if (blockingOpenLoans.length > 0) {
                return NextResponse.json({
                    error: "Unreturned front-desk loan items. Return these items first or set force_checkout=true.",
                    code: "OPEN_LOANS",
                    blocking_open_loan_count: blockingOpenLoans.length,
                }, { status: 409 });
            }
        }

        const calendarDate = toLocalDate(nowDate);
        const businessDate = await resolveBusinessDate(supabase, calendarDate);
        const checkoutRoomNight = await findCheckoutRoomNight(supabase, reservationId, businessDate);

        // 1. Write folio_payment for checkout (skip if 0)
        if (paymentAmountSatang > 0) {
            const { error: checkoutPaymentError } = await supabase.from("folio_payments").insert({
                reservation_id: reservationId,
                tx_type: "payment",
                method: paymentMethod,
                amount: paymentAmount,
                note: paymentNote || null,
                revenue_category: "room_revenue",
                cashier_name: "FO",
                paid_date: businessDate,
                paid_at: now
            });
            if (checkoutPaymentError) {
                return NextResponse.json({ error: checkoutPaymentError.message }, { status: 500 });
            }
        }

        if (policyFee && policyTemplateCode) {
            await insertExtraFeePayment(supabase, {
                reservationId,
                feeTemplateCode: policyTemplateCode,
                amount: policyFee.amount,
                method: policyFee.method!,
                note: policyFee.note || `Late checkout ${String(Math.floor(bangkokMinutes / 60)).padStart(2, "0")}:${String(bangkokMinutes % 60).padStart(2, "0")}`,
                paidAt: now,
                paidDate: businessDate,
            });
        }

        // 2. Handle deposit refund if requested (policy: always refund as cash)
        let depositRefundedSatang = 0;
        if (depositAction === "refund" && depositAmountSatang > 0) {
            depositRefundedSatang = depositAmountSatang;
            const { error: depositRefundError } = await supabase.from("folio_payments").insert({
                reservation_id: reservationId,
                tx_type: "refund",
                method: depositRefundMethod,
                amount: depositAmount,
                note: "Deposit refund on checkout",
                revenue_category: "deposit",
                cashier_name: "FO",
                paid_date: businessDate,
                paid_at: now
            });
            if (depositRefundError) {
                return NextResponse.json({ error: depositRefundError.message }, { status: 500 });
            }
        }

        // 3. Update reservation status to checked_out. Linked stays close as one real checkout.
        const checkoutStatusPayload: Record<string, unknown> = {
            status: "checked_out",
            updated_at: now,
            checked_out_at: now,
        };
        await markReservationsCheckedOut(supabase, linkedCheckoutContext.activeReservationIds, checkoutStatusPayload);
        const releasedFutureNights = await releaseUnusedReservationNightsAfterCheckout(
            supabase,
            linkedCheckoutContext.activeReservationIds,
            businessDate,
            now
        );

        if (depositAction === "refund" && depositRefundedSatang > 0) {
            const { error: depositResetError } = await supabase
                .from("reservations")
                .update({
                    deposit_amount: 0,
                    deposit_paid_at: null,
                    deposit_note: null,
                })
                .eq("id", reservationId);
            if (depositResetError) {
                return NextResponse.json({ error: depositResetError.message }, { status: 500 });
            }
        }

        let checkoutCounterResult: { mode: "v2" | "legacy" | "none"; updated_profiles: number } | null = null;
        try {
            const counterAlreadyApplied = linkedCheckoutContext.shouldApplyGuestCounters
                ? await hasLinkedCheckoutCounterAudit(supabase, linkedCheckoutContext.allReservationIds)
                : true;
            checkoutCounterResult = counterAlreadyApplied
                ? { mode: "none", updated_profiles: 0 }
                : await applyGuestCheckoutCounters({
                    supabase,
                    reservationId,
                    reservationIds: linkedCheckoutContext.allReservationIds,
                    fallbackPrimaryGuestProfileId: linkedCheckoutContext.fallbackPrimaryGuestProfileId,
                    checkinDate: linkedCheckoutContext.fullCheckinDate || String(reservation.checkin_date ?? businessDate),
                    checkoutDate: linkedCheckoutContext.fullCheckoutDate || String(reservation.checkout_date ?? businessDate),
                    stayDate: businessDate,
                });
        } catch (counterError) {
            console.error("guest checkout counters update failed:", counterError);
        }

        // 4. Get room and mark as dirty
        let checkedOutRoomNumber: string | null = null;
        if (checkoutRoomNight?.room_id) {
            const { data: roomRow } = await supabase
                .from("rooms")
                .select("room_number")
                .eq("id", checkoutRoomNight.room_id)
                .maybeSingle();
            checkedOutRoomNumber = roomRow?.room_number ? String(roomRow.room_number) : null;

            await markRoomDirtyTask(supabase, {
                roomId: checkoutRoomNight.room_id,
                stayDate: businessDate,
                assignedMaidName: null,
                clearDailyPlanWhenUnassigned: true,
                logNote: "Marked dirty from checkout",
            });
        }

        if (checkedOutRoomNumber) {
            await syncDynamicRoomLinksForReservation(supabase, {
                reservationId,
                nextRoomCode: checkedOutRoomNumber,
            });

            const { error: dynamicCheckoutLabelError } = await supabase
                .from("logbook_note_links")
                .update({
                    label: `Room ${checkedOutRoomNumber} ${formatShortDate(businessDate)}`,
                })
                .eq("link_type", "room")
                .eq("room_link_mode", "dynamic")
                .eq("ref_id", reservationId);

            if (dynamicCheckoutLabelError) {
                return NextResponse.json({ error: dynamicCheckoutLabelError.message }, { status: 500 });
            }
        }

        // 5. Audit log
        await supabase.from("audit_logs").insert({
            action: "checked_out",
            entity_type: "reservation",
            entity_id: reservationId,
            after_json: {
                guest_name: reservation.guest_name,
                total_price: reservation.total_price,
                payment_method: paymentMethod,
                payment_amount: paymentAmount,
                payment_note: paymentNote,
                deposit_action: depositAction,
                deposit_refunded: fromSatang(depositRefundedSatang),
                deposit_refund_method: depositRefundedSatang > 0 ? depositRefundMethod : null,
                policy_fee: policyFee ? {
                    code: policyFee.fee_template_code,
                    amount: policyFee.amount,
                    method: policyFee.method,
                    note: policyFee.note,
                } : null,
                guest_counter_update: checkoutCounterResult,
                checked_out_at: now,
                linked_checkout: {
                    reservation_ids: linkedCheckoutContext.activeReservationIds,
                    full_checkin_date: linkedCheckoutContext.fullCheckinDate,
                    full_checkout_date: linkedCheckoutContext.fullCheckoutDate,
                    released_future_nights: releasedFutureNights,
                },
            },
            business_date: businessDate,
            source: normalizeAuditSource("manual"),
        });

        if (reservation.booking_group_id) {
            try {
                await syncBookingGroupStatusById(supabase, String(reservation.booking_group_id));
            } catch (syncError) {
                console.error("group status sync after checkout failed:", reservation.booking_group_id, syncError);
            }
        }

        try {
            for (const linkedReservationId of linkedCheckoutContext.activeReservationIds) {
                await markReservationVehiclesCheckedOut(supabase, linkedReservationId, now);
            }
        } catch (vehicleError) {
            console.error("vehicle checkout sync failed:", reservationId, vehicleError);
        }

        return NextResponse.json({
            success: true,
            message: "Checked out successfully.",
            total_price: totalPrice,
            payment_amount: paymentAmount,
            policy_fee_recorded: Boolean(policyFee),
            deposit_refunded: fromSatang(depositRefundedSatang),
            deposit_action: depositAction,
            deposit_refund_method: depositRefundedSatang > 0 ? depositRefundMethod : null
        });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
