import { checkProfileCompleteness } from "@/lib/guest-profile-completeness";
import { findExistingGuestProfileByDocument, resolveGuestProfile } from "@/lib/guest-resolution";
import type { GuestProfileConflictLogContext } from "@/lib/guest-profile-conflict-log";
import {
  createGuestProfileWithConflictHandling,
  updateGuestProfileWithConflictHandling,
} from "@/lib/guest-profile-persistence";
import { classifyGuestNameMatch } from "@/lib/guest-name-match";
import { getCountryByCode, normalizeNationalityCode } from "@/lib/nationality-map";
import { assertBusinessDayOpen } from "@/lib/folio-fees";
import { getAuthenticatedUser, getUserRole } from "@/lib/server-auth";
import { normalizeAuditSource } from "@/lib/audit-utils";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  MOBILE_CHECKIN_DEPOSIT_NOTE,
  MOBILE_CHECKIN_PAYMENT_NOTE,
  hasMatchingMobileCheckinFinancial,
} from "@/lib/mobile-checkin-financials";
import type { MobileCheckinFinancialRow } from "@/lib/mobile-checkin-financials";
import { NextRequest } from "next/server";

const ALLOWED_ROLES = new Set(["admin", "frontdesk", "supervisor", "mobile", "owner"]);

export type MobileCheckinRole = "admin" | "frontdesk" | "supervisor" | "mobile" | "owner";

export type MobileGuestInfoInput = {
  full_name: string;
  first_name?: string | null;
  last_name?: string | null;
  passport_no?: string | null;
  nationality?: string | null;
  date_of_birth?: string | null;
  gender?: string | null;
};

export type MobileAccompanyingInput = {
  full_name: string;
  first_name?: string | null;
  last_name?: string | null;
  passport_no?: string | null;
  nationality?: string | null;
  date_of_birth?: string | null;
  gender?: string | null;
  source?: "ocr" | "manual" | null;
  passport_scan_id?: string | null;
  passport_guest_index?: number | null;
};

type GuestProfileConflictContextBase = Omit<
  GuestProfileConflictLogContext,
  "attemptedProfileId" | "resolvedProfileId" | "documentType" | "documentNumber" | "retryCount"
>;

export class MobileCheckinError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "MobileCheckinError";
    this.status = status;
    this.code = code;
  }
}

export function toBangkokDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function toBangkokTimeHHmm(date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeWhitespace(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizePassportNo(value: unknown): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

function normalizeIsoDate(value: unknown): string | null {
  const raw = normalizeWhitespace(value);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const slash = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (slash) {
    return `${slash[3]}-${slash[2]}-${slash[1]}`;
  }
  return null;
}

function normalizeGender(value: unknown): "M" | "F" | "Other" | null {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw) return null;
  if (raw === "M" || raw === "MALE" || raw === "1" || raw === "ชาย") return "M";
  if (raw === "F" || raw === "FEMALE" || raw === "2" || raw === "หญิง") return "F";
  if (raw === "X" || raw === "OTHER" || raw === "3") return "Other";
  return null;
}

function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const normalized = normalizeWhitespace(fullName);
  if (!normalized) {
    return { firstName: "", lastName: "Unknown" };
  }

  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 1) {
    return { firstName: tokens[0], lastName: tokens[0] };
  }

  return {
    firstName: tokens.slice(0, -1).join(" "),
    lastName: tokens[tokens.length - 1],
  };
}

function resolveNameParts(input: { full_name: string; first_name?: string | null; last_name?: string | null }): {
  firstName: string;
  lastName: string;
} {
  const explicitFirst = normalizeWhitespace(input.first_name);
  const explicitLast = normalizeWhitespace(input.last_name);
  if (explicitFirst || explicitLast) {
    return {
      firstName: explicitFirst,
      lastName: explicitLast || "Unknown",
    };
  }
  return splitFullName(input.full_name);
}

export function normalizeForNameMatch(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshteinDistance(a: string, b: string): number {
  const x = normalizeForNameMatch(a);
  const y = normalizeForNameMatch(b);
  if (!x.length) return y.length;
  if (!y.length) return x.length;

  const dp = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 0; j <= y.length; j += 1) {
    dp[0][j] = j;
  }

  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[x.length][y.length];
}

