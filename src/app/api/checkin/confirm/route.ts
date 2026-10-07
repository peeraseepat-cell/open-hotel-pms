import {
  applyCheckinFinancials,
  fetchProfileCompleteness,
  getBusinessDate,
  insertCheckinAudit,
  levenshteinRatioPercent,
  mapCheckinPaymentMethod,
  MobileAccompanyingInput,
  MobileCheckinError,
  MobileGuestInfoInput,
  requireMobileCheckinAuth,
  resolvePrimaryGuestProfile,
  syncAccompanyingGuests,
  toBangkokTimeHHmm,
} from "@/lib/mobile-checkin";
import { syncExpectedArrivalAlert } from "@/lib/expected-arrival-alert";
import { fetchExtraFeeTemplate, insertExtraFeePayment } from "@/lib/folio-fees";
import { assertPrimaryGuestAvailableForCheckin, PrimaryGuestCheckinConflictError } from "@/lib/guest-primary-checkin";
import { syncReservationBookingNameAlias } from "@/lib/guest-booking-names";
import { ensureReservationRoomReadyForMobileCheckin } from "@/lib/mobile-checkin-room-readiness";
import { linkPrimaryGuestToReservation, ReservationPartyError } from "@/lib/reservation-party";
import { stampReservationPassportScanExpiry } from "@/lib/passport-scan-retention";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const guestInfoSchema = z.object({
  full_name: z.string().default(""),
  passport_no: z.string().optional().nullable(),
  nationality: z.string().optional().nullable(),
  date_of_birth: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
});

const accompanyingSchema = z.object({
  passport_guest_index: z.number().int().min(1).max(3).nullable().optional(),
  passport_scan_id: z.string().uuid().nullable().optional(),
  full_name: z.string().default(""),
  passport_no: z.string().optional().nullable(),
  nationality: z.string().optional().nullable(),
  date_of_birth: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  source: z.enum(["ocr", "manual"]).optional().nullable(),
});

const bodySchema = z.object({
  reservation_id: z.string().uuid(),
  selected_profile_id: z.string().uuid().optional().nullable(),
  guest_info: guestInfoSchema,
  accompanying_guests: z.array(accompanyingSchema).optional().default([]),
  payment_method: z.string().optional(),
  payment_amount: z.number().optional(),
  deposit_method: z.string().optional(),
  deposit_amount: z.number().optional(),
  early_checkin_fee: z.object({
    amount: z.number(),
    payment_method: z.string(),
    note: z.string().optional().nullable(),
  }).optional().nullable(),
  early_checkin_fee_waived: z.boolean().optional().default(false),
  scan_id: z.string().uuid().optional(),
  force_draft: z.boolean().optional().default(false),
  cashier_name: z.string().optional(),
  booking_name_note: z.string().optional().nullable(),
});

const BOOKED_NAME_NOTE_PREFIX = "จองมาในชื่อ ";

function buildUpsertedBookingNameNote(params: {
  existingNote: unknown;
  bookingNameNote: unknown;
  originalReservationName: string;
  effectiveGuestName: string;
}): string | null {
  const existingNote = String(params.existingNote ?? "").trim();
  const explicitNoteRaw = String(params.bookingNameNote ?? "").trim();
  const hasPrefix = explicitNoteRaw.startsWith(BOOKED_NAME_NOTE_PREFIX);
  let nextBookedNameLine = explicitNoteRaw;

  if (explicitNoteRaw && !hasPrefix) {
    nextBookedNameLine = `${BOOKED_NAME_NOTE_PREFIX}${explicitNoteRaw}`.trim();
  }

  if (!nextBookedNameLine) {
    const original = String(params.originalReservationName ?? "").trim();
    const current = String(params.effectiveGuestName ?? "").trim();
    if (original && current && original.toLowerCase() !== current.toLowerCase()) {
      nextBookedNameLine = `${BOOKED_NAME_NOTE_PREFIX}${original}`;
    }
  }

  const retained = existingNote
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.trim().startsWith(BOOKED_NAME_NOTE_PREFIX.trim()));

  if (nextBookedNameLine) {
    retained.push(nextBookedNameLine);
  }

  const merged = retained.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return merged || null;
}

