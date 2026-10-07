import { computeMrzConfidence, levenshteinRatioPercent, MobileCheckinError, requireMobileCheckinAuth } from "@/lib/mobile-checkin";
import { parsePassportMrz } from "@/lib/passport-ocr/mrz";
import { detectPassportTextFromBuffer } from "@/lib/passport-ocr/vision";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const runtime = "nodejs";
const MAX_PASSPORT_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB (same as bucket limit)

function normalizeGuestIndex(raw: FormDataEntryValue | null): number {
  const parsed = Number(raw ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(9, Math.trunc(parsed));
}

function resolveFileExtension(contentType: string): string {
  const lower = contentType.toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  return "jpg";
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const auth = await requireMobileCheckinAuth(supabase, request);

    const formData = await request.formData();
    const image = formData.get("image");
    if (!(image instanceof File)) {
      throw new MobileCheckinError("image is required.", 400, "IMAGE_REQUIRED");
    }

    const reservationIdRaw = String(formData.get("reservation_id") ?? "").trim();
    const reservationId = reservationIdRaw || null;
    const guestIndex = normalizeGuestIndex(formData.get("guest_index"));

    let reservationGuestName: string | null = null;
    if (reservationId) {
      const { data: reservation, error: reservationError } = await supabase
        .from("reservations")
        .select("id, guest_name")
        .eq("id", reservationId)
        .maybeSingle();

      if (reservationError) {
        throw new MobileCheckinError(reservationError.message, 500, "RESERVATION_READ_FAILED");
      }
      if (!reservation) {
        throw new MobileCheckinError("Reservation not found.", 404, "RESERVATION_NOT_FOUND");
      }
      reservationGuestName = String(reservation.guest_name ?? "").trim() || null;
    }

    const bytes = await image.arrayBuffer();
    const buffer = Buffer.from(bytes);
    if (buffer.length <= 0) {
      throw new MobileCheckinError("Uploaded image is empty.", 400, "IMAGE_EMPTY");
    }
    if (buffer.length > MAX_PASSPORT_UPLOAD_BYTES) {
      throw new MobileCheckinError(
        "Passport image is too large. Maximum file size is 10MB.",
        400,
        "IMAGE_TOO_LARGE"
      );
    }

    const ext = resolveFileExtension(image.type || "image/jpeg");
    const objectPath = `${reservationId ?? "unmatched"}/${guestIndex}_${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("passport-photos")
      .upload(objectPath, buffer, {
        upsert: false,
        contentType: image.type || "image/jpeg",
      });

    if (uploadError) {
      throw new MobileCheckinError(uploadError.message, 500, "STORAGE_UPLOAD_FAILED");
    }

    const rawText = await detectPassportTextFromBuffer(buffer);
    const parsed = parsePassportMrz(rawText);
    if (!parsed) {
      // MRZ unreadable — but the photo IS already captured & uploaded. Never lose it:
      // persist the scan row (bound to the reservation when known) with pool_status='ocr_failed'
      // so the image stays linked and the FO can fill in the guest details manually.
      const { data: failedRow, error: failedError } = await supabase
        .from("passport_scans")
        .insert({
          reservation_id: reservationId,
          guest_index: guestIndex,
          image_path: objectPath,
          ocr_raw: {
            raw_text: rawText,
            content_type: image.type || "image/jpeg",
            size: buffer.length,
          },
          ocr_parsed: null,
          match_confidence: null,
          matched_reservation_id: reservationId,
          pool_status: "ocr_failed",
          created_by: auth.userId,
        })
        .select("id, image_path")
        .single();

      if (failedError) {
        throw new MobileCheckinError(failedError.message, 500, "SCAN_INSERT_FAILED");
      }

      return NextResponse.json({
        success: true,
        data: {
          scan_id: String(failedRow.id),
          image_path: String(failedRow.image_path),
          parsed: null,
          mrz_failed: true,
          message: "เก็บรูปพาสปอร์ตแล้ว แต่อ่าน MRZ ไม่ออก กรุณากรอกข้อมูลแขกเอง",
        },
      });
    }

    const confidence = computeMrzConfidence(parsed);
    const parsedName = `${String(parsed.firstName ?? "").trim()} ${String(parsed.familyName ?? "").trim()}`.trim();
    // NOTE: match_confidence is name-match ratio (Levenshtein 0-100), not MRZ/OCR quality.
    const matchConfidence = reservationGuestName
      ? levenshteinRatioPercent(parsedName, reservationGuestName)
      : null;

    const { data: scanRow, error: scanError } = await supabase
      .from("passport_scans")
      .insert({
        reservation_id: reservationId,
        guest_index: guestIndex,
        image_path: objectPath,
        ocr_raw: {
          raw_text: rawText,
          content_type: image.type || "image/jpeg",
          size: buffer.length,
        },
        ocr_parsed: parsed,
        match_confidence: matchConfidence,
        matched_reservation_id: reservationId,
        created_by: auth.userId,
      })
      .select("id, image_path, match_confidence")
      .single();

    if (scanError) {
      throw new MobileCheckinError(scanError.message, 500, "SCAN_INSERT_FAILED");
    }

    return NextResponse.json({
      success: true,
      data: {
        scan_id: String(scanRow.id),
        image_path: String(scanRow.image_path),
        parsed: {
          ...parsed,
          confidence,
        },
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
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

    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