export function levenshteinRatioPercent(a: string, b: string): number {
  const x = normalizeForNameMatch(a);
  const y = normalizeForNameMatch(b);
  if (!x && !y) return 100;
  if (!x || !y) return 0;

  const distance = levenshteinDistance(x, y);
  const base = Math.max(x.length, y.length);
  if (base <= 0) return 0;

  const ratio = 1 - distance / base;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

/**
 * Token Subset Matching:
 * ตรวจว่าทุก token ของชื่อที่สั้นกว่า อยู่ในชื่อที่ยาวกว่าหรือไม่
 * เหมาะกับกรณี: จอง "DOORTJE DE VRIES" → Passport "DOORTJE CARICE MADELIEF DE VRIES"
 */
function tokenSubsetConfidence(a: string, b: string): number {
  const tokensA = normalizeForNameMatch(a).split(" ").filter(Boolean);
  const tokensB = normalizeForNameMatch(b).split(" ").filter(Boolean);
  if (!tokensA.length || !tokensB.length) return 0;

  // shorter = query tokens, longer = target tokens
  const [shorter, longer] = tokensA.length <= tokensB.length
    ? [tokensA, tokensB]
    : [tokensB, tokensA];

  let matched = 0;
  const used = new Set<number>();
  for (const token of shorter) {
    for (let i = 0; i < longer.length; i++) {
      if (used.has(i)) continue;
      // Allow fuzzy per-token match (1 char difference for tokens > 3 chars)
      if (token === longer[i] ||
          (token.length > 3 && longer[i].length > 3 &&
           levenshteinDistance(token, longer[i]) <= 1)) {
        matched++;
        used.add(i);
        break;
      }
    }
  }

  // All tokens of the shorter name must be found in the longer name
  const ratio = matched / shorter.length;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

/**
 * First + Last Name Matching:
 * เทียบชื่อแรก + นามสกุลท้าย แยกกัน แล้วเฉลี่ย
 * เหมาะกับชื่อที่มี middle name หลายตัว
 */
function firstLastConfidence(a: string, b: string): number {
  const tokensA = normalizeForNameMatch(a).split(" ").filter(Boolean);
  const tokensB = normalizeForNameMatch(b).split(" ").filter(Boolean);
  if (!tokensA.length || !tokensB.length) return 0;

  const firstA = tokensA[0];
  const lastA = tokensA[tokensA.length - 1];
  const firstB = tokensB[0];
  const lastB = tokensB[tokensB.length - 1];

  const firstScore = levenshteinRatioPercent(firstA, firstB);
  const lastScore = levenshteinRatioPercent(lastA, lastB);

  // Both first and last name must match well (weighted: 40% first, 60% last)
  // If either is very low, penalize heavily
  if (firstScore < 50 || lastScore < 50) return Math.min(firstScore, lastScore);
  return Math.round(firstScore * 0.4 + lastScore * 0.6);
}

/**
 * Smart Name Confidence — Multi-Strategy (เอาคะแนนสูงสุดจาก 3 วิธี):
 * 1. Levenshtein (char-by-char) — ดีสำหรับ typo
 * 2. Token Subset — ดีสำหรับชื่อจองไม่ครบ / มี middle name
 * 3. First+Last — ดีสำหรับชื่อยาวมาก แต่ชื่อ-นามสกุลตรง
 */
export function smartNameConfidence(a: string, b: string): number {
  const lev = levenshteinRatioPercent(a, b);
  const subset = tokenSubsetConfidence(a, b);
  const fl = firstLastConfidence(a, b);
  return Math.max(lev, subset, fl);
}

export function mapCheckinPaymentMethod(raw: unknown): "cash" | "transfer" | "credit_card" | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value === "cash") return "cash";
  if (value === "card" || value === "credit_card" || value === "credit") return "credit_card";
  if (value === "transfer" || value === "bank_transfer") return "transfer";
  if (value === "qr" || value === "promptpay") return "transfer";
  return null;
}