function buildReservationImagePath(reservationId: string, currentPath: string): string {
  const rawName = String(currentPath || "").split("/").pop() || `scan_${Date.now()}.jpg`;
  const fileName = rawName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${reservationId}/${fileName}`;
}

async function moveScanImageToReservationFolder(params: {
  supabase: any;
  scanId: string;
  reservationId: string;
  imagePath: string | null;
}): Promise<void> {
  const { supabase, scanId, reservationId, imagePath } = params;
  const fromPath = String(imagePath ?? "").trim();
  if (!fromPath || !fromPath.startsWith("unmatched/")) return;

  const toPath = buildReservationImagePath(reservationId, fromPath);
  if (toPath === fromPath) return;

  const { error: copyError } = await supabase.storage
    .from("passport-photos")
    .copy(fromPath, toPath);
  if (copyError) return;

  await supabase.storage.from("passport-photos").remove([fromPath]);
  await supabase.from("passport_scans").update({ image_path: toPath }).eq("id", scanId);
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const auth = await requireMobileCheckinAuth(supabase, request);

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      throw new MobileCheckinError("Invalid payload.", 400, "INVALID_PAYLOAD");
    }

    const payload = parsed.data;
    const businessDate = await getBusinessDate(supabase);
    const terminalId = request.headers.get("x-terminal-id") ?? request.headers.get("x-device-id");
    const userAgent = request.headers.get("user-agent");
    const paymentMethod = mapCheckinPaymentMethod(payload.payment_method);
    const depositMethod = mapCheckinPaymentMethod(payload.deposit_method) ?? paymentMethod;
    const paymentAmount = Number(payload.payment_amount ?? 0);
    const depositAmount = Number(payload.deposit_amount ?? 0);
    const hasCheckinFinancials =
      (Number.isFinite(paymentAmount) && paymentAmount > 0) ||
      (Number.isFinite(depositAmount) && depositAmount > 0);

    const { data: reservation, error: reservationError } = await supabase
      .from("reservations")
      .select("id, booking_code, guest_name, guest_profile_id, status, checked_in_at, checkin_time, note")
      .eq("id", payload.reservation_id)
      .maybeSingle();

    if (reservationError) {
      throw new MobileCheckinError(reservationError.message, 500, "RESERVATION_READ_FAILED");
    }
    if (!reservation) {
      throw new MobileCheckinError("Reservation not found.", 404, "RESERVATION_NOT_FOUND");
    }

    const reservationStatus = String(reservation.status ?? "active");
    if (reservationStatus !== "active" && reservationStatus !== "draft_checkin") {
      throw new MobileCheckinError("Reservation is not eligible for check-in.", 409, "RESERVATION_STATUS_BLOCKED");
    }
    if (reservation.checked_in_at) {
      if (hasCheckinFinancials) {
        await applyCheckinFinancials({
          supabase,
          reservationId: payload.reservation_id,
          method: paymentMethod,
          depositMethod,
          paymentAmount,
          depositAmount,
          cashierName: payload.cashier_name,
          businessDate,
        });

        return NextResponse.json({
          success: true,
          data: {
            reservation_id: payload.reservation_id,
            status: "active",
            is_draft: false,
            draft_reason: null,
            draft_message: null,
            profile_complete: true,
            missing_fields: [],
            checked_in_at: reservation.checked_in_at,
            checkin_time: reservation.checkin_time ?? null,
            already_checked_in: true,
            recovered_financials: true,
          },
        });
      }
      throw new MobileCheckinError("Reservation is already checked in.", 409, "ALREADY_CHECKED_IN");
    }
    const reservationGuestName = String(reservation.guest_name ?? "").trim();

    // NOTE: this value comes from passport_scans.match_confidence and is
    // a name-match ratio (Levenshtein 0-100), not MRZ/OCR extraction quality.
    let scanNameMatchConfidence: number | null = null;
    let scanParsed: Record<string, unknown> | null = null;
    let scanImagePath: string | null = null;

    if (payload.scan_id) {
      const { data: scanRow, error: scanError } = await supabase
        .from("passport_scans")
        .select("id, reservation_id, ocr_parsed, match_confidence, image_path")
        .eq("id", payload.scan_id)
        .maybeSingle();

      if (scanError) {
        throw new MobileCheckinError(scanError.message, 500, "SCAN_READ_FAILED");
      }
      if (!scanRow) {
        throw new MobileCheckinError("Passport scan not found.", 404, "SCAN_NOT_FOUND");
      }

      scanImagePath = String(scanRow.image_path ?? "").trim() || null;
      const rawConfidence = scanRow.match_confidence;
      scanNameMatchConfidence = rawConfidence == null ? null : Number(rawConfidence);
      if (scanNameMatchConfidence != null && !Number.isFinite(scanNameMatchConfidence)) {
        scanNameMatchConfidence = null;
      }
      scanParsed = (scanRow.ocr_parsed as Record<string, unknown> | null) ?? null;

      if (scanNameMatchConfidence == null && scanParsed) {
        const first = String(scanParsed.firstName ?? "").trim();
        const family = String(scanParsed.familyName ?? "").trim();
        const parsedName = `${first} ${family}`.trim();
        if (parsedName && reservationGuestName) {
          scanNameMatchConfidence = levenshteinRatioPercent(parsedName, reservationGuestName);
        }
      }
    }

    const scanBelowThreshold = payload.scan_id
      ? scanNameMatchConfidence == null || scanNameMatchConfidence < 80
      : false;

    const guestInfoInput = payload.guest_info as MobileGuestInfoInput;
    // Always use OCR/form name — booking name goes to booking_name_note
    const effectiveName = guestInfoInput.full_name || reservationGuestName || "Unknown Guest";
    const nextReservationNote = buildUpsertedBookingNameNote({
      existingNote: (reservation as any)?.note ?? null,
      bookingNameNote: payload.booking_name_note ?? null,
      originalReservationName: reservationGuestName,
      effectiveGuestName: effectiveName,
    });

    const resolvedPrimary = await resolvePrimaryGuestProfile({
      supabase,
      reservationId: payload.reservation_id,
      preferredGuestProfileId: payload.selected_profile_id ?? null,
      existingGuestProfileId: reservation.guest_profile_id ? String(reservation.guest_profile_id) : null,
      guestInfo: {
        ...guestInfoInput,
        full_name: effectiveName,
      },
      passportRaw: scanParsed,
      conflictContext: {
        actorUserId: auth.userId,
        reservationId: payload.reservation_id,
        businessDate,
        sourceFlow: "mobile_checkin_confirm_primary",
        terminalId,
        userAgent,
        source: "manual",
      },
    });

    const completeness = await fetchProfileCompleteness(supabase, resolvedPrimary.guestProfileId);
    const roomReadiness = await ensureReservationRoomReadyForMobileCheckin(
      supabase as any,
      payload.reservation_id,
      businessDate
    );
    const draftReason =
      !roomReadiness.ok ? roomReadiness.draft_reason : !completeness.is_complete ? "profile_incomplete" : null;
    const draftMessage =
      !roomReadiness.ok
        ? roomReadiness.draft_message
        : !completeness.is_complete
          ? "Profile is incomplete. Save Draft and complete the missing guest details later."
          : null;
    const isDraft = Boolean(payload.force_draft || draftReason);
    if (!isDraft) {
      await assertPrimaryGuestAvailableForCheckin({
        supabase: supabase as any,
        reservationId: payload.reservation_id,
        guestProfileId: resolvedPrimary.guestProfileId,
      });
    }

    await linkPrimaryGuestToReservation(supabase as any, payload.reservation_id, resolvedPrimary.guestProfileId);

    const accompanying = (payload.accompanying_guests ?? []).slice(0, 3) as MobileAccompanyingInput[];
    await syncAccompanyingGuests({
      supabase,
      reservationId: payload.reservation_id,
      primaryGuestProfileId: resolvedPrimary.guestProfileId,
      accompanyingGuests: accompanying,
      conflictContext: {
        actorUserId: auth.userId,
        reservationId: payload.reservation_id,
        businessDate,
        sourceFlow: "mobile_checkin_confirm_accompanying",
        terminalId,
        userAgent,
        source: "manual",
      },
    });

    const now = new Date();
    const nowIso = now.toISOString();
    const nowCheckinTime = toBangkokTimeHHmm(now);
    const existingCheckinTime = String((reservation as any)?.checkin_time ?? "").trim();
    const capturedCheckinTime = existingCheckinTime || nowCheckinTime;
    const isEarlyCheckinWindow = capturedCheckinTime >= "04:00" && capturedCheckinTime < "09:00";
    const earlyFeePayload = payload.early_checkin_fee ?? null;
    const earlyFeeMethod = earlyFeePayload ? mapCheckinPaymentMethod(earlyFeePayload.payment_method) : null;
    const earlyFeeAmount = Number(earlyFeePayload?.amount ?? 0);
    const earlyFeeWaived = payload.early_checkin_fee_waived === true;

    if (!isDraft && isEarlyCheckinWindow && !earlyFeeWaived) {
      if (!earlyFeePayload) {
        throw new MobileCheckinError("Early check-in decision required for 04:00-08:59 check-in.", 409, "EARLY_CHECKIN_DECISION_REQUIRED");
      }
      if (!earlyFeeMethod) {
        throw new MobileCheckinError("Invalid early check-in fee payment method.", 400, "EARLY_CHECKIN_METHOD_INVALID");
      }
      if (!Number.isFinite(earlyFeeAmount) || earlyFeeAmount <= 0) {
        throw new MobileCheckinError("Early check-in fee amount must be greater than 0.", 400, "EARLY_CHECKIN_AMOUNT_INVALID");
      }
    }

    if (!isDraft && hasCheckinFinancials) {
      await applyCheckinFinancials({
        supabase,
        reservationId: payload.reservation_id,
        method: paymentMethod,
        depositMethod,
        paymentAmount,
        depositAmount,
        cashierName: payload.cashier_name,
        businessDate,
      });
    }

    const beforeJson = {
      status: reservationStatus,
      checked_in_at: reservation.checked_in_at ?? null,
      guest_profile_id: reservation.guest_profile_id ?? null,
    };

    const reservationUpdatePayload: Record<string, unknown> = {
      status: "active",
      guest_name: effectiveName,
      guest_profile_id: resolvedPrimary.guestProfileId,
      note: nextReservationNote,
      checkin_time: capturedCheckinTime,
    };
    if (!isDraft) {
      reservationUpdatePayload.checked_in_at = nowIso;
    }

    const { error: reservationUpdateError } = await supabase
      .from("reservations")
      .update(reservationUpdatePayload)
      .eq("id", payload.reservation_id);

    if (reservationUpdateError) {
      throw new MobileCheckinError(reservationUpdateError.message, 500, "RESERVATION_UPDATE_FAILED");
    }

    if (!isDraft) {
      await syncReservationBookingNameAlias({
        supabase: supabase as any,
        guestProfileId: resolvedPrimary.guestProfileId,
        bookingName: reservationGuestName,
        actualName: effectiveName,
        sourceReservationId: payload.reservation_id,
        seenAt: nowIso,
      });

      try {
        await syncExpectedArrivalAlert({
          supabase: supabase as any,
          reservationId: payload.reservation_id,
          expectedArrivalTime: null,
        });
      } catch (error) {
        console.error("expected arrival alert auto-dismiss failed", error);
      }
    }

    if (payload.scan_id) {
      const { error: scanUpdateError } = await supabase
        .from("passport_scans")
        .update({
          reservation_id: payload.reservation_id,
          matched_reservation_id: payload.reservation_id,
          match_confidence: scanNameMatchConfidence,
        })
        .eq("id", payload.scan_id);

      if (scanUpdateError) {
        throw new MobileCheckinError(scanUpdateError.message, 500, "SCAN_LINK_FAILED");
      }

      await moveScanImageToReservationFolder({
        supabase,
        scanId: payload.scan_id,
        reservationId: payload.reservation_id,
        imagePath: scanImagePath,
      });
    }

    try {
      await stampReservationPassportScanExpiry({
        supabase,
        reservationId: payload.reservation_id,
      });
    } catch (stampError) {
      throw new MobileCheckinError(
        stampError instanceof Error ? stampError.message : "Failed to stamp passport scan retention.",
        500,
        "PASSPORT_RETENTION_STAMP_FAILED"
      );
    }

    if (isDraft && hasCheckinFinancials) {
      await applyCheckinFinancials({
        supabase,
        reservationId: payload.reservation_id,
        method: paymentMethod,
        depositMethod,
        paymentAmount,
        depositAmount,
        cashierName: payload.cashier_name,
        businessDate,
      });
    }

    if (!isDraft && isEarlyCheckinWindow && earlyFeePayload && !earlyFeeWaived) {
      const template = await fetchExtraFeeTemplate(supabase, "EARLY_CHECKIN_FEE");
      if (!template || !template.is_active) {
        throw new MobileCheckinError("EARLY_CHECKIN_FEE template is not available.", 409, "EARLY_CHECKIN_TEMPLATE_UNAVAILABLE");
      }
      await insertExtraFeePayment(supabase, {
        reservationId: payload.reservation_id,
        feeTemplateCode: template.code,
        amount: earlyFeeAmount,
        method: earlyFeeMethod,
        note: earlyFeePayload.note?.trim() || `Early check-in ${capturedCheckinTime}`,
        cashierName: payload.cashier_name || "FO Mobile",
        paidDate: businessDate,
        paidAt: nowIso,
      });
    }

    await insertCheckinAudit({
      supabase,
      actorUserId: auth.userId,
      reservationId: payload.reservation_id,
      action: isDraft ? "draft_checkin" : "checked_in",
      businessDate,
      beforeJson,
      afterJson: {
        status: "active",
        checked_in_at: isDraft ? null : nowIso,
        guest_profile_id: resolvedPrimary.guestProfileId,
        is_draft: isDraft,
        draft_reason: draftReason,
        checkin_time: capturedCheckinTime,
        early_checkin_fee: isEarlyCheckinWindow && earlyFeePayload && !earlyFeeWaived ? {
          code: "EARLY_CHECKIN_FEE",
          amount: earlyFeeAmount,
          method: earlyFeeMethod,
          note: earlyFeePayload.note?.trim() || `Early check-in ${capturedCheckinTime}`,
        } : null,
        early_checkin_fee_waived: isEarlyCheckinWindow && earlyFeeWaived,
        scan_confidence: scanNameMatchConfidence,
        missing_fields: completeness.missing_fields,
        hk_status: roomReadiness.hk_status,
      },
      note: [
        isDraft
          ? draftReason === "room_not_ready"
            ? `Mobile check-in saved as draft because room is not ready.${roomReadiness.hk_status ? ` HK status: ${roomReadiness.hk_status}.` : ""}`
            : "Mobile check-in saved as draft (profile requires follow-up)."
          : `Mobile check-in completed.${scanBelowThreshold ? " Booking name did not match strongly, but actual guest profile was accepted." : ""}`,
        payload.booking_name_note || "",
      ].filter(Boolean).join(" "),
    });

    return NextResponse.json({
      success: true,
      data: {
        reservation_id: payload.reservation_id,
        status: "active",
        is_draft: isDraft,
        draft_reason: draftReason,
        draft_message: draftMessage,
        profile_complete: completeness.is_complete,
        missing_fields: completeness.missing_fields,
        checked_in_at: isDraft ? null : nowIso,
        checkin_time: capturedCheckinTime,
        early_checkin_fee_recorded: Boolean(isEarlyCheckinWindow && earlyFeePayload && !earlyFeeWaived),
        early_checkin_fee_waived: Boolean(isEarlyCheckinWindow && earlyFeeWaived),
        room_number: roomReadiness.room_number,
        hk_status: roomReadiness.hk_status,
      },
    });
  } catch (error) {
    if (error instanceof MobileCheckinError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
          code: error.code,
        },
        { status: error.status }
      );
    }

    if (error instanceof ReservationPartyError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
          ...(error.details ?? {}),
        },
        { status: error.status }
      );
    }

    if (error instanceof PrimaryGuestCheckinConflictError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
          code: error.code,
          ...(error.details ?? {}),
        },
        { status: error.status }
      );
    }

    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
