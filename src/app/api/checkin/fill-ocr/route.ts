import {
  MobileCheckinError,
  MobileGuestInfoInput,
  type MobileAccompanyingInput,
  getBusinessDate,
  requireMobileCheckinAuth,
  resolvePrimaryGuestProfile,
  syncAccompanyingGuests,
} from "@/lib/mobile-checkin";
import { linkPrimaryGuestToReservation } from "@/lib/reservation-party";
import { parsePassportMrz } from "@/lib/passport-ocr/mrz";
import { detectPassportTextFromBuffer } from "@/lib/passport-ocr/vision";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const runtime = "nodejs";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Fill OCR — OCR passport + update guest profile directly
 * Does NOT save the image to storage (user already has it on device).
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const auth = await requireMobileCheckinAuth(supabase, request);
    const businessDate = await getBusinessDate(supabase);
    const terminalId = request.headers.get("x-terminal-id") ?? request.headers.get("x-device-id");
    const userAgent = request.headers.get("user-agent");

    const formData = await request.formData();
    const image = formData.get("image");
    if (!(image instanceof File)) {
      throw new MobileCheckinError("image is required.", 400, "IMAGE_REQUIRED");
    }

    const reservationId = String(formData.get("reservation_id") ?? "").trim();
    if (!reservationId) {
      throw new MobileCheckinError("reservation_id is required.", 400, "MISSING_RESERVATION_ID");
    }

    const target = String(formData.get("target") ?? "main").trim(); // "main" | "accompanying"
    const requestedGuestIndex = formData.get("guest_index");
    const guestIndexRaw = Number(requestedGuestIndex ?? 0);
    let guestIndex = Number.isFinite(guestIndexRaw) && guestIndexRaw >= 0
      ? Math.min(9, Math.trunc(guestIndexRaw))
      : 0;

    if (target !== "main" && requestedGuestIndex !== null &&
        (!Number.isInteger(guestIndexRaw) || guestIndexRaw < 1 || guestIndexRaw > 3)) {
      throw new MobileCheckinError("Accompanying guest_index must be an integer from 1 to 3.", 400, "INVALID_GUEST_INDEX");
    }

    // Validate reservation exists
    const { data: reservation, error: reservationError } = await supabase
      .from("reservations")
      .select("id, guest_name, guest_profile_id, status, checked_in_at")
      .eq("id", reservationId)
      .maybeSingle();

    if (reservationError) {
      throw new MobileCheckinError(reservationError.message, 500, "RESERVATION_READ_FAILED");
    }
    if (!reservation) {
      throw new MobileCheckinError("Reservation not found.", 404, "RESERVATION_NOT_FOUND");
    }
    if (reservation.status !== "active" && reservation.status !== "draft_checkin") {
      throw new MobileCheckinError("Reservation is not active.", 409, "RESERVATION_NOT_ACTIVE");
    }

    const isInHouse = Boolean(reservation.checked_in_at);

    // In-house can only fill accompanying guests
    if (isInHouse && target === "main") {
      throw new MobileCheckinError(
        "แขก Check-in แล้ว แก้ Main Guest ได้จาก Desktop เท่านั้น",
        409,
        "INHOUSE_MAIN_BLOCKED"
      );
    }

    // Read image & run OCR (no storage upload)
    const bytes = await image.arrayBuffer();
    const buffer = Buffer.from(bytes);
    if (buffer.length <= 0) {
      throw new MobileCheckinError("Uploaded image is empty.", 400, "IMAGE_EMPTY");
    }
    if (buffer.length > MAX_UPLOAD_BYTES) {
      throw new MobileCheckinError("Image too large. Maximum 10MB.", 400, "IMAGE_TOO_LARGE");
    }

    const rawText = await detectPassportTextFromBuffer(buffer);
    const parsed = parsePassportMrz(rawText);
    if (!parsed) {
      throw new MobileCheckinError(
        "ไม่สามารถอ่าน MRZ ได้ กรุณาถ่ายรูปใหม่ให้ชัดขึ้น",
        422,
        "MRZ_PARSE_FAILED"
      );
    }

    const ocrName = `${String(parsed.firstName ?? "").trim()} ${String(parsed.familyName ?? "").trim()}`.trim();
    const guestInfo: MobileGuestInfoInput = {
      full_name: ocrName || "Unknown Guest",
      first_name: parsed.firstName || null,
      last_name: parsed.familyName || null,
      passport_no: parsed.passportNumber || null,
      nationality: parsed.nationality || null,
      date_of_birth: parsed.dateOfBirth || null,
      gender: parsed.gender || null,
    };

    let profileId = "";
    let updatedName = ocrName;
    let bookingNameNote: string | null = null;

    if (target === "main") {
      // Fill main guest — update reservation's guest_profile
      const currentName = String(reservation.guest_name ?? "").trim();
      if (currentName && ocrName && ocrName.toLowerCase() !== currentName.toLowerCase()) {
        bookingNameNote = `จองมาในชื่อ ${currentName}`;
      }

      const resolved = await resolvePrimaryGuestProfile({
        supabase,
        reservationId,
        existingGuestProfileId: reservation.guest_profile_id
          ? String(reservation.guest_profile_id)
          : null,
        guestInfo,
        passportRaw: null,
        conflictContext: {
          actorUserId: auth.userId,
          reservationId,
          businessDate,
          sourceFlow: "mobile_checkin_fill_ocr_primary",
          terminalId,
          userAgent,
          source: "manual",
        },
      });

      profileId = resolved.guestProfileId;
      updatedName = resolved.fullName;

      await linkPrimaryGuestToReservation(supabase as any, reservationId, profileId);

      // Update reservation guest_name to OCR name
      await supabase
        .from("reservations")
        .update({ guest_name: updatedName, guest_profile_id: profileId })
        .eq("id", reservationId);
    } else {
      // Fill accompanying guest — add/update in reservation_guests
      // Fetch existing accompanying guests first
      const { data: existingParty, error: partyError } = await supabase
        .from("reservation_guests")
        .select("id, guest_profile_id, display_order")
        .eq("reservation_id", reservationId)
        .eq("role", "accompanying")
        .order("display_order", { ascending: true });

      if (partyError) throw new MobileCheckinError(partyError.message, 500, "ACCOMPANY_READ_FAILED");
      const existingAccom = existingParty ?? [];
      const occupiedIndexes = new Set<number>();
      for (const member of existingAccom) {
        const index = Number(member.display_order) - 1;
        if (!Number.isInteger(index) || index < 1 || index > 3 || occupiedIndexes.has(index)) {
          throw new MobileCheckinError("Existing accompanying guest slots are invalid.", 409, "ACCOMPANY_SLOT_INVALID");
        }
        occupiedIndexes.add(index);
      }
      if (requestedGuestIndex !== null && occupiedIndexes.has(guestIndexRaw)) {
        throw new MobileCheckinError("ช่องผู้เข้าพักนี้มีผู้ใช้อยู่แล้ว กรุณาโหลดหน้าใหม่", 409, "ACCOMPANY_SLOT_OCCUPIED");
      }
      const nextIndex = requestedGuestIndex !== null ? guestIndexRaw
        : [1, 2, 3].find((index) => !occupiedIndexes.has(index));
      if (nextIndex === undefined) {
        throw new MobileCheckinError("Accompanying guest limit reached.", 409, "ACCOMPANY_LIMIT_REACHED");
      }
      guestIndex = nextIndex;

      // Build the new accompanying list: keep existing + add new one
      const existingInfos: MobileAccompanyingInput[] = [];
      for (const member of existingAccom) {
        if (!member.guest_profile_id) throw new MobileCheckinError("Existing guest profile is missing.", 409, "ACCOMPANY_PROFILE_MISSING");
        const { data: profile, error: profileError } = await supabase
          .from("guest_profiles")
          .select("first_name, last_name, passport_no, id_number, nationality_code, dob, gender")
          .eq("id", member.guest_profile_id)
          .maybeSingle();
        if (profileError) throw new MobileCheckinError(profileError.message, 500, "ACCOMPANY_PROFILE_READ_FAILED");
        if (!profile) throw new MobileCheckinError("Existing guest profile is missing.", 409, "ACCOMPANY_PROFILE_MISSING");
        const fullName = `${profile.first_name || ""} ${profile.last_name || ""}`.trim();
        if (!fullName) throw new MobileCheckinError("Existing guest profile has no name.", 409, "ACCOMPANY_PROFILE_INCOMPLETE");
        if (profile) {
          existingInfos.push({
            passport_guest_index: Number(member.display_order) - 1,
            full_name: fullName,
            first_name: profile.first_name || null,
            last_name: profile.last_name || null,
            passport_no: profile.passport_no || profile.id_number || null,
            nationality: profile.nationality_code || null,
            date_of_birth: profile.dob || null,
            gender: profile.gender || null,
          });
        }
      }

      // Add the new OCR guest
      existingInfos.push({ ...guestInfo, passport_guest_index: guestIndex });

      // Get primary guest profile id
      const primaryGuestProfileId = reservation.guest_profile_id
        ? String(reservation.guest_profile_id)
        : "";

      await syncAccompanyingGuests({
        supabase,
        reservationId,
        primaryGuestProfileId,
        accompanyingGuests: existingInfos.map((info) => ({
          ...info,
          source: "ocr" as const,
        })),
        conflictContext: {
          actorUserId: auth.userId,
          reservationId,
          businessDate,
          sourceFlow: "mobile_checkin_fill_ocr_accompanying",
          terminalId,
          userAgent,
          source: "manual",
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        reservation_id: reservationId,
        target,
        guest_index: guestIndex,
        parsed: {
          firstName: parsed.firstName,
          familyName: parsed.familyName,
          passportNumber: parsed.passportNumber,
          nationality: parsed.nationality,
          dateOfBirth: parsed.dateOfBirth,
          gender: parsed.gender,
        },
        profile_id: profileId || null,
        updated_name: updatedName,
        booking_name_note: bookingNameNote,
      },
    });
  } catch (error) {
    if (error instanceof MobileCheckinError) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code },
        { status: error.status }
      );
    }
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