export async function requireMobileCheckinAuth(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  request: NextRequest
): Promise<{ userId: string; role: MobileCheckinRole }> {
  const user = await getAuthenticatedUser(supabase, request);
  if (!user) {
    throw new MobileCheckinError("Unauthorized", 401, "UNAUTHORIZED");
  }

  const roleValue = await getUserRole(supabase, user.id);
  const role = String(roleValue ?? "").toLowerCase();
  if (!ALLOWED_ROLES.has(role)) {
    throw new MobileCheckinError("Forbidden", 403, "FORBIDDEN");
  }

  return { userId: user.id, role: role as MobileCheckinRole };
}

export async function getBusinessDate(
  supabase: ReturnType<typeof createServerSupabaseClient>
): Promise<string> {
  const { data, error } = await supabase
    .from("hotel_settings")
    .select("business_date")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    throw new MobileCheckinError(error.message, 500, "SETTINGS_READ_FAILED");
  }

  const businessDate = String(data?.business_date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    return toBangkokDate();
  }

  return businessDate;
}

export async function fetchProfileCompleteness(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  guestProfileId: string | null
): Promise<{ is_complete: boolean; missing_fields: string[] }> {
  if (!guestProfileId) {
    return {
      is_complete: false,
      missing_fields: ["first_name", "last_name", "gender", "nationality_code", "id_type", "country"],
    };
  }

  const { data: profile, error } = await supabase
    .from("guest_profiles")
    .select("first_name, last_name, gender, nationality_code, id_type, id_number, country, province, phone")
    .eq("id", guestProfileId)
    .maybeSingle();

  if (error) {
    throw new MobileCheckinError(error.message, 500, "PROFILE_READ_FAILED");
  }

  const completeness = checkProfileCompleteness(profile ?? null);
  return {
    is_complete: completeness.is_complete,
    missing_fields: completeness.missing_fields,
  };
}

function buildGuestProfilePatch(guestInfo: MobileGuestInfoInput, passportRaw?: Record<string, unknown> | null) {
  const fullName = normalizeWhitespace(guestInfo.full_name);
  const { firstName, lastName } = resolveNameParts({ ...guestInfo, full_name: fullName });
  const passportNo = normalizePassportNo(guestInfo.passport_no);
  const nationalityCode = normalizeNationalityCode(guestInfo.nationality ?? null);
  const country = getCountryByCode(nationalityCode);
  const dob = normalizeIsoDate(guestInfo.date_of_birth ?? null);
  const gender = normalizeGender(guestInfo.gender);

  const patch: Record<string, unknown> = {
    first_name: firstName || null,
    last_name: lastName || "Unknown",
  };

  if (passportNo) {
    patch.id_type = "passport";
    patch.id_number = passportNo;
    patch.passport_no = passportNo;
  }
  if (nationalityCode) {
    patch.nationality_code = nationalityCode;
    patch.country = country ?? null;
  }
  if (dob) {
    patch.dob = dob;
  }
  if (gender) {
    patch.gender = gender;
  }
  if (passportRaw) {
    patch.passport_raw = passportRaw;
  }

  return patch;
}

async function updateGuestProfile(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  profileId: string,
  patch: Record<string, unknown>,
  conflictContext?: GuestProfileConflictContextBase
): Promise<string> {
  try {
    const mutation = await updateGuestProfileWithConflictHandling({
      supabase,
      profileId,
      payload: patch,
      logContext: conflictContext,
    });
    const resolvedProfileId = String(mutation.profile?.id ?? "").trim();
    if (resolvedProfileId) {
      return resolvedProfileId;
    }
    throw new Error("Guest profile update returned no profile.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update guest profile.";
    throw new MobileCheckinError(message, 500, "PROFILE_UPDATE_FAILED");
  }
}

async function shouldReuseLinkedPrimaryProfile(params: {
  supabase: ReturnType<typeof createServerSupabaseClient>;
  reservationId: string;
  profileId: string;
  fallbackName: string;
}): Promise<boolean> {
  const { supabase, reservationId, profileId, fallbackName } = params;
  if (!profileId) return false;

  const { data: profileRow, error: profileReadError } = await supabase
    .from("guest_profiles")
    .select("id, first_name, last_name")
    .eq("id", profileId)
    .maybeSingle();

  if (profileReadError) {
    throw new MobileCheckinError(profileReadError.message, 500, "PROFILE_READ_FAILED");
  }
  if (!profileRow?.id) return false;

  const profileName = `${String(profileRow.first_name ?? "").trim()} ${String(profileRow.last_name ?? "").trim()}`.trim();
  const nameMatch = classifyGuestNameMatch(profileName, fallbackName);
  if (nameMatch === "mismatch") return false;

  // Booking name can differ, but when the actual check-in name is empty/partial
  // we allow the already linked profile to continue.
  return true;
}

export async function resolvePrimaryGuestProfile(params: {
  supabase: ReturnType<typeof createServerSupabaseClient>;
  reservationId: string;
  preferredGuestProfileId?: string | null;
  existingGuestProfileId?: string | null;
  guestInfo: MobileGuestInfoInput;
  passportRaw?: Record<string, unknown> | null;
  conflictContext?: GuestProfileConflictContextBase;
}): Promise<{ guestProfileId: string; fullName: string }> {
  const {
    supabase,
    reservationId,
    preferredGuestProfileId,
    existingGuestProfileId,
    guestInfo,
    passportRaw,
    conflictContext,
  } = params;
  const normalizedName = normalizeWhitespace(guestInfo.full_name);
  const fallbackName = normalizedName || "Unknown Guest";

  const patch = buildGuestProfilePatch(
    {
      ...guestInfo,
      full_name: fallbackName,
    },
    passportRaw
  );

  const preferredProfileId = String(preferredGuestProfileId ?? "").trim();
  const existingProfileId = String(existingGuestProfileId ?? "").trim();
  const profileCandidateId = preferredProfileId || existingProfileId;

  let profileId = "";
  if (profileCandidateId) {
    const { data: profileRow, error: profileReadError } = await supabase
      .from("guest_profiles")
      .select("id")
      .eq("id", profileCandidateId)
      .maybeSingle();
    if (profileReadError) {
      throw new MobileCheckinError(profileReadError.message, 500, "PROFILE_READ_FAILED");
    }
    if (profileRow?.id) {
      profileId = String(profileRow.id);
    }
  }
  const lockToPreferredProfile = Boolean(preferredProfileId);

  if (profileId && !lockToPreferredProfile) {
    const canReuseLinkedProfile = await shouldReuseLinkedPrimaryProfile({
      supabase,
      reservationId,
      profileId,
      fallbackName,
    });
    if (!canReuseLinkedProfile) {
      profileId = "";
    }
  }

  if (profileId) {
    const passportNo = normalizePassportNo(guestInfo.passport_no);
    if (!lockToPreferredProfile && passportNo) {
      const existingByPassport = await findExistingGuestProfileByDocument(supabase as any, {
        idType: "passport",
        idNumber: passportNo,
      });
      if (existingByPassport?.id && String(existingByPassport.id) !== profileId) {
        profileId = String(existingByPassport.id);
      }
    }
    profileId = await updateGuestProfile(supabase, profileId, patch, conflictContext);

    const { error: reservationUpdateError } = await supabase
      .from("reservations")
      .update({ guest_profile_id: profileId })
      .eq("id", reservationId);

    if (reservationUpdateError) {
      throw new MobileCheckinError(reservationUpdateError.message, 500, "RESERVATION_LINK_PROFILE_FAILED");
    }

    return { guestProfileId: profileId, fullName: fallbackName };
  }

  const { firstName, lastName } = resolveNameParts({ ...guestInfo, full_name: fallbackName });
  const passportNo = normalizePassportNo(guestInfo.passport_no);
  const nationalityCode = normalizeNationalityCode(guestInfo.nationality ?? null);

  if (passportNo) {
    const existingByPassport = await findExistingGuestProfileByDocument(supabase as any, {
      idType: "passport",
      idNumber: passportNo,
    });
    if (existingByPassport?.id) {
      profileId = String(existingByPassport.id);
    } else {
      try {
        const mutation = await createGuestProfileWithConflictHandling({
          supabase,
          payload: {
            first_name: firstName || null,
            last_name: lastName || "Unknown",
            nationality_code: nationalityCode,
            id_type: "passport",
            id_number: passportNo,
            passport_no: passportNo,
            profile_status: "draft",
          },
          logContext: conflictContext,
        });
        profileId = String(mutation.profile?.id ?? "").trim();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to create guest profile.";
        throw new MobileCheckinError(message, 500, "PROFILE_RESOLVE_FAILED");
      }
    }
  } else {
    const resolution = await resolveGuestProfile(supabase as any, {
      first_name: firstName || null,
      last_name: lastName || "Unknown",
      nationality_code: nationalityCode,
      id_type: null,
      id_number: null,
      profile_status: "draft",
    });
    profileId = String(resolution.profile?.id ?? "").trim();
  }

  if (!profileId) {
    throw new MobileCheckinError("Failed to resolve guest profile.", 500, "PROFILE_RESOLVE_FAILED");
  }

  profileId = await updateGuestProfile(supabase, profileId, patch, conflictContext);

  const { error: reservationUpdateError } = await supabase
    .from("reservations")
    .update({ guest_profile_id: profileId })
    .eq("id", reservationId);

  if (reservationUpdateError) {
    throw new MobileCheckinError(reservationUpdateError.message, 500, "RESERVATION_LINK_PROFILE_FAILED");
  }

  return { guestProfileId: profileId, fullName: fallbackName };
}

export async function syncAccompanyingGuests(params: {
  supabase: ReturnType<typeof createServerSupabaseClient>;
  reservationId: string;
  primaryGuestProfileId: string;
  accompanyingGuests: MobileAccompanyingInput[];
  conflictContext?: GuestProfileConflictContextBase;
}): Promise<void> {
  const { supabase, reservationId, primaryGuestProfileId, accompanyingGuests, conflictContext } = params;

  const cleaned = accompanyingGuests
    .map((guest) => ({
      ...guest,
      full_name: normalizeWhitespace(guest.full_name),
      first_name: normalizeWhitespace(guest.first_name),
      last_name: normalizeWhitespace(guest.last_name),
      passport_no: normalizePassportNo(guest.passport_no),
      nationality: normalizeWhitespace(guest.nationality),
      date_of_birth: normalizeIsoDate(guest.date_of_birth),
      gender: guest.gender,
    }))
    .filter((guest) => guest.full_name)
    .slice(0, 3);

  const rows: Array<{
    reservation_id: string;
    guest_profile_id: string;
    role: "accompanying";
    display_order: number;
    passport_scan_id?: string | null;
  }> = [];

  for (let idx = 0; idx < cleaned.length; idx += 1) {
    const guest = cleaned[idx];
    const { firstName, lastName } = resolveNameParts(guest);
    const nationalityCode = normalizeNationalityCode(guest.nationality ?? null);
    let profileId = "";
    if (guest.passport_no) {
      const existingByPassport = await findExistingGuestProfileByDocument(supabase as any, {
        idType: "passport",
        idNumber: guest.passport_no,
      });
      if (existingByPassport?.id) {
        profileId = String(existingByPassport.id);
      } else {
        try {
          const mutation = await createGuestProfileWithConflictHandling({
            supabase,
            payload: {
              first_name: firstName || null,
              last_name: lastName || "Unknown",
              nationality_code: nationalityCode,
              id_type: "passport",
              id_number: guest.passport_no,
              passport_no: guest.passport_no,
              profile_status: "draft",
            },
            logContext: conflictContext,
          });
          profileId = String(mutation.profile?.id ?? "").trim();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to create accompanying guest profile.";
          throw new MobileCheckinError(message, 500, "PROFILE_RESOLVE_FAILED");
        }
      }
    } else {
      const resolution = await resolveGuestProfile(supabase as any, {
        first_name: firstName || null,
        last_name: lastName || "Unknown",
        nationality_code: nationalityCode,
        id_type: null,
        id_number: null,
        profile_status: "draft",
      });
      profileId = String(resolution.profile?.id ?? "").trim();
    }

    if (!profileId || profileId === primaryGuestProfileId) continue;

    const patch = buildGuestProfilePatch(
      {
        full_name: guest.full_name,
        first_name: guest.first_name,
        last_name: guest.last_name,
        passport_no: guest.passport_no,
        nationality: nationalityCode,
        date_of_birth: guest.date_of_birth,
        gender: guest.gender,
      },
      null
    );
    const resolvedProfileId = await updateGuestProfile(supabase, profileId, patch, conflictContext);
    if (!resolvedProfileId || resolvedProfileId === primaryGuestProfileId) continue;

    rows.push({
      reservation_id: reservationId,
      guest_profile_id: resolvedProfileId,
      role: "accompanying",
      display_order: guest.passport_guest_index != null ? guest.passport_guest_index + 1 : idx + 2,
      passport_scan_id: guest.passport_scan_id ?? null,
    });
  }

  const { error } = await supabase.rpc("sync_accompanying_party", {
    p_reservation_id: reservationId,
    p_guests: rows,
  });
  if (error) throw new MobileCheckinError(error.message, 500, "ACCOMPANY_SYNC_FAILED");

}

export function computeMrzConfidence(parsed: any): number {
  if (!parsed) return 0;

  const fieldStatus = parsed.fieldStatus ?? {};
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];

  let confidence = 0;
  if (fieldStatus.passportNumber === "ok") confidence += 25;
  if (fieldStatus.nationality === "ok") confidence += 12;
  if (fieldStatus.firstName === "ok") confidence += 14;
  if (fieldStatus.familyName === "ok") confidence += 14;
  if (fieldStatus.gender === "ok") confidence += 10;
  if (fieldStatus.dateOfBirth === "ok") confidence += 18;
  if (String(parsed.mrzLine1 ?? "").length === 44) confidence += 3;
  if (String(parsed.mrzLine2 ?? "").length === 44) confidence += 4;

  confidence = Math.max(0, Math.min(100, confidence - warnings.length * 3));
  return Math.round(confidence);
}

export async function applyCheckinFinancials(params: {
  supabase: ReturnType<typeof createServerSupabaseClient>;
  reservationId: string;
  method: "cash" | "transfer" | "credit_card" | null;
  depositMethod?: "cash" | "transfer" | "credit_card" | null;
  paymentAmount?: number | null;
  depositAmount?: number | null;
  cashierName?: string | null;
  businessDate: string;
}): Promise<void> {
  const {
    supabase,
    reservationId,
    method,
    depositMethod,
    paymentAmount,
    depositAmount,
    cashierName,
    businessDate,
  } = params;

  const safeMethod = method ?? "cash";
  const safeDepositMethod = depositMethod ?? safeMethod;
  const safeCashier = normalizeWhitespace(cashierName) || "FO Mobile";
  const payment = Number(paymentAmount ?? 0);
  const deposit = Number(depositAmount ?? 0);
  const hasPayment = Number.isFinite(payment) && payment > 0;
  const hasDeposit = Number.isFinite(deposit) && deposit > 0;

  await assertBusinessDayOpen(supabase, businessDate);

  let existingFinancialRows: MobileCheckinFinancialRow[] = [];
  if (hasPayment || hasDeposit) {
    const { data: existingRows, error: existingRowsError } = await supabase
      .from("folio_payments")
      .select("id, tx_type, method, amount, note, revenue_category, paid_date, is_void_reversal, void_of")
      .eq("reservation_id", reservationId)
      .in("tx_type", ["payment", "deposit"]);

    if (existingRowsError) {
      throw new MobileCheckinError(existingRowsError.message, 500, "FINANCIAL_DEDUPE_READ_FAILED");
    }

    existingFinancialRows = (existingRows ?? []) as MobileCheckinFinancialRow[];
  }

  const paymentAlreadyRecorded =
    hasPayment &&
    hasMatchingMobileCheckinFinancial(existingFinancialRows, {
      txType: "payment",
      method: safeMethod,
      amount: payment,
      note: MOBILE_CHECKIN_PAYMENT_NOTE,
      revenueCategory: "room_revenue",
      paidDate: businessDate,
      allowAnyNote: true,
    });

  const depositAlreadyRecorded =
    hasDeposit &&
    hasMatchingMobileCheckinFinancial(existingFinancialRows, {
      txType: "deposit",
      method: safeDepositMethod,
      amount: deposit,
      note: MOBILE_CHECKIN_DEPOSIT_NOTE,
      revenueCategory: "deposit",
      paidDate: businessDate,
      allowAnyNote: true,
    });

  if (hasPayment && !paymentAlreadyRecorded) {
    const { error: paymentError } = await supabase
      .from("folio_payments")
      .insert({
        reservation_id: reservationId,
        tx_type: "payment",
        method: safeMethod,
        amount: payment,
        note: MOBILE_CHECKIN_PAYMENT_NOTE,
        revenue_category: "room_revenue",
        cashier_name: safeCashier,
        paid_date: businessDate,
        paid_at: new Date().toISOString(),
      });

    if (paymentError) {
      throw new MobileCheckinError(paymentError.message, 500, "PAYMENT_INSERT_FAILED");
    }
  }

  if (hasDeposit && !depositAlreadyRecorded) {
    const lines = [{ method: safeDepositMethod, amount: deposit, note: MOBILE_CHECKIN_DEPOSIT_NOTE }];
    let depositError: { message?: string | null; code?: string | null } | null = null;

    const wrappedSignature = await supabase.rpc("apply_deposit_snapshot_lines_v2", {
      p_reservation_id: reservationId,
      p_lines: lines,
      p_general_note: null,
      p_cashier_name: safeCashier,
      p_paid_date: businessDate,
    });

    if (wrappedSignature.error) {
      const wrapperMessage = String(wrappedSignature.error.message ?? "").toLowerCase();
      const canRetryDirect =
        wrappedSignature.error.code === "42883" ||
        wrapperMessage.includes("could not find the function") ||
        wrapperMessage.includes("function public.apply_deposit_snapshot_lines_v2(");

      if (!canRetryDirect) {
        depositError = wrappedSignature.error;
      }
    }

    if (!depositError && !wrappedSignature.error) {
      depositError = null;
    } else if (!depositError) {
      const nextSignature = await supabase.rpc("apply_deposit_snapshot_lines", {
      p_reservation_id: reservationId,
      p_lines: lines,
      p_general_note: null,
      p_cashier_name: safeCashier,
      p_paid_date: businessDate,
    });

      if (nextSignature.error) {
        const message = String(nextSignature.error.message ?? "").toLowerCase();
        const canRetryLegacy =
          nextSignature.error.code === "42883" ||
          message.includes("could not find the function") ||
          message.includes("function public.apply_deposit_snapshot_lines(") ||
          message.includes("could not choose the best candidate function between");

        if (canRetryLegacy) {
          const legacySignature = await supabase.rpc("apply_deposit_snapshot_lines", {
            p_reservation_id: reservationId,
            p_lines: lines,
            p_general_note: null,
            p_cashier_name: safeCashier,
          });
          depositError = legacySignature.error;
        } else {
          depositError = nextSignature.error;
        }
      }
    }

    if (depositError) {
      throw new MobileCheckinError(
        String(depositError.message ?? "Failed to apply deposit"),
        500,
        "DEPOSIT_APPLY_FAILED"
      );
    }
  }
}

export async function insertCheckinAudit(params: {
  supabase: ReturnType<typeof createServerSupabaseClient>;
  actorUserId: string;
  reservationId: string;
  action: "draft_checkin" | "checked_in" | "mobile_data_saved";
  businessDate: string;
  beforeJson?: Record<string, unknown> | null;
  afterJson?: Record<string, unknown> | null;
  note?: string | null;
}): Promise<void> {
  const { supabase, actorUserId, reservationId, action, businessDate, beforeJson, afterJson, note } = params;

  const { error } = await supabase.from("audit_logs").insert({
    actor_user_id: actorUserId,
    action,
    entity_type: "reservation",
    entity_id: reservationId,
    before_json: beforeJson ?? null,
    after_json: afterJson ?? null,
    business_date: businessDate,
    source: normalizeAuditSource("manual"),
    note: note ? String(note).trim() : null,
  });

  if (error) {
    throw new MobileCheckinError(error.message, 500, "AUDIT_INSERT_FAILED");
  }
}
