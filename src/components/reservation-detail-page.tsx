"use client";

import { useState, useEffect, useCallback, useMemo, useRef, FormEvent, KeyboardEvent } from "react";
import PmsModal from "./pms-modal";
import { BillingPanel, PendingPayment } from "./billing-panel";
import { SettlementDrawer } from "./settlement-drawer";
import { PostChargeModal } from "./post-charge-modal";
import { DepositPanel } from "./deposit-panel";
import NightCounter from "./night-counter";
import RateSummaryPanel, { BookingDiscountType, NightlyRate } from "./rate-summary-panel";
import AvailableRoomSelect from "./available-room-select";
import RatePlanSelect from "./rate-plan-select";
import ConfirmationLetter from "./confirmation-letter";
import RegistrationCard from "./registration-card";
import ReservationOptionsPanel from "./reservation-options-panel";
import { ReservationFolioModal } from "./reservation-folio-modal";
import AssignRoomModal from "./assign-room-modal";
import RoomMoveModal from "./room-move-modal";
import { ReservationHistoryModal } from "./reservation-history-modal";
import GuestMatchDropdown, { MatchResult } from "./guest-match-dropdown";
import CollapsibleSection from "./collapsible-section";
import DateInput from "./date-input";
import EarlyCheckinFeeModal, { PolicyFeePayload } from "./early-checkin-fee-modal";
import LateCheckoutFeeModal from "./late-checkout-fee-modal";
import ShortenFeeModal from "./shorten-fee-modal";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { containsMaskedPlaceholder } from "@/lib/data-masking";
import { addDays } from "@/lib/dates";
import { checkProfileCompleteness } from "@/lib/guest-profile-completeness";
import { shouldForkSharedProfile } from "@/lib/guest-booking-names";
import { buildBookedNameNoteLine, classifyGuestNameMatch } from "@/lib/guest-name-match";
import { buildDayUseExtendRequest, formatDayUseExtendConfirm } from "@/lib/dayuse-extend-confirm";
import { formatMoney, fromSatang, toSatang } from "@/lib/money";
import { NATIONALITIES, formatNationality, getCountryByCode, normalizeNationalityCode } from "@/lib/nationality-map";
import { computeHeldDepositFromRows } from "@/lib/deposit-ledger";
import { getTransferDepositSplitAmount } from "@/lib/transfer-deposit-split";
import { suggestThaiProvinces } from "@/lib/thai-provinces";
import { cleanBookingNameInput, cleanFloatingThaiMarks } from "@/lib/text-normalization";
import { formatPhoneInput } from "@/lib/phone";
import { logUiEvent } from "@/lib/ui-event-log-client";
import type { ReservationGuestWithProfile, LinkedStay } from "@/lib/types";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import LinkedStayPanel from "./linked-stay-panel";
import LinkStayModal from "./link-stay-modal";
import { useLostFoundPopup } from "@/components/providers/lost-found-popup-context";
import { passportOcrGuestIndex } from "@/lib/checkin/passport-ocr-guest-index";

type BookingMode = "create" | "edit" | "checkin" | "inhouse" | "checkout";
type ReservationRecordStatus = "active" | "cancelled" | "checked_out" | "no_show" | "";

function shouldRequestIdentityUnmask(mode: BookingMode): boolean {
    return mode === "checkin" || mode === "inhouse" || mode === "checkout";
}

function formatBangkokDateTimeLocal(input: Date | string): string {
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

function bangkokLocalToIso(localValue: string): string | null {
    if (!localValue) return null;
    const date = new Date(`${localValue}:00+07:00`);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

function extractHHmmFromLocalDateTime(localValue: string): string | undefined {
    if (!localValue) return undefined;
    if (localValue.includes("T")) {
        const timePart = localValue.split("T")[1]?.slice(0, 5);
        return timePart && /^\d{2}:\d{2}$/.test(timePart) ? timePart : undefined;
    }
    const timePart = localValue.slice(11, 16);
    return /^\d{2}:\d{2}$/.test(timePart) ? timePart : undefined;
}

function normalizeExpectedArrivalTimeDraft(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return /^\d{2}:\d{2}$/.test(trimmed) ? trimmed : "";
}

function toMoneyInput(value: unknown): string {
    return fromSatang(toSatang(value)).toFixed(2);
}

function splitGuestName(raw: string): { firstName: string; lastName: string } {
    const parts = String(raw || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { firstName: "", lastName: "" };
    if (parts.length === 1) return { firstName: parts[0], lastName: "" };
    return {
        firstName: parts.slice(0, -1).join(" "),
        lastName: parts[parts.length - 1]
    };
}

function joinGuestName(firstName: string, lastName: string): string {
    return [firstName.trim(), lastName.trim()].filter(Boolean).join(" ");
}

function parseYmdToDate(value: string): Date | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(y, m - 1, d, 12, 0, 0, 0);
    if (
        Number.isNaN(date.getTime()) ||
        date.getFullYear() !== y ||
        date.getMonth() !== m - 1 ||
        date.getDate() !== d
    ) {
        return null;
    }
    return date;
}

function normalizeDobYmd(value: unknown): string {
    const raw = String(value || "").trim();
    if (!raw) return "";

    const thaiDigitMap: Record<string, string> = {
        "๐": "0",
        "๑": "1",
        "๒": "2",
        "๓": "3",
        "๔": "4",
        "๕": "5",
        "๖": "6",
        "๗": "7",
        "๘": "8",
        "๙": "9",
    };
    const rawAsciiDigits = raw.replace(/[๐-๙]/g, (digit) => thaiDigitMap[digit] ?? digit);

    const normalizeYear = (inputYear: number): number => {
        if (inputYear >= 2400) return inputYear - 543; // Thai Buddhist Era -> Gregorian
        return inputYear;
    };

    const safeBuild = (year: number, month: number, day: number): string => {
        const yyyy = String(year).padStart(4, "0");
        const mm = String(month).padStart(2, "0");
        const dd = String(day).padStart(2, "0");
        const ymd = `${yyyy}-${mm}-${dd}`;
        return parseYmdToDate(ymd) ? ymd : "";
    };

    const isoDatePrefix = rawAsciiDigits.match(/^(\d{4})-(\d{2})-(\d{2})T/);
    if (isoDatePrefix) {
        return safeBuild(
            normalizeYear(Number(isoDatePrefix[1])),
            Number(isoDatePrefix[2]),
            Number(isoDatePrefix[3])
        );
    }

    const ymdDash = rawAsciiDigits.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymdDash) return safeBuild(normalizeYear(Number(ymdDash[1])), Number(ymdDash[2]), Number(ymdDash[3]));

    const ymdSlash = rawAsciiDigits.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (ymdSlash) return safeBuild(normalizeYear(Number(ymdSlash[1])), Number(ymdSlash[2]), Number(ymdSlash[3]));

    const dmySlash = rawAsciiDigits.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (dmySlash) return safeBuild(normalizeYear(Number(dmySlash[3])), Number(dmySlash[2]), Number(dmySlash[1]));

    const dmyDash = rawAsciiDigits.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (dmyDash) return safeBuild(normalizeYear(Number(dmyDash[3])), Number(dmyDash[2]), Number(dmyDash[1]));

    const ymdCompact = rawAsciiDigits.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (ymdCompact) return safeBuild(normalizeYear(Number(ymdCompact[1])), Number(ymdCompact[2]), Number(ymdCompact[3]));

    const dmyCompact = rawAsciiDigits.match(/^(\d{2})(\d{2})(\d{4})$/);
    if (dmyCompact) return safeBuild(normalizeYear(Number(dmyCompact[3])), Number(dmyCompact[2]), Number(dmyCompact[1]));

    const yymmdd = rawAsciiDigits.match(/^(\d{2})(\d{2})(\d{2})$/);
    if (yymmdd) {
        const yy = Number(yymmdd[1]);
        const currentYear2 = getBangkokTodayDate().getFullYear() % 100;
        const fullYear = yy <= currentYear2 ? 2000 + yy : 1900 + yy;
        return safeBuild(fullYear, Number(yymmdd[2]), Number(yymmdd[3]));
    }

    const monthMap: Record<string, number> = {
        jan: 1, january: 1,
        feb: 2, february: 2,
        mar: 3, march: 3,
        apr: 4, april: 4,
        may: 5,
        jun: 6, june: 6,
        jul: 7, july: 7,
        aug: 8, august: 8,
        sep: 9, sept: 9, september: 9,
        oct: 10, october: 10,
        nov: 11, november: 11,
        dec: 12, december: 12,
        "ม.ค": 1, "มกราคม": 1,
        "ก.พ": 2, "กุมภาพันธ์": 2,
        "มี.ค": 3, "มีนาคม": 3,
        "เม.ย": 4, "เมษายน": 4,
        "พ.ค": 5, "พฤษภาคม": 5,
        "มิ.ย": 6, "มิถุนายน": 6,
        "ก.ค": 7, "กรกฎาคม": 7,
        "ส.ค": 8, "สิงหาคม": 8,
        "ก.ย": 9, "กันยายน": 9,
        "ต.ค": 10, "ตุลาคม": 10,
        "พ.ย": 11, "พฤศจิกายน": 11,
        "ธ.ค": 12, "ธันวาคม": 12,
    };
    const normalizedWords = rawAsciiDigits
        .toLowerCase()
        .replace(/,/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const dmyWithWord = normalizedWords.match(/^(\d{1,2})\s+([a-zก-๙\.]+)\s+(\d{2,4})$/u);
    if (dmyWithWord) {
        const day = Number(dmyWithWord[1]);
        const monthLabel = dmyWithWord[2].replace(/\.$/, "");
        const month = monthMap[monthLabel] ?? 0;
        const rawYear = Number(dmyWithWord[3]);
        if (month > 0) {
            const fullYear =
                rawYear < 100
                    ? (rawYear <= (getBangkokTodayDate().getFullYear() % 100) ? 2000 + rawYear : 1900 + rawYear)
                    : normalizeYear(rawYear);
            return safeBuild(fullYear, month, day);
        }
    }

    const parsed = new Date(rawAsciiDigits);
    if (!Number.isNaN(parsed.getTime())) {
        return safeBuild(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
    }

    return "";
}

function dateToYmd(value: Date): string {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function addDaysLocal(value: Date, days: number): Date {
    const next = new Date(value);
    next.setDate(next.getDate() + days);
    next.setHours(12, 0, 0, 0);
    return next;
}

function diffDays(later: Date, earlier: Date): number {
    return Math.round((later.getTime() - earlier.getTime()) / 86400000);
}

function getBangkokTodayDate(): Date {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date());
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || "0");
    return new Date(get("year"), get("month") - 1, get("day"), 12, 0, 0, 0);
}

function daysInMonth(year: number, month1to12: number): number {
    return new Date(year, month1to12, 0).getDate();
}

function diffDateParts(fromDate: Date, toDate: Date): { years: number; months: number; days: number } {
    let years = toDate.getFullYear() - fromDate.getFullYear();
    let months = toDate.getMonth() - fromDate.getMonth();
    let days = toDate.getDate() - fromDate.getDate();

    if (days < 0) {
        months -= 1;
        const previousMonth = toDate.getMonth() === 0 ? 12 : toDate.getMonth();
        const previousMonthYear = toDate.getMonth() === 0 ? toDate.getFullYear() - 1 : toDate.getFullYear();
        days += daysInMonth(previousMonthYear, previousMonth);
    }
    if (months < 0) {
        years -= 1;
        months += 12;
    }

    return {
        years: Math.max(0, years),
        months: Math.max(0, months),
        days: Math.max(0, days),
    };
}

type BirthdayStayRelation = "during_stay" | "before_checkin" | "after_checkout";

function findBirthdayNearStayWindow(
    birthdayYmd: string,
    checkinYmd: string,
    checkoutYmd: string,
    toleranceDays = 3
): { birthdayDateYmd: string; relation: BirthdayStayRelation; distanceDays: number } | null {
    const birthDate = parseYmdToDate(birthdayYmd);
    const checkinDate = parseYmdToDate(checkinYmd);
    const checkoutDate = parseYmdToDate(checkoutYmd);
    if (!birthDate || !checkinDate || !checkoutDate) return null;

    const stayStart = checkinDate <= checkoutDate ? checkinDate : checkoutDate;
    const stayEnd = checkinDate <= checkoutDate ? checkoutDate : checkinDate;
    const windowStart = addDaysLocal(stayStart, -Math.max(0, toleranceDays));
    const windowEnd = addDaysLocal(stayEnd, Math.max(0, toleranceDays));

    const birthMonth = birthDate.getMonth();
    const birthDay = birthDate.getDate();
    const yearStart = stayStart.getFullYear() - 1;
    const yearEnd = stayEnd.getFullYear() + 1;
    const candidates: Date[] = [];

    for (let year = yearStart; year <= yearEnd; year += 1) {
        const candidate = new Date(year, birthMonth, birthDay, 12, 0, 0, 0);
        if (candidate.getMonth() !== birthMonth || candidate.getDate() !== birthDay) continue;
        if (candidate < windowStart || candidate > windowEnd) continue;
        candidates.push(candidate);
    }
    if (candidates.length === 0) return null;

    const scored = candidates
        .map((candidate) => {
            if (candidate >= stayStart && candidate <= stayEnd) {
                return {
                    candidate,
                    relation: "during_stay" as BirthdayStayRelation,
                    distanceDays: 0,
                };
            }
            if (candidate < stayStart) {
                return {
                    candidate,
                    relation: "before_checkin" as BirthdayStayRelation,
                    distanceDays: diffDays(stayStart, candidate),
                };
            }
            return {
                candidate,
                relation: "after_checkout" as BirthdayStayRelation,
                distanceDays: diffDays(candidate, stayEnd),
            };
        })
        .sort((a, b) => {
            if (a.distanceDays !== b.distanceDays) return a.distanceDays - b.distanceDays;
            return a.candidate.getTime() - b.candidate.getTime();
        });

    const best = scored[0];
    return {
        birthdayDateYmd: dateToYmd(best.candidate),
        relation: best.relation,
        distanceDays: best.distanceDays,
    };
}

const PAYMENT_METHODS = [
    { value: "cash", label: "Cash" },
    { value: "transfer", label: "Transfer" },
    { value: "credit_card", label: "Card" },
];

type DepositLine = {
    method: string;
    amount: number;
    note?: string;
};

type DepositParseResult = {
    lines: DepositLine[];
    note: string;
    warning: string;
};

type PendingCheckinPayment = {
    method: "cash" | "transfer" | "credit_card";
    amount: number;
    note?: string;
    transfer_detail?: PendingPayment["transfer_detail"];
    transfer_deposit_split?: PendingPayment["transfer_deposit_split"];
};

type RoomMoveHistoryItem = {
    moved_at: string | null;
    move_date: string;
    from_room_number: string;
    to_room_number: string;
    reason: string;
};

type CreatedReservationSummary = {
    bookingCode: string;
    guestName: string;
    source: string;
    roomTypeName: string;
    roomNumber: string | null;
    roomPathLabel?: string | null;
    checkinDate: string;
    checkoutDate: string;
    nights: number;
    totalPrice: number;
    createdReservationId?: string | null;
    canContinueToCheckin?: boolean;
};

type ContinuousStayPreviewSegment = {
    start_date: string;
    end_date: string;
    room_id: string;
    room_number: string;
    room_type_id: number;
    room_type_name: string;
    nightly_rates: Array<{ stay_date: string; rate: number }>;
    subtotal: number;
    available_rooms?: Array<{
        room_id: string;
        room_number: string;
        room_type_id: number;
        room_type_name: string;
        nightly_rates: Array<{ stay_date: string; rate: number }>;
        subtotal: number;
    }>;
};

type ContinuousStayPreviewState = {
    requires_continuous_plan: boolean;
    blocked_nights: Array<{
        stay_date: string;
        requested_room_number: string | null;
        requested_room_type_name: string;
        assigned_room_number: string;
        assigned_room_type_name: string;
    }>;
    segments: ContinuousStayPreviewSegment[];
    totals: {
        subtotal: number;
        discount_amount: number;
        total: number;
        nights: number;
    };
};

const DEFAULT_CHECKIN_DEPOSIT_INPUT = "200.00";
const NETWORK_TIMEOUT_MS = 15000;

function formatYmdAsDmy(value: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return value;
    return `${match[3]}/${match[2]}/${match[1]}`;
}

function formatContinuousStaySegmentRange(segment: ContinuousStayPreviewSegment): string {
    const lastNight = addDays(segment.end_date, -1);
    if (segment.start_date === lastNight) return formatYmdAsDmy(segment.start_date);
    return `${formatYmdAsDmy(segment.start_date)} - ${formatYmdAsDmy(lastNight)}`;
}

function formatContinuousStayRoomPath(segments?: ContinuousStayPreviewSegment[] | null): string | null {
    if (!segments || segments.length === 0) return null;
    return segments
        .map((segment) => `Room ${segment.room_number} (${formatContinuousStaySegmentRange(segment)})`)
        .join(" → ");
}

const BOOKING_SOURCE_LABEL: Record<string, string> = {
    walkin: "Walk-in",
    direct: "Direct",
    ota: "OTA",
    agent: "Agent"
};

type ThaiCardImportPayload = {
    citizenId: string;
    titleTH?: string;
    firstNameTH?: string;
    lastNameTH?: string;
    titleEN?: string;
    firstNameEN?: string;
    lastNameEN?: string;
    birthday?: string;
    gender?: string;
    address?: string;
    province?: string;
    issue?: string;
    expire?: string;
};

type PassportOcrImportPayload = {
    firstName?: string | null;
    familyName?: string | null;
    nationality?: string | null;
    passportNumber?: string | null;
    gender?: "M" | "F" | "X" | null;
    dateOfBirth?: string | null;
    mrzLine1?: string;
    mrzLine2?: string;
    fieldStatus?: {
        passportNumber?: "ok" | "manual_check";
        nationality?: "ok" | "manual_check";
        firstName?: "ok" | "manual_check";
        familyName?: "ok" | "manual_check";
        gender?: "ok" | "manual_check";
        dateOfBirth?: "ok" | "manual_check";
    };
    warnings?: string[];
};

type IdentityImportTarget = "main" | "accompany";
type IdentityScanSource = "thai_id" | "passport_ocr";
type ProfileGenderValue = "" | "M" | "F" | "Other";
type ProfileIdTypeValue = "" | "thai_id" | "passport" | "other";
type IdentityScanNoticeKind = "under18" | "over18" | "birthday";
type IdentityScanNotice = {
    severity: "warning" | "success";
    kind: IdentityScanNoticeKind;
    message: string;
};

type IdentityAlertSettings = {
    identity_alert_under18_thai_id_enabled: boolean;
    identity_alert_under18_passport_enabled: boolean;
    identity_alert_over18_thai_id_enabled: boolean;
    identity_alert_over18_passport_enabled: boolean;
    identity_alert_birthday_enabled: boolean;
};

type CheckinAssignedRoomStatus = {
    room_id: string;
    room_number: string;
    hk_status: string | null;
    due_out: boolean;
    back_to_back: boolean;
    in_house: boolean;
    guest_name?: string | null;
    due_out_guest_name?: string | null;
};

const DEFAULT_IDENTITY_ALERT_SETTINGS: IdentityAlertSettings = {
    identity_alert_under18_thai_id_enabled: true,
    identity_alert_under18_passport_enabled: true,
    identity_alert_over18_thai_id_enabled: true,
    identity_alert_over18_passport_enabled: true,
    identity_alert_birthday_enabled: true,
};

function mergeIdentityAlertSettings(raw: unknown): IdentityAlertSettings {
    const source = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
    return {
        identity_alert_under18_thai_id_enabled:
            source.identity_alert_under18_thai_id_enabled == null
                ? DEFAULT_IDENTITY_ALERT_SETTINGS.identity_alert_under18_thai_id_enabled
                : Boolean(source.identity_alert_under18_thai_id_enabled),
        identity_alert_under18_passport_enabled:
            source.identity_alert_under18_passport_enabled == null
                ? DEFAULT_IDENTITY_ALERT_SETTINGS.identity_alert_under18_passport_enabled
                : Boolean(source.identity_alert_under18_passport_enabled),
        identity_alert_over18_thai_id_enabled:
            source.identity_alert_over18_thai_id_enabled == null
                ? DEFAULT_IDENTITY_ALERT_SETTINGS.identity_alert_over18_thai_id_enabled
                : Boolean(source.identity_alert_over18_thai_id_enabled),
        identity_alert_over18_passport_enabled:
            source.identity_alert_over18_passport_enabled == null
                ? DEFAULT_IDENTITY_ALERT_SETTINGS.identity_alert_over18_passport_enabled
                : Boolean(source.identity_alert_over18_passport_enabled),
        identity_alert_birthday_enabled:
            source.identity_alert_birthday_enabled == null
                ? DEFAULT_IDENTITY_ALERT_SETTINGS.identity_alert_birthday_enabled
                : Boolean(source.identity_alert_birthday_enabled),
    };
}

function resolveCheckinAssignedRoomCapsule(status: CheckinAssignedRoomStatus | null): {
    label: string;
    className: string;
    title?: string;
} | null {
    if (!status) return null;

    const occupiedGuestName = status.due_out_guest_name || status.guest_name || null;
    if (status.due_out || status.back_to_back) {
        return {
            label: "Due Out",
            className: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300",
            title: occupiedGuestName ? `Guest still in room: ${occupiedGuestName}` : "Room still has a due-out guest."
        };
    }

    if (status.hk_status === "dirty") {
        return {
            label: "Dirty",
            className: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-300"
        };
    }

    if (status.hk_status === "in_progress" || status.hk_status === "paused") {
        return {
            label: "In Progress",
            className: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/15 dark:text-sky-300"
        };
    }

    if (status.hk_status === "approved" || status.hk_status === "cleaned" || status.hk_status === "available") {
        return {
            label: "Ready",
            className: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300"
        };
    }

    return null;
}

type PartyDraft = {
    linkedMemberId: string | null;
    guestProfileId: string | null;
    firstName: string;
    lastName: string;
    phone: string;
    nationalityCode: string;
    country: string;
    gender: ProfileGenderValue;
    idType: ProfileIdTypeValue;
    idNumber: string;
    dob: string;
    profileStatus: "draft" | "verified" | "merged" | "blacklisted" | "";
};

type ShortenSettlementPreview = {
    prepaid_net: number;
    old_total: number;
    new_total: number;
    overpaid: number;
    fee_cap: number;
    default_no_fee: boolean;
    warning?: string | null;
    suggested_refund_method?: "cash" | "transfer";
};

const THAI_CARD_NOTE_START = "[[THAI_CARD_NAME]]";
const THAI_CARD_NOTE_END = "[[/THAI_CARD_NAME]]";

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const THAI_NAME_PREFIXES = [
    "ร้อยตำรวจเอก", "ร้อยตำรวจโท", "ร้อยตำรวจตรี",
    "พันตำรวจเอก", "พันตำรวจโท", "พันตำรวจตรี",
    "พลตำรวจเอก", "พลตำรวจโท", "พลตำรวจตรี", "พลตำรวจจัตวา",
    "ร้อยเอก", "ร้อยโท", "ร้อยตรี",
    "พันเอก", "พันโท", "พันตรี",
    "พลเอก", "พลโท", "พลตรี",
    "พล.ต.อ.", "พล.ต.ท.", "พล.ต.ต.", "พล.ต.จ.",
    "พ.ต.อ.", "พ.ต.ท.", "พ.ต.ต.",
    "ร.ต.อ.", "ร.ต.ท.", "ร.ต.ต.",
    "จ.ส.ต.", "ส.ต.อ.", "ส.ต.ท.", "ส.ต.ต.", "ด.ต.",
    "พลตอ", "พลตท", "พลตต", "พลตจ", "พตอ", "พตท", "พตต", "รตอ", "รตท", "รตต",
    "พล.อ.", "พล.ท.", "พล.ต.",
    "พ.อ.", "พ.ท.", "พ.ต.",
    "ร.อ.", "ร.ท.", "ร.ต.",
    "น.อ.", "น.ท.", "น.ต.",
    "จ.ส.อ.", "จ.ส.ท.", "จ.ส.ต.",
    "พ.อ.อ.", "พ.อ.ท.", "พ.อ.ต.",
    "ส.อ.", "ส.ท.", "ส.ต.",
    "จ.อ.", "จ.ท.", "จ.ต.",
    "น.ส.", "ด.ช.", "ด.ญ.", "นส", "ดช", "ดญ",
    "นาย", "นางสาว", "นาง", "เด็กชาย", "เด็กหญิง",
    "ดร.", "ศ.", "รศ.", "ผศ.", "นพ.", "พญ.",
];

const THAI_NAME_PREFIX_PATTERN = new RegExp(
    `^(?:${THAI_NAME_PREFIXES.sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})(?:\\s*หญิง)?(?:\\s+|$)`,
    "u"
);

function stripLeadingThaiNamePrefixes(value: string): string {
    let next = String(value || "").replace(/\s+/g, " ").trim();
    let previous = "";
    while (next && next !== previous) {
        previous = next;
        next = next.replace(THAI_NAME_PREFIX_PATTERN, "").trim();
    }
    return next;
}

function buildThaiCardNameParts(title: unknown, firstName: unknown, lastName: unknown): { firstName: string; lastName: string } {
    const normalized = stripLeadingThaiNamePrefixes(
        [title, firstName, lastName].map((part) => String(part || "").trim()).filter(Boolean).join(" ")
    );
    const parts = normalized.split(/\s+/u).filter(Boolean);
    return {
        firstName: parts[0] ?? "",
        lastName: parts.slice(1).join(" "),
    };
}

function buildPreferredCardName(payload: ThaiCardImportPayload): { firstName: string; lastName: string; fullName: string } {
    const thaiName = buildThaiCardNameParts(payload.titleTH, payload.firstNameTH, payload.lastNameTH);
    const thaiFirst = thaiName.firstName;
    const thaiLast = thaiName.lastName;
    const englishFirst = String(payload.firstNameEN || "").trim();
    const englishLast = String(payload.lastNameEN || "").trim();
    const firstName = thaiFirst || englishFirst;
    const lastName = thaiLast || englishLast;
    return {
        firstName,
        lastName,
        fullName: joinGuestName(firstName, lastName),
    };
}

function upsertBookedMainGuestNameNote(existing: string, bookedName: string): string {
    const nextLine = buildBookedNameNoteLine(bookedName);
    if (!nextLine) return String(existing || "").trim();
    const current = String(existing || "").trim();
    const retained = current
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => !line.trim().startsWith("จองมาในชื่อ "));
    retained.push(nextLine);
    return retained.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function removeThaiCardNameBlock(existing: string): string {
    const current = String(existing || "").trim();
    if (!current) return "";
    const pattern = new RegExp(
        `${escapeRegExp(THAI_CARD_NOTE_START)}[\\s\\S]*?${escapeRegExp(THAI_CARD_NOTE_END)}`,
        "g"
    );
    return current.replace(pattern, "").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeThaiCardGender(value: unknown): "" | "M" | "F" | "Other" {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "m" || raw === "male" || raw === "1") return "M";
    if (raw === "f" || raw === "female" || raw === "2") return "F";
    if (!raw) return "";
    return "Other";
}

function normalizeThaiCardCitizenId(value: unknown): string {
    return String(value || "").replace(/\D+/g, "").slice(0, 13);
}

function extractLastProvinceToken(raw: unknown): string {
    const normalized = String(raw || "").replace(/#/g, " ").replace(/\s+/g, " ").trim();
    if (!normalized) return "";

    const withoutPostalCode = normalized.replace(/\s+\d{5}$/u, "").trim();
    if (!withoutPostalCode) return "";

    const tokens = withoutPostalCode.split(/\s+/u);
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
        const token = tokens[i]
            .replace(/^(จังหวัด|จ\.?)/u, "")
            .replace(/[,\-]/g, "")
            .trim();
        const thaiWord = token.replace(/[^ก-๙]/gu, "").trim();
        if (thaiWord) return thaiWord;
    }
    return "";
}

function extractThaiProvince(rawAddress: unknown, explicitProvince?: unknown): string {
    const fromAddress = extractLastProvinceToken(rawAddress);
    if (fromAddress) return fromAddress;
    return extractLastProvinceToken(explicitProvince);
}

function closeChildPopup(popup: Window | null) {
    if (!popup || popup.closed) return;
    const attemptClose = () => {
        try {
            popup.close();
        } catch {
            // ignore close failures
        }
    };
    attemptClose();
    window.setTimeout(attemptClose, 150);
    window.setTimeout(attemptClose, 500);
}

function notifyPopupToClose(source: MessageEventSource | null, origin: string) {
    if (!source || typeof (source as WindowProxy).postMessage !== "function") return;
    try {
        (source as WindowProxy).postMessage({ type: "PMS_THAI_CARD_IMPORTED" }, origin);
    } catch {
        // ignore cross-window failures
    }
}

function broadcastSmartCardClose(requestId?: string | null) {
    if (typeof window === "undefined" || typeof window.BroadcastChannel === "undefined") return;
    try {
        const channel = new window.BroadcastChannel("pms-smart-card");
        channel.postMessage({ type: "PMS_THAI_CARD_CLOSE", requestId: requestId || undefined });
        channel.close();
    } catch {
        // ignore broadcast failures
    }
}

function forceClosePopup(popup: Window | null, requestId?: string | null) {
    broadcastSmartCardClose(requestId);
    if (!popup || popup.closed) return;
    const attemptClose = () => {
        try {
            popup.close();
        } catch {
            // ignore close failures
        }
    };
    attemptClose();
    window.setTimeout(attemptClose, 150);
    window.setTimeout(attemptClose, 500);
}

function runAfterPopupCloseSettle(callback: () => void, delayMs = 250) {
    if (typeof window === "undefined") {
        callback();
        return;
    }
    window.setTimeout(callback, delayMs);
}

function traceSmartCardUiEvent(params: {
    requestId?: string | null;
    reservationId?: string | null;
    eventName: string;
    message: string;
    metadata?: Record<string, unknown>;
    severity?: "info" | "warning" | "error";
}) {
    if (typeof window === "undefined") return;
    logUiEvent({
        pathname: window.location.pathname,
        event_type: "smart_card",
        event_name: params.eventName,
        severity: params.severity ?? "info",
        entity_type: "reservation",
        entity_id: params.reservationId ?? null,
        request_id: params.requestId ?? null,
        message: params.requestId ? `${params.message} [${params.requestId}]` : params.message,
        metadata: params.metadata,
    });
}

function normalizePassportNumber(value: unknown): string {
    return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeIdentityNumberByType(value: string, idType: ProfileIdTypeValue): string {
    if (idType === "thai_id") {
        return String(value || "").replace(/\D+/g, "").slice(0, 13);
    }
    if (idType === "passport") {
        return String(value || "").toUpperCase();
    }
    return String(value || "");
}

function isMaskedIdentityValue(value: unknown, isMasked = false): boolean {
    return isMasked || containsMaskedPlaceholder(value);
}

function sanitizeIdentityForSubmit(value: unknown, isMasked = false): string {
    const trimmed = String(value || "").trim();
    if (!trimmed) return "";
    return isMaskedIdentityValue(trimmed, isMasked) ? "" : trimmed;
}

function hasInvalidThaiId(value: unknown, isMasked = false): boolean {
    const sanitized = sanitizeIdentityForSubmit(value, isMasked);
    return sanitized.length > 0 && !/^\d{13}$/.test(sanitized);
}

function createEmptyPartyDraft(): PartyDraft {
    return {
        linkedMemberId: null,
        guestProfileId: null,
        firstName: "",
        lastName: "",
        phone: "",
        nationalityCode: "",
        country: "",
        gender: "",
        idType: "",
        idNumber: "",
        dob: "",
        profileStatus: "draft",
    };
}

function buildPartyDraftFromProfile(profile: any, linkedMemberId: string | null = null): PartyDraft {
    const normalizedCode = normalizeNationalityCode(profile?.nationality_code || profile?.nationality);
    const rawIdentityNumber = String(profile?.id_number || profile?.passport_no || profile?.id_card_number || "").trim();
    return {
        linkedMemberId,
        guestProfileId: profile?.id ? String(profile.id) : null,
        firstName: String(profile?.first_name || "").trim(),
        lastName: String(profile?.last_name || "").trim(),
        phone: String(profile?.phone || "").trim(),
        nationalityCode: normalizedCode || "",
        country: String(profile?.country || getCountryByCode(normalizedCode) || "").trim(),
        gender: profile?.gender === "M" || profile?.gender === "F" || profile?.gender === "Other" ? profile.gender : "",
        idType: profile?.id_type === "thai_id" || profile?.id_type === "passport" || profile?.id_type === "other" ? profile.id_type : "",
        idNumber: isMaskedIdentityValue(rawIdentityNumber, profile?._masked === true) ? "" : rawIdentityNumber,
        dob: String(profile?.dob || "").slice(0, 10),
        profileStatus:
            profile?.profile_status === "draft" ||
                profile?.profile_status === "verified" ||
                profile?.profile_status === "merged" ||
                profile?.profile_status === "blacklisted"
                ? profile.profile_status
                : "draft",
    };
}

function parseDepositState(rawNote: unknown, depositAmount: number): DepositParseResult {
    const totalAmount = Number(depositAmount) || 0;
    const rawText = typeof rawNote === "string" ? rawNote.trim() : "";
    let parsedNoteFromJson = "";
    let parsedJson = false;

    const fallbackMethod = rawText.length > 0 ? rawText : "cash";
    const fallbackLine: DepositLine = { method: fallbackMethod, amount: totalAmount };

    if (!rawText) {
        return {
            lines: totalAmount > 0 ? [fallbackLine] : [],
            note: "",
            warning: ""
        };
    }

    try {
        const parsed = JSON.parse(rawText);
        parsedJson = true;
        const parsedLinesRaw = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.lines)
                ? parsed.lines
                : [];
        const parsedLines: DepositLine[] = parsedLinesRaw
            .map((line: any) => ({
                method: typeof line?.method === "string" && line.method.trim().length > 0 ? line.method : "cash",
                amount: Number(line?.amount) || 0,
                note: typeof line?.note === "string" ? line.note : ""
            }))
            .filter((line: DepositLine) => line.amount > 0);
        const parsedTotal = parsedLines.reduce((sum, line) => sum + line.amount, 0);
        const parsedNote = typeof parsed?.note === "string"
            ? parsed.note.trim()
            : typeof parsed?.reason === "string"
                ? parsed.reason.trim()
                : typeof parsed?.no_deposit_note === "string"
                    ? parsed.no_deposit_note.trim()
                    : "";
        parsedNoteFromJson = parsedNote;

        if (totalAmount <= 0) {
            return {
                lines: [],
                note: parsedNote,
                warning: parsedJson ? "Deposit note stored as a snapshot." : ""
            };
        }

        if (parsedLines.length > 0) {
            return {
                lines: parsedLines,
                note: parsedNote,
                warning: parsedJson ? "Deposit note stored as a snapshot." : ""
            };
        }
    } catch {
        // Fallback to single-line representation for legacy note text.
    }

    if (totalAmount <= 0) {
        return {
            lines: [],
            note: rawText,
            warning: ""
        };
    }

    if (parsedJson) {
        return {
            lines: totalAmount > 0 ? [{ method: "cash", amount: totalAmount }] : [],
            note: parsedNoteFromJson,
            warning: "Deposit note stored as a snapshot."
        };
    }

    return {
        lines: [fallbackLine],
        note: parsedNoteFromJson,
        warning: ""
    };
}

interface ReservationDetailPageProps {
    mode: BookingMode;
    reservationId?: string;
    roomNumber?: string;
    bookingGroupId?: string;
    isDayUse?: boolean;
    initialRoomTypeId?: string;
    initialCheckinDate?: string;
    initialCheckoutDate?: string;
    onClose: () => void;
    onSuccess: () => void;
    onOpenCheckin?: (reservationId: string) => void;
}

export default function ReservationDetailPage({
    mode,
    reservationId: propReservationId,
    roomNumber,
    bookingGroupId,
    isDayUse = false,
    initialRoomTypeId,
    initialCheckinDate,
    initialCheckoutDate,
    onClose,
    onSuccess,
    onOpenCheckin
}: ReservationDetailPageProps) {

    const router = useRouter();
    const { showPopup } = useLostFoundPopup();
    const [isCheckedOutEditAdmin, setIsCheckedOutEditAdmin] = useState(false);
    const [reservationId, setReservationId] = useState(propReservationId);
    
    useEffect(() => {
        setReservationId(propReservationId);
    }, [propReservationId]);

    useEffect(() => {
        let mounted = true;

        const loadCheckedOutEditRole = async () => {
            try {
                const supabase = createBrowserSupabaseClient();
                const { data: { user } } = await supabase.auth.getUser();
                if (!user) {
                    if (mounted) setIsCheckedOutEditAdmin(false);
                    return;
                }

                const { data } = await supabase
                    .from("profiles")
                    .select("role")
                    .eq("user_id", user.id)
                    .single();

                const role = String(data?.role ?? "").trim().toLowerCase();
                if (mounted) setIsCheckedOutEditAdmin(role === "admin");
            } catch {
                if (mounted) setIsCheckedOutEditAdmin(false);
            }
        };

        void loadCheckedOutEditRole();

        return () => {
            mounted = false;
        };
    }, []);

    const handleSwitchLinkedTab = (newId: string) => {
        setReservationId(newId);
        if (typeof window !== "undefined" && window.location.pathname.includes("/reservations")) {
            const url = new URL(window.location.href);
            url.searchParams.set("open", newId);
            router.replace(url.pathname + url.search);
        }
    };

    const [linkedStay, setLinkedStay] = useState<LinkedStay | null>(null);
    const [loading, setLoading] = useState(false);
    const [rateRefreshing, setRateRefreshing] = useState(false);
    const [fetching, setFetching] = useState(mode !== "create");
    const [error, setError] = useState("");
    const [showAssignRoomModal, setShowAssignRoomModal] = useState(false);
    const [showLinkStayModal, setShowLinkStayModal] = useState(false);
    const [showPreArrivalPlanMoveModal, setShowPreArrivalPlanMoveModal] = useState(false);
    const rateRefreshSeqRef = useRef(0);
    const thaiCardPopupRef = useRef<Window | null>(null);
    const thaiCardRequestIdRef = useRef<string | null>(null);
    const processedSmartCardRequestIdsRef = useRef<Set<string>>(new Set());

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    // Core Booking State
    const [checkinDate, setCheckinDate] = useState(today);
    const [checkoutDate, setCheckoutDate] = useState(tomorrow);
    const [nights, setNights] = useState(1);
    const [source, setSource] = useState("walkin");
    const [roomTypeId, setRoomTypeId] = useState("");
    const [originalRoomTypeId, setOriginalRoomTypeId] = useState("");
    const [initialAssignedRoomTypeId, setInitialAssignedRoomTypeId] = useState("");
    const [useSelectedRoomTypeForCharge, setUseSelectedRoomTypeForCharge] = useState(true);
    const [roomId, setRoomId] = useState("");
    const [initialAssignedRoomId, setInitialAssignedRoomId] = useState("");
    const [checkedInAt, setCheckedInAt] = useState("");
    const [otaRef, setOtaRef] = useState("");

    useEffect(() => {
        if (mode !== "create") return;
        setHasMainGuestIdentityImport(false);
        const nextCheckin = initialCheckinDate || today;
        const nextCheckout = initialCheckoutDate || tomorrow;
        const nextNights = Math.max(
            1,
            Math.ceil((new Date(nextCheckout).getTime() - new Date(nextCheckin).getTime()) / 86400000) || 1
        );
        setCheckinDate(nextCheckin);
        setCheckoutDate(nextCheckout);
        setOriginalCheckoutDate(nextCheckout);
        setNights(nextNights);
        if (initialRoomTypeId) {
            setRoomTypeId(initialRoomTypeId);
            setOriginalRoomTypeId(initialRoomTypeId);
        }
    }, [mode, initialCheckinDate, initialCheckoutDate, initialRoomTypeId, today, tomorrow]);

    // Guest Info
    const [guestName, setGuestName] = useState("");
    const [identityFirstName, setIdentityFirstName] = useState("");
    const [identityLastName, setIdentityLastName] = useState("");
    const [initialBookedGuestName, setInitialBookedGuestName] = useState("");
    const [phone, setPhone] = useState("");
    const [identityText, setIdentityText] = useState("");
    const [guestProfileId, setGuestProfileId] = useState<string | null>(null);
    const [isProfileMasked, setIsProfileMasked] = useState(false);
    const [profileGender, setProfileGender] = useState<"" | "M" | "F" | "Other">("");
    const [profileNationalityCode, setProfileNationalityCode] = useState("");
    const [profileCountry, setProfileCountry] = useState("");
    const [profileProvince, setProfileProvince] = useState("");
    const [profileIdType, setProfileIdType] = useState<"" | "thai_id" | "passport" | "other">("");
    const [profileIdNumber, setProfileIdNumber] = useState("");
    const [profileDob, setProfileDob] = useState("");
    const [profileEmail, setProfileEmail] = useState("");
    const [profileWhatsapp, setProfileWhatsapp] = useState("");
    const [profileLineId, setProfileLineId] = useState("");
    const [profileAddress, setProfileAddress] = useState("");
    const [profileVipTier, setProfileVipTier] = useState("");
    const [profilePreferences, setProfilePreferences] = useState("");
    const [profileNotes, setProfileNotes] = useState("");
    const [profileBlacklisted, setProfileBlacklisted] = useState(false);
    const [profileStatus, setProfileStatus] = useState("");
    const [profileStayCount, setProfileStayCount] = useState(0);
    const [profileLastStayDate, setProfileLastStayDate] = useState("");
    const [profileBookingNames, setProfileBookingNames] = useState<string[]>([]);
    const [linkedProfileName, setLinkedProfileName] = useState("");
    const [linkedProfileActiveReservationCount, setLinkedProfileActiveReservationCount] = useState(0);
    const [profileLinking, setProfileLinking] = useState(false);
    const [liveGuestMatches, setLiveGuestMatches] = useState<MatchResult[]>([]);
    const [prefetchedPossibleReturnMatches, setPrefetchedPossibleReturnMatches] = useState<MatchResult[]>([]);
    const [showManualGuestSearch, setShowManualGuestSearch] = useState(false);
    const [manualGuestSearchQ, setManualGuestSearchQ] = useState("");
    const [manualGuestResults, setManualGuestResults] = useState<any[]>([]);
    const [manualGuestSearching, setManualGuestSearching] = useState(false);
    const [guestMatchEnabled, setGuestMatchEnabled] = useState(false);
    const [reservationParty, setReservationParty] = useState<ReservationGuestWithProfile[]>([]);
    const [partyLoading, setPartyLoading] = useState(false);
    const [partyModalOpen, setPartyModalOpen] = useState(false);
    const [partyDraftLoading, setPartyDraftLoading] = useState(false);
    const [partyDraftError, setPartyDraftError] = useState("");
    const [partyDraft, setPartyDraft] = useState<PartyDraft>(createEmptyPartyDraft());
    const [, setActiveImportTarget] = useState<IdentityImportTarget>("main");
    const [partySearchQ, setPartySearchQ] = useState("");
    const [partySearchResults, setPartySearchResults] = useState<any[]>([]);
    const [partySearchLoading, setPartySearchLoading] = useState(false);
    const [partySaving, setPartySaving] = useState(false);

    // Notes
    const [note, setNote] = useState("");
    const [specials, setSpecials] = useState("");
    const [expectedArrivalTime, setExpectedArrivalTime] = useState("");
    const [initialExpectedArrivalTime, setInitialExpectedArrivalTime] = useState("");

    // Pricing
    const [nightlyRates, setNightlyRates] = useState<NightlyRate[]>([]);
    const [discountType, setDiscountType] = useState<BookingDiscountType>("percent");
    const [discountValue, setDiscountValue] = useState(0);
    const [discountReason, setDiscountReason] = useState("");
    const [totalPrice, setTotalPrice] = useState(0);
    const [depositAmount, setDepositAmount] = useState(0);
    const [depositLines, setDepositLines] = useState<DepositLine[]>([]);
    const [depositGeneralNote, setDepositGeneralNote] = useState("");
    const [depositWarning, setDepositWarning] = useState("");
    const [depositMethod, setDepositMethod] = useState("cash");
    const [depositInputAmount, setDepositInputAmount] = useState("");
    const [depositInputNote, setDepositInputNote] = useState("");
    const [depositSaving, setDepositSaving] = useState(false);
    const [depositInlineError, setDepositInlineError] = useState("");

    // Rate Plan
    const [ratePlanId, setRatePlanId] = useState("");
    const [originalRatePlanId, setOriginalRatePlanId] = useState("");
    const [ratePlanEligibilityWarning, setRatePlanEligibilityWarning] = useState("");

    // Checkout Payment
    const [paymentMethod, setPaymentMethod] = useState("cash");
    const [paymentAmount, setPaymentAmount] = useState("");
    const [paymentNote, setPaymentNote] = useState("");
    const [initialCheckedInAt, setInitialCheckedInAt] = useState("");
    const [dayUseExtendMinutes, setDayUseExtendMinutes] = useState<number | null>(null);
    const [dayUseExtendSettingsLoading, setDayUseExtendSettingsLoading] = useState(false);
    const [pendingCheckinPayments, setPendingCheckinPayments] = useState<PendingCheckinPayment[]>([]);
    const [pendingInhousePayments, setPendingInhousePayments] = useState<PendingCheckinPayment[]>([]);
    const [roomMoveHistory, setRoomMoveHistory] = useState<RoomMoveHistoryItem[]>([]);
    const [reservationStatus, setReservationStatus] = useState<ReservationRecordStatus>("");
    const [assignedRoomLockActive, setAssignedRoomLockActive] = useState(false);
    const [assignedRoomLockReason, setAssignedRoomLockReason] = useState("");
    const [assignedRoomLockRoomNumber, setAssignedRoomLockRoomNumber] = useState("");
    const [assignedRoomLockDraftReason, setAssignedRoomLockDraftReason] = useState("");
    const [assignedRoomLockLoading, setAssignedRoomLockLoading] = useState(false);
    const dayUseAmountOnlyMode = isDayUse && (mode === "edit" || mode === "inhouse");

    // Pre-checkout validation
    type CheckoutWarning = { type: string; message: string; severity: "error" | "warning" | "info" };
    const [checkoutWarnings, setCheckoutWarnings] = useState<CheckoutWarning[]>([]);
    const [depositAction, setDepositAction] = useState<"apply" | "refund">("refund");
    const [forceCheckout, setForceCheckout] = useState(false);
    const [preCheckoutLoaded, setPreCheckoutLoaded] = useState(false);
    const [hasPrepaidLateCheckout, setHasPrepaidLateCheckout] = useState(false);
    const [openLoans, setOpenLoans] = useState<any[]>([]);
    const [coAlerts, setCoAlerts] = useState<any[]>([]);
    const [reservationAlerts, setReservationAlerts] = useState<any[]>([]);
    const [reservationAlertsLoading, setReservationAlertsLoading] = useState(false);
    const [preCheckoutBalance, setPreCheckoutBalance] = useState(0);
    const [showCheckoutOutstandingPopup, setShowCheckoutOutstandingPopup] = useState(false);
    const [showReverseNoShowDialog, setShowReverseNoShowDialog] = useState(false);
    const [reverseNoShowLoading, setReverseNoShowLoading] = useState(false);
    const [reloadToken, setReloadToken] = useState(0);
    const [successMessage, setSuccessMessage] = useState("");
    const [documentProfileHint, setDocumentProfileHint] = useState("");
    const [identityAlertSettings, setIdentityAlertSettings] = useState<IdentityAlertSettings>(DEFAULT_IDENTITY_ALERT_SETTINGS);
    const [businessDate, setBusinessDate] = useState(today);
    const [checkinAssignedRoomStatus, setCheckinAssignedRoomStatus] = useState<CheckinAssignedRoomStatus | null>(null);

    // Print dialogs
    const [showConfirmation, setShowConfirmation] = useState(false);
    const [showRegCard, setShowRegCard] = useState(false);
    const [createdSummary, setCreatedSummary] = useState<CreatedReservationSummary | null>(null);
    const [continuousStayPreview, setContinuousStayPreview] = useState<ContinuousStayPreviewState | null>(null);
    const [continuousStayPayload, setContinuousStayPayload] = useState<any | null>(null);
    const [continuousStayPlanMode, setContinuousStayPlanMode] = useState<"conflict" | "manual" | null>(null);
    const [continuousStayConfirming, setContinuousStayConfirming] = useState(false);
    const [continuousStayRefreshing, setContinuousStayRefreshing] = useState(false);

    // Options panel (Traces, Alerts, Loans etc.)
    const [showOptions, setShowOptions] = useState(false);
    const [showFolioModal, setShowFolioModal] = useState(false);
    const [showHistoryModal, setShowHistoryModal] = useState(false);

    // Modals & Policy Fees
    const [originalCheckoutDate, setOriginalCheckoutDate] = useState(tomorrow);
    const [showEarlyCheckinModal, setShowEarlyCheckinModal] = useState(false);
    const [showLateCheckoutModal, setShowLateCheckoutModal] = useState(false);
    const [showShortenModal, setShowShortenModal] = useState(false);
    const [shortenPreview, setShortenPreview] = useState<ShortenSettlementPreview | null>(null);
    const [suggestedPolicyFee, setSuggestedPolicyFee] = useState(0);
    const [isAfter1600, setIsAfter1600] = useState(false);
    const [bypassPolicy, setBypassPolicy] = useState(false);
    const [policyFeePayload, setPolicyFeePayload] = useState<PolicyFeePayload | null>(null);
    const policyFeePayloadRef = useRef<PolicyFeePayload | null>(null);
    const [submitIntentState, setSubmitIntentState] = useState<"draft" | "confirm">("confirm");
    const [showCheckinFieldValidation, setShowCheckinFieldValidation] = useState(false);
    const formRef = useRef<HTMLFormElement>(null);
    const [hasMainGuestIdentityImport, setHasMainGuestIdentityImport] = useState(false);

    const closePolicyModalOnly = useCallback(() => {
        setShowEarlyCheckinModal(false);
        setShowLateCheckoutModal(false);
        setShowShortenModal(false);
        setShortenPreview(null);
        setBypassPolicy(false);
        setPolicyFeePayload(null);
        policyFeePayloadRef.current = null;
        setShowCheckinFieldValidation(false);
        setLoading(false);
    }, []);

    const markWalkInFastCheckinReady = useCallback(() => {
        if (mode !== "create") return;
        if (source !== "walkin") return;
        if (checkinDate !== businessDate) return;
        setHasMainGuestIdentityImport(true);
    }, [businessDate, checkinDate, mode, source]);

    const continueWithPolicyDecision = useCallback((payload: PolicyFeePayload | null) => {
        policyFeePayloadRef.current = payload;
        setPolicyFeePayload(payload);
        setShowEarlyCheckinModal(false);
        setShowLateCheckoutModal(false);
        setShowShortenModal(false);
        setBypassPolicy(true);
        setLoading(false);
        setError("");
        if (mode === "checkout") {
            if (
                payload?.payment_method === "cash"
                || payload?.payment_method === "transfer"
                || payload?.payment_method === "credit_card"
            ) {
                setPaymentMethod(payload.payment_method);
            }
            if (payload?.note?.trim()) {
                setPaymentNote((current) => (String(current || "").trim().length > 0 ? current : payload.note.trim()));
            }
            // GUARD: if room balance is still unpaid, force FO to manually enter payment.
            // Do NOT pre-fill — FO must consciously type the amount to confirm collection.
            // Re-open the outstanding popup so the balance reminder stays visible.
            const hasOutstandingBalance = toSatang(preCheckoutBalance) > 0;
            if (hasOutstandingBalance) {
                setPaymentAmount("");
                setShowCheckoutOutstandingPopup(true);
            } else {
                setShowCheckoutOutstandingPopup(false);
                setPaymentAmount("");
            }
            return;
        }
        setShowCheckoutOutstandingPopup(false);
        setTimeout(() => {
            formRef.current?.requestSubmit();
        }, 0);
    }, [mode, preCheckoutBalance]);

    useEffect(() => {
        policyFeePayloadRef.current = policyFeePayload;
    }, [policyFeePayload]);

    // Meta fetching
    const [roomTypes, setRoomTypes] = useState<any[]>([]);
    const [rooms, setRooms] = useState<any[]>([]);

    const applyIdentityNameParts = useCallback((
        firstName: string,
        lastName: string,
        options?: { syncGuestName?: boolean }
    ) => {
        const nextFirstName = cleanFloatingThaiMarks(String(firstName || "")).trim();
        const nextLastName = cleanFloatingThaiMarks(String(lastName || "")).trim();
        setIdentityFirstName(nextFirstName);
        setIdentityLastName(nextLastName);
        if (options?.syncGuestName !== false) {
            setGuestName(joinGuestName(nextFirstName, nextLastName));
        }
    }, []);

    const resetProfileDraft = useCallback(() => {
        setIdentityFirstName("");
        setIdentityLastName("");
        setProfileGender("");
        setProfileNationalityCode("");
        setProfileCountry("");
        setProfileProvince("");
        setProfileIdType("");
        setProfileIdNumber("");
        setProfileDob("");
        setProfileEmail("");
        setProfileWhatsapp("");
        setProfileLineId("");
        setProfileAddress("");
        setProfileVipTier("");
        setProfilePreferences("");
        setProfileNotes("");
        setProfileBlacklisted(false);
        setProfileStatus("");
        setProfileStayCount(0);
        setProfileLastStayDate("");
        setProfileBookingNames([]);
        setLinkedProfileName("");
        setLinkedProfileActiveReservationCount(0);
        setDocumentProfileHint("");
        setHasMainGuestIdentityImport(false);
    }, []);

    const resetPartyDraft = useCallback(() => {
        setPartyDraft(createEmptyPartyDraft());
        setPartyDraftLoading(false);
        setPartyDraftError("");
        setPartySearchQ("");
        setPartySearchResults([]);
    }, []);

    const applyProfileDraft = useCallback((profile: any, options?: { overwriteGuest?: boolean }) => {
        if (!profile) return;
        const firstName = String(profile.first_name || "").trim();
        const lastName = String(profile.last_name || "").trim();
        const fullName = joinGuestName(firstName, lastName);
        if (options?.overwriteGuest !== false) {
            if (fullName) setGuestName(fullName);
        }
        setIdentityFirstName(firstName);
        setIdentityLastName(lastName);
        setLinkedProfileName(fullName);
        const phoneValue = String(profile.phone || "").trim();
        if (phoneValue) setPhone(formatPhoneInput(phoneValue));

        const normalizedCode = normalizeNationalityCode(profile.nationality_code || profile.nationality);
        const inferredCountry = getCountryByCode(normalizedCode);

        setProfileGender(profile.gender === "M" || profile.gender === "F" || profile.gender === "Other" ? profile.gender : "");
        setProfileNationalityCode(normalizedCode || "");
        setProfileCountry(String(profile.country || inferredCountry || "").trim());
        setProfileProvince(String(profile.province || "").trim());
        setProfileIdType(profile.id_type === "thai_id" || profile.id_type === "passport" || profile.id_type === "other" ? profile.id_type : "");
        setProfileIdNumber(String(profile.id_number || profile.passport_no || profile.id_card_number || "").trim());
        setProfileDob(String(profile.dob || "").slice(0, 10));
        setProfileEmail(String(profile.email || "").trim());
        setProfileWhatsapp(String(profile.whatsapp || "").trim());
        setProfileLineId(String(profile.line_id || "").trim());
        setProfileAddress(String(profile.address || profile.address_line1 || "").trim());
        setProfileVipTier(String(profile.vip_tier || "").trim());
        setProfilePreferences(String(profile.preferences || "").trim());
        setProfileNotes(removeThaiCardNameBlock(String(profile.notes || "")));
        setProfileBlacklisted(Boolean(profile.blacklisted));
        setProfileStatus(String(profile.profile_status || "").trim());
        setProfileStayCount(Number(profile.stay_count || 0));
        setProfileLastStayDate(String(profile.last_stay_date || "").trim());
        setLinkedProfileActiveReservationCount(Math.max(0, Number(profile.active_primary_reservation_count || 0)));
        setProfileBookingNames(
            Array.isArray(profile.booking_names)
                ? profile.booking_names.map((value: unknown) => String(value ?? "").trim()).filter(Boolean)
                : []
        );
        setIdentityText(String(profile.id_number || profile.passport_no || profile.id_card_number || "").trim());
        setIsProfileMasked(profile._masked === true);
    }, []);

    const fetchGuestProfileById = useCallback(async (profileId: string) => {
        if (!profileId) {
            throw new Error("Guest profile id is required.");
        }
        const query = new URLSearchParams();
        if (shouldRequestIdentityUnmask(mode) && reservationId) {
            query.set("checkin_mode", "true");
            query.set("reservation_id", reservationId);
        }
        const url = query.size > 0
            ? `/api/guests/${profileId}?${query.toString()}`
            : `/api/guests/${profileId}`;
        const response = await fetch(url);
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success || !data?.profile) {
            throw new Error(data?.error || "Failed to load guest profile.");
        }
        return data.profile;
    }, [mode, reservationId]);

    const fetchGuestProfileHistorySummary = useCallback(async (profileId: string) => {
        if (!profileId) return null;
        const response = await fetch(`/api/guests/${profileId}/history`);
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) {
            throw new Error(data?.error || "Failed to load guest history.");
        }
        return data;
    }, []);

    const loadGuestProfileById = useCallback(async (profileId: string, options?: { overwriteGuest?: boolean }) => {
        if (!profileId) return;
        const profile = await fetchGuestProfileById(profileId);
        applyProfileDraft(profile, options);
        try {
            const history = await fetchGuestProfileHistorySummary(profileId);
            if (history) {
                const totalStays = Number(history.summary?.total_stays ?? 0);
                const latestStayDate = Array.isArray(history.stays)
                    ? history.stays
                        .map((stay: any) => String(stay?.date_out ?? "").trim())
                        .filter(Boolean)
                        .sort()
                        .at(-1) ?? ""
                    : "";
                setProfileStayCount(totalStays);
                setProfileLastStayDate(latestStayDate);
            }
        } catch {
            // Keep profile fallback values when history lookup fails.
        }
    }, [applyProfileDraft, fetchGuestProfileById, fetchGuestProfileHistorySummary]);

    const applyPartyDraftFromProfile = useCallback((profile: any, linkedMemberId: string | null = null) => {
        setPartyDraft(buildPartyDraftFromProfile(profile, linkedMemberId));
        setPartyDraftError("");
    }, []);

    const openNewPartyModal = useCallback(() => {
        setPartyModalOpen(true);
        setActiveImportTarget("accompany");
        resetPartyDraft();
    }, [resetPartyDraft]);

    const openPartyMemberModal = useCallback(async (member: ReservationGuestWithProfile) => {
        setPartyModalOpen(true);
        setActiveImportTarget("accompany");
        setPartyDraftError("");
        setPartySearchQ("");
        setPartySearchResults([]);

        const fallbackProfile = member.guest_profile
            ? {
                ...member.guest_profile,
                id: member.guest_profile_id,
                id_type: null,
                id_number: null,
                passport_no: null,
                id_card_number: null,
                dob: null,
                gender: null,
            }
            : null;
        if (fallbackProfile) {
            applyPartyDraftFromProfile(fallbackProfile, member.id);
        } else {
            setPartyDraft(createEmptyPartyDraft());
        }

        if (!member.guest_profile_id) return;

        setPartyDraftLoading(true);
        try {
            const profile = await fetchGuestProfileById(member.guest_profile_id);
            applyPartyDraftFromProfile(profile, member.id);
        } catch (draftError) {
            setPartyDraftError(draftError instanceof Error ? draftError.message : "Failed to load accompanying guest.");
        } finally {
            setPartyDraftLoading(false);
        }
    }, [applyPartyDraftFromProfile, fetchGuestProfileById]);

    const loadReservationParty = useCallback(async (): Promise<ReservationGuestWithProfile[]> => {
        if (!reservationId) {
            setReservationParty([]);
            return [];
        }

        setPartyLoading(true);
        try {
            const response = await fetch(`/api/bookings/${reservationId}/guests`);
            const data = await response.json().catch(() => null);
            if (!response.ok || !data?.success) {
                throw new Error(data?.error || "Failed to load reservation party.");
            }
            const guests = Array.isArray(data.guests) ? data.guests : [];
            setReservationParty(guests);
            return guests;
        } catch (partyError) {
            setReservationParty([]);
            setError((current) => current || (partyError instanceof Error ? partyError.message : "Failed to load reservation party."));
            return [];
        } finally {
            setPartyLoading(false);
        }
    }, [reservationId]);

    const selectProfileById = useCallback(async (
        profileId: string,
        fallback?: { first_name?: string | null; last_name?: string | null; phone?: string | null }
    ) => {
        setError("");
        setProfileLinking(true);
        try {
            const normalizedProfileId = String(profileId);
            setGuestProfileId(normalizedProfileId);
            setDocumentProfileHint("");
            if (fallback) {
                const fullName = joinGuestName(String(fallback.first_name || ""), String(fallback.last_name || ""));
                if (fullName) setGuestName(fullName);
                if (fallback.phone) setPhone(formatPhoneInput(String(fallback.phone)));
            }

            await loadGuestProfileById(normalizedProfileId, { overwriteGuest: true });

            if (reservationId) {
                const linkRes = await fetch(`/api/bookings/${reservationId}/guest-profile`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ guest_profile_id: normalizedProfileId })
                });
                const linkData = await linkRes.json().catch(() => null);
                if (!linkRes.ok || !linkData?.success) {
                    throw new Error(linkData?.error || "Failed to link matched profile.");
                }
            }
            setShowManualGuestSearch(false);
            setManualGuestSearchQ("");
            setManualGuestResults([]);
            setLiveGuestMatches([]);
            await loadReservationParty();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to link matched profile.");
        } finally {
            setProfileLinking(false);
        }
    }, [loadGuestProfileById, loadReservationParty, reservationId]);

    const handleSelectMatchedProfile = useCallback(async (match: MatchResult) => {
        await selectProfileById(String(match.profile.id), {
            first_name: match.profile.first_name,
            last_name: match.profile.last_name,
            phone: match.profile.phone
        });
    }, [selectProfileById]);

    const applyThaiCardPayload = useCallback((
        payload: ThaiCardImportPayload,
        options?: { bookedMainGuestName?: string; forceDraftStatus?: boolean }
    ) => {
        const citizenId = normalizeThaiCardCitizenId(payload.citizenId);
        if (citizenId) {
            setProfileIdType("thai_id");
            setProfileIdNumber(citizenId);
            setIdentityText(citizenId);
        }

        const preferredName = buildPreferredCardName(payload);
        if (preferredName.fullName) {
            applyIdentityNameParts(preferredName.firstName, preferredName.lastName);
        }

        const normalizedGender = normalizeThaiCardGender(payload.gender);
        if (normalizedGender) setProfileGender(normalizedGender);

        const dob = normalizeDobYmd(payload.birthday);
        if (dob) setProfileDob(dob);

        const address = String(payload.address || "").replace(/#/g, " ").trim();
        if (address) setProfileAddress(address);
        const province = extractThaiProvince(address, payload.province);
        if (province) setProfileProvince(province);

        setProfileNationalityCode("THA");
        setProfileCountry("Thailand");
        if (options?.forceDraftStatus) {
            setProfileStatus("draft");
        }
        setProfileNotes((current) => {
            const cleaned = removeThaiCardNameBlock(current);
            return upsertBookedMainGuestNameNote(cleaned, options?.bookedMainGuestName || "");
        });
    }, [applyIdentityNameParts]);

    const findProfileByThaiId = useCallback(async (citizenId: string) => {
        const normalized = normalizeThaiCardCitizenId(citizenId);
        if (!normalized) return null;
        const params = new URLSearchParams({
            id_type: "thai_id",
            id_number: normalized,
        });
        if (shouldRequestIdentityUnmask(mode) && reservationId) {
            params.set("checkin_mode", "true");
            params.set("reservation_id", reservationId);
        }
        const response = await fetch(
            `/api/guests/by-id?${params.toString()}`
        );
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) {
            throw new Error(data?.error || "Failed to lookup profile by Thai ID.");
        }
        return data.profile ?? null;
    }, [mode, reservationId]);

    const autoResolveMainGuestThaiId = useCallback(async (citizenId: string) => {
        const normalized = normalizeThaiCardCitizenId(citizenId);
        if (!normalized || hasInvalidThaiId(normalized, false)) {
            setDocumentProfileHint("");
            return false;
        }

        try {
            const foundProfile = await findProfileByThaiId(normalized);
            if (!foundProfile?.id) {
                setDocumentProfileHint("");
                return false;
            }

            const foundId = String(foundProfile.id);
            const profileName = joinGuestName(foundProfile.first_name || "", foundProfile.last_name || "").trim() || "Unknown";

            if (foundId === String(guestProfileId || "")) {
                setDocumentProfileHint(`Thai ID matched linked profile: ${profileName}`);
                return false;
            }

            await selectProfileById(foundId, {
                first_name: foundProfile.first_name,
                last_name: foundProfile.last_name,
                phone: foundProfile.phone
            });
            const nextMessage = `พบ guest profile เดิมจากเลขบัตรประชาชนแล้ว: ${profileName} ระบบลิงก์โปรไฟล์นี้ให้อัตโนมัติ`;
            setDocumentProfileHint(nextMessage);
            setSuccessMessage(nextMessage);
            return true;
        } catch (lookupError) {
            const message = lookupError instanceof Error ? lookupError.message : "Failed to lookup profile by Thai ID.";
            setError(message);
            return false;
        }
    }, [findProfileByThaiId, guestProfileId, selectProfileById]);

    const buildIdentityScanNotices = useCallback((
        dobYmd: string,
        target: "main" | "accompany",
        source: IdentityScanSource
    ) => {
        const notices: IdentityScanNotice[] = [];
        const rawDob = String(dobYmd || "").trim();
        const normalizedDob = normalizeDobYmd(rawDob);
        const birthDate = parseYmdToDate(normalizedDob);
        const label = target === "main" ? "Main Guest" : "Accompanying Guest";
        const showUnder18 =
            source === "thai_id"
                ? identityAlertSettings.identity_alert_under18_thai_id_enabled
                : identityAlertSettings.identity_alert_under18_passport_enabled;
        const showOver18 =
            source === "thai_id"
                ? identityAlertSettings.identity_alert_over18_thai_id_enabled
                : identityAlertSettings.identity_alert_over18_passport_enabled;
        const showBirthday = identityAlertSettings.identity_alert_birthday_enabled;

        if (birthDate) {
            const today = getBangkokTodayDate();
            const age18Date = new Date(birthDate);
            age18Date.setFullYear(age18Date.getFullYear() + 18);
            age18Date.setHours(12, 0, 0, 0);

            if (today < age18Date && showUnder18) {
                const missing = diffDateParts(today, age18Date);
                notices.push({
                    severity: "warning",
                    kind: "under18",
                    message: `⚠️ ${label} อายุต่ำกว่า 18 ปี (ยังขาดอีก ${missing.years} ปี ${missing.months} เดือน ${missing.days} วัน)`,
                });
            } else if (showOver18) {
                const ageNow = diffDateParts(birthDate, today);
                notices.push({
                    severity: "success",
                    kind: "over18",
                    message: `✅ ${label} อายุเกิน 18 ปีแล้ว (${ageNow.years} ปี ${ageNow.months} เดือน ${ageNow.days} วัน)`,
                });
            }

            const nearBirthday = showBirthday
                ? findBirthdayNearStayWindow(normalizedDob, checkinDate, checkoutDate, 3)
                : null;
            if (nearBirthday && showBirthday) {
                const detail =
                    nearBirthday.relation === "during_stay"
                        ? "เกิดช่วงอยู่กับเรา"
                        : nearBirthday.relation === "before_checkin"
                            ? `เกิดก่อนเข้าพัก ${nearBirthday.distanceDays} วัน`
                            : `เกิดหลังเช็กเอาต์ ${nearBirthday.distanceDays} วัน`;
                notices.push({
                    severity: "warning",
                    kind: "birthday",
                    message: `🎂 Birthday alert (${label}) วันที่ ${nearBirthday.birthdayDateYmd} — ${detail} (ช่วงแจ้งเตือน ±3 วัน)`,
                });
            }
        }
        if (!birthDate && rawDob) {
            notices.push({
                severity: "warning",
                kind: "under18",
                message: `⚠️ ${label} ไม่สามารถตีความวันเกิดจากข้อมูลที่อ่านได้ (${rawDob}) กรุณาตรวจสอบวันเกิดก่อนบันทึก`,
            });
        }

        return notices;
    }, [checkinDate, checkoutDate, identityAlertSettings]);

    const showIdentityNoticesPopup = useCallback((
        notices: IdentityScanNotice[],
        source: IdentityScanSource,
        target: "main" | "accompany"
    ): boolean => {
        if (notices.length === 0) return true;
        const sourceLabel = source === "thai_id" ? "Thai ID" : "Passport OCR";
        const targetLabel = target === "main" ? "Main Guest" : "Accompanying Guest";
        const body = [
            `Identity alerts (${sourceLabel} • ${targetLabel})`,
            "",
            ...notices.map((notice) => `• ${notice.message}`),
            "",
            "กด OK เพื่อรับทราบและดำเนินการต่อ",
        ].join("\n");
        return window.confirm(body);
    }, []);

    const handlePartyThaiCardConfirmed = useCallback(async (payload: ThaiCardImportPayload) => {
        setError("");
        setPartyDraftError("");
        const scannedDob = String(payload.birthday || "").trim();
        const notices = buildIdentityScanNotices(scannedDob, "accompany", "thai_id");
        if (!showIdentityNoticesPopup(notices, "thai_id", "accompany")) {
            return;
        }
        setPartyModalOpen(true);
        const citizenId = normalizeThaiCardCitizenId(payload.citizenId);

        if (citizenId) {
            try {
                const foundProfile = await findProfileByThaiId(citizenId);
                if (foundProfile) {
                    const foundId = String(foundProfile.id);
                    const alreadyLinked = reservationParty.some((member) => String(member.guest_profile_id) === foundId);
                    const isMainGuest = String(guestProfileId || "") === foundId;
                    if (alreadyLinked || isMainGuest) {
                        setPartyDraftError("This guest is already linked to the reservation.");
                    } else {
                        const profileName = joinGuestName(foundProfile.first_name || "", foundProfile.last_name || "").trim() || "Unknown";
                        const shouldUse = window.confirm(
                            `Found existing profile from Thai ID (${profileName})\nLink this profile as an accompanying guest?`
                        );
                        if (shouldUse) {
                            applyPartyDraftFromProfile(foundProfile);
                            return;
                        }
                    }
                }
            } catch (lookupError) {
                const message = lookupError instanceof Error ? lookupError.message : "Failed to lookup profile.";
                setPartyDraftError(message);
            }
        }

        const citizenValue = normalizeThaiCardCitizenId(payload.citizenId);
        const englishFirst = String(payload.firstNameEN || "").trim();
        const englishLast = String(payload.lastNameEN || "").trim();
        const thaiName = buildThaiCardNameParts(payload.titleTH, payload.firstNameTH, payload.lastNameTH);
        const thaiFirst = thaiName.firstName;
        const thaiLast = thaiName.lastName;
        const nextDob = normalizeDobYmd(payload.birthday);
        const nextGender = normalizeThaiCardGender(payload.gender);
        setPartyDraft((current) => ({
            ...current,
            guestProfileId: current.linkedMemberId ? current.guestProfileId : null,
            firstName: thaiFirst || englishFirst || current.firstName,
            lastName: thaiLast || englishLast || current.lastName,
            idType: "thai_id",
            idNumber: citizenValue || current.idNumber,
            nationalityCode: "THA",
            country: "Thailand",
            gender: nextGender || current.gender,
            dob: nextDob || current.dob,
            profileStatus: current.profileStatus || "draft",
        }));
    }, [applyPartyDraftFromProfile, buildIdentityScanNotices, findProfileByThaiId, guestProfileId, reservationParty, showIdentityNoticesPopup]);

    const handleThaiCardConfirmed = useCallback(async (payload: ThaiCardImportPayload) => {
        setError("");
        const scannedDob = String(payload.birthday || "").trim();
        const notices = buildIdentityScanNotices(scannedDob, "main", "thai_id");
        if (!showIdentityNoticesPopup(notices, "thai_id", "main")) {
            return;
        }
        const bookedMainGuestName = guestName.trim();
        const citizenId = normalizeThaiCardCitizenId(payload.citizenId);
        let forceDraftStatus = String(profileStatus || "").trim() !== "verified";

        if (citizenId) {
            try {
                const foundProfile = await findProfileByThaiId(citizenId);
                if (foundProfile && String(foundProfile.id) !== String(guestProfileId || "")) {
                    const profileName = joinGuestName(foundProfile.first_name || "", foundProfile.last_name || "").trim();
                    const profileLabel = profileName || "Unknown";
                    const foundStatus = String(foundProfile.profile_status || "").trim();
                    const completeness = checkProfileCompleteness(foundProfile as Record<string, unknown>);
                    const isVerifiedComplete = foundStatus === "verified" && completeness.is_complete;
                    if (isVerifiedComplete) {
                        const shouldLink = window.confirm(
                            `พบโปรไฟล์ Verified จากเลขบัตร (${profileLabel})\nต้องการลิงก์โปรไฟล์นี้กับการจองไหม?`
                        );
                        if (shouldLink) {
                            await selectProfileById(String(foundProfile.id), {
                                first_name: foundProfile.first_name,
                                last_name: foundProfile.last_name,
                                phone: foundProfile.phone
                            });
                            setIsProfileMasked(foundProfile._masked === true);
                            forceDraftStatus = false;
                        }
                    } else {
                        const nameMatch = classifyGuestNameMatch(bookedMainGuestName, profileName);
                        if (nameMatch === "exact" || nameMatch === "likely") {
                            await selectProfileById(String(foundProfile.id), {
                                first_name: foundProfile.first_name,
                                last_name: foundProfile.last_name,
                                phone: foundProfile.phone
                            });
                            setIsProfileMasked(foundProfile._masked === true);
                            forceDraftStatus = false;
                        } else {
                            forceDraftStatus = true;
                        }
                    }
                } else if (foundProfile && String(foundProfile.id) === String(guestProfileId || "")) {
                    if (String(foundProfile.profile_status || "").trim() === "verified") {
                        forceDraftStatus = false;
                    } else {
                        forceDraftStatus = true;
                    }
                } else if (!foundProfile) {
                    forceDraftStatus = true;
                }
            } catch (lookupError) {
                const message = lookupError instanceof Error ? lookupError.message : "Failed to lookup profile.";
                setError(message);
                forceDraftStatus = true;
            }
        }

        applyThaiCardPayload(payload, {
            bookedMainGuestName,
            forceDraftStatus,
        });
        markWalkInFastCheckinReady();
    }, [
        applyThaiCardPayload,
        findProfileByThaiId,
        guestName,
        guestProfileId,
        markWalkInFastCheckinReady,
        profileStatus,
        selectProfileById,
        buildIdentityScanNotices,
        showIdentityNoticesPopup
    ]);

    const applyPassportOcrPayload = useCallback((payload: PassportOcrImportPayload) => {
        setProfileIdType("passport");

        const firstName = String(payload.firstName || "").trim();
        const familyName = String(payload.familyName || "").trim();
        if (firstName || familyName) {
            const currentGuestNameParts = splitGuestName(guestName);
            applyIdentityNameParts(
                firstName || identityFirstName || currentGuestNameParts.firstName,
                familyName || identityLastName || currentGuestNameParts.lastName
            );
        }

        const passportNumber = normalizePassportNumber(payload.passportNumber);
        if (passportNumber) {
            setProfileIdNumber(passportNumber);
            setIdentityText(passportNumber);
        }

        const nationalityCode = normalizeNationalityCode(String(payload.nationality || "").trim());
        if (nationalityCode) {
            setProfileNationalityCode(nationalityCode);
            const mappedCountry = getCountryByCode(nationalityCode);
            if (mappedCountry) setProfileCountry(mappedCountry);
        }

        const normalizedGender = normalizeThaiCardGender(payload.gender);
        if (normalizedGender) setProfileGender(normalizedGender);

        const dob = normalizeDobYmd(payload.dateOfBirth);
        if (dob) setProfileDob(dob);
    }, [applyIdentityNameParts, guestName, identityFirstName, identityLastName]);

    const findProfileByPassport = useCallback(async (passportNumber: string) => {
        const normalized = normalizePassportNumber(passportNumber);
        if (!normalized) return null;
        const params = new URLSearchParams({
            id_type: "passport",
            id_number: normalized,
        });
        if (shouldRequestIdentityUnmask(mode) && reservationId) {
            params.set("checkin_mode", "true");
            params.set("reservation_id", reservationId);
        }
        const response = await fetch(
            `/api/guests/by-id?${params.toString()}`
        );
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) {
            throw new Error(data?.error || "Failed to lookup profile by passport.");
        }
        if (!data?.profile) return null;
        return {
            ...data.profile,
            match_score: 100
        };
    }, [mode, reservationId]);

    const handlePassportOcrConfirmed = useCallback(async (payload: PassportOcrImportPayload) => {
        setError("");
        const scannedDob = String(payload.dateOfBirth || "").trim();
        const notices = buildIdentityScanNotices(scannedDob, "main", "passport_ocr");
        if (!showIdentityNoticesPopup(notices, "passport_ocr", "main")) {
            return;
        }
        const passportNumber = normalizePassportNumber(payload.passportNumber);

        if (passportNumber) {
            try {
                const foundProfile = await findProfileByPassport(passportNumber);
                if (foundProfile && String(foundProfile.id) !== String(guestProfileId || "")) {
                    const passportMatchScore = payload.fieldStatus?.passportNumber === "ok" ? 100 : 70;
                    const profileName = joinGuestName(foundProfile.first_name || "", foundProfile.last_name || "").trim() || "Unknown";
                    const shouldLink = window.confirm(
                        `Found existing profile from passport (${profileName})\nMatch score: ${passportMatchScore}%\nLink this profile to the reservation?`
                    );
                    if (shouldLink) {
                        await selectProfileById(String(foundProfile.id), {
                            first_name: foundProfile.first_name,
                            last_name: foundProfile.last_name,
                            phone: foundProfile.phone
                        });
                        setIsProfileMasked(foundProfile._masked === true);
                    }
                }
            } catch (lookupError) {
                const message = lookupError instanceof Error ? lookupError.message : "Failed to lookup profile.";
                setError(message);
            }
        }

        applyPassportOcrPayload(payload);
        markWalkInFastCheckinReady();
    }, [applyPassportOcrPayload, buildIdentityScanNotices, findProfileByPassport, guestProfileId, markWalkInFastCheckinReady, selectProfileById, showIdentityNoticesPopup]);

    const handlePartyPassportOcrConfirmed = useCallback(async (payload: PassportOcrImportPayload) => {
        setError("");
        setPartyDraftError("");
        const scannedDob = String(payload.dateOfBirth || "").trim();
        const notices = buildIdentityScanNotices(scannedDob, "accompany", "passport_ocr");
        if (!showIdentityNoticesPopup(notices, "passport_ocr", "accompany")) {
            return;
        }
        setPartyModalOpen(true);
        const passportNumber = normalizePassportNumber(payload.passportNumber);

        if (passportNumber) {
            try {
                const foundProfile = await findProfileByPassport(passportNumber);
                if (foundProfile) {
                    const foundId = String(foundProfile.id);
                    const alreadyLinked = reservationParty.some((member) => String(member.guest_profile_id) === foundId);
                    const isMainGuest = String(guestProfileId || "") === foundId;
                    if (alreadyLinked || isMainGuest) {
                        setPartyDraftError("This guest is already linked to the reservation.");
                    } else {
                        const passportMatchScore = payload.fieldStatus?.passportNumber === "ok" ? 100 : 70;
                        const profileName = joinGuestName(foundProfile.first_name || "", foundProfile.last_name || "").trim() || "Unknown";
                        const shouldUse = window.confirm(
                            `Found existing profile from passport (${profileName})\nMatch score: ${passportMatchScore}%\nLink this profile as an accompanying guest?`
                        );
                        if (shouldUse) {
                            applyPartyDraftFromProfile(foundProfile);
                            return;
                        }
                    }
                }
            } catch (lookupError) {
                const message = lookupError instanceof Error ? lookupError.message : "Failed to lookup profile.";
                setPartyDraftError(message);
            }
        }

        const normalizedCode = normalizeNationalityCode(String(payload.nationality || "").trim());
        const mappedCountry = getCountryByCode(normalizedCode);
        const normalizedGender = normalizeThaiCardGender(payload.gender);
        const dob = normalizeDobYmd(payload.dateOfBirth);
        setPartyDraft((current) => ({
            ...current,
            guestProfileId: current.linkedMemberId ? current.guestProfileId : null,
            firstName: String(payload.firstName || "").trim() || current.firstName,
            lastName: String(payload.familyName || "").trim() || current.lastName,
            idType: "passport",
            idNumber: passportNumber || current.idNumber,
            nationalityCode: normalizedCode || current.nationalityCode,
            country: mappedCountry || current.country,
            gender: normalizedGender || current.gender,
            dob: dob || current.dob,
            profileStatus: current.profileStatus || "draft",
        }));
    }, [applyPartyDraftFromProfile, buildIdentityScanNotices, findProfileByPassport, guestProfileId, reservationParty, showIdentityNoticesPopup]);

    const openThaiCardReader = useCallback((target: IdentityImportTarget = "main") => {
        if (typeof window === "undefined") return;
        const savedWs = window.localStorage.getItem("pms.smartcard.wsEndpoint");
        const requestId = `thai-card-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const params = new URLSearchParams({
            popup: "1",
            target,
            t: String(Date.now()),
            request_id: requestId,
        });
        if (savedWs) params.set("ws", savedWs);
        const buildHelperUrl = () => {
            if (window.location.protocol !== "https:") return `${window.location.origin}/smart-card?${params.toString()}`;
            let helperOrigin = "http://127.0.0.1:3001";
            if (savedWs) {
                try {
                    const wsUrl = new URL(savedWs);
                    helperOrigin = `${wsUrl.protocol === "wss:" ? "https:" : "http:"}//${wsUrl.host}`;
                } catch {
                    helperOrigin = "http://127.0.0.1:3001";
                }
            }
            const helperParams = new URLSearchParams(params);
            helperParams.set("parentOrigin", window.location.origin);
            return `${helperOrigin}/smart-card-helper?${helperParams.toString()}`;
        };
        const url = buildHelperUrl();
        const popup = window.open(
            url,
            "pms-thai-card-reader",
            "popup=yes,width=820,height=760,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes"
        );
        if (!popup) {
            setError("Popup blocked. Please allow popups and try again.");
            return;
        }
        processedSmartCardRequestIdsRef.current.delete(requestId);
        thaiCardRequestIdRef.current = requestId;
        thaiCardPopupRef.current = popup;
        traceSmartCardUiEvent({
            requestId,
            reservationId: reservationId ?? null,
            eventName: "parent_popup_opened",
            message: `Opened smart card popup for ${target}`,
            metadata: {
                target,
                flow: window.location.protocol === "https:" ? "helper" : "local_popup",
                popup_url: url,
            },
        });
        popup.focus();
    }, []);

    const openPassportOcr = useCallback((target: IdentityImportTarget = "main", guestIndex?: number) => {
        if (typeof window === "undefined") return;
        const params = new URLSearchParams({
            popup: "1",
            target,
            t: String(Date.now())
        });
        if (reservationId) {
            params.set("scan_id", "latest");
            params.set("reservation_id", reservationId);
            // guest_index: 0=main, 1+=accompanying (maps to display_order - 1)
            const gi = target === "main" ? 0 : (guestIndex ?? 0);
            params.set("guest_index", String(gi));
        }
        const url = `${window.location.origin}/passport-ocr?${params.toString()}`;
        const popup = window.open(
            url,
            "pms-passport-ocr",
            "popup=yes,width=1180,height=860,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes"
        );
        if (!popup) {
            setError("Popup blocked. Please allow popups and try again.");
            return;
        }
        popup.focus();
    }, [reservationId]);

    useEffect(() => {
        const handleSmartCardConfirmed = (data: {
            type?: string;
            payload?: ThaiCardImportPayload | PassportOcrImportPayload;
            endpoint?: string;
            target?: IdentityImportTarget;
            requestId?: string;
        } | null, eventSource?: MessageEventSource | null, eventOrigin?: string) => {
            if (!data) return;
            if (data.type === "PMS_THAI_CARD_WS_ENDPOINT" && data.endpoint) {
                traceSmartCardUiEvent({
                    requestId: data.requestId ?? thaiCardRequestIdRef.current,
                    reservationId: reservationId ?? null,
                    eventName: "parent_ws_endpoint_received",
                    message: "Parent received smart card websocket endpoint",
                    metadata: { endpoint: data.endpoint },
                });
                try {
                    window.localStorage.setItem("pms.smartcard.wsEndpoint", data.endpoint);
                } catch {
                    // ignore storage failures
                }
                return;
            }
            if (!data.payload) return;
            if (data.type !== "PMS_THAI_CARD_CONFIRMED" && data.type !== "PMS_PASSPORT_OCR_CONFIRMED") return;
            if (data.requestId && thaiCardRequestIdRef.current && data.requestId !== thaiCardRequestIdRef.current) {
                return;
            }
            if (data.requestId && processedSmartCardRequestIdsRef.current.has(data.requestId)) {
                traceSmartCardUiEvent({
                    requestId: data.requestId,
                    reservationId: reservationId ?? null,
                    eventName: "parent_confirm_ignored_duplicate",
                    message: `Ignored duplicate ${data.type}`,
                    metadata: {
                        source: eventOrigin ? "postMessage" : "broadcast_channel",
                        target: data.target ?? "main",
                    },
                    severity: "warning",
                });
                return;
            }
            if (data.requestId) {
                processedSmartCardRequestIdsRef.current.add(data.requestId);
            }
            traceSmartCardUiEvent({
                requestId: data.requestId ?? thaiCardRequestIdRef.current,
                reservationId: reservationId ?? null,
                eventName: "parent_confirm_received",
                message: `Parent received ${data.type}`,
                metadata: {
                    source: eventOrigin ? "postMessage" : "broadcast_channel",
                    target: data.target ?? "main",
                },
            });
            if (data.type === "PMS_THAI_CARD_CONFIRMED" && eventOrigin) {
                notifyPopupToClose(eventSource ?? null, eventOrigin);
            }
            traceSmartCardUiEvent({
                requestId: data.requestId ?? thaiCardRequestIdRef.current,
                reservationId: reservationId ?? null,
                eventName: "parent_force_close_sent",
                message: "Parent requested popup close",
                metadata: { target: data.target ?? "main" },
            });
            forceClosePopup(thaiCardPopupRef.current, data.requestId || thaiCardRequestIdRef.current);
            thaiCardPopupRef.current = null;
            thaiCardRequestIdRef.current = null;
            if (data.type === "PMS_THAI_CARD_CONFIRMED") {
                if (data.target === "accompany") {
                    traceSmartCardUiEvent({
                        requestId: data.requestId ?? null,
                        reservationId: reservationId ?? null,
                        eventName: "parent_ingest_deferred",
                        message: "Delaying accompany Thai card ingest until popup close settles",
                        metadata: { target: "accompany" },
                    });
                    runAfterPopupCloseSettle(() => {
                        traceSmartCardUiEvent({
                            requestId: data.requestId ?? null,
                            reservationId: reservationId ?? null,
                            eventName: "parent_ingest_started",
                            message: "Starting accompany Thai card ingest",
                            metadata: { target: "accompany" },
                        });
                        void handlePartyThaiCardConfirmed(data.payload as ThaiCardImportPayload);
                    });
                    return;
                }
                traceSmartCardUiEvent({
                    requestId: data.requestId ?? null,
                    reservationId: reservationId ?? null,
                    eventName: "parent_ingest_deferred",
                    message: "Delaying main Thai card ingest until popup close settles",
                    metadata: { target: "main" },
                });
                runAfterPopupCloseSettle(() => {
                    traceSmartCardUiEvent({
                        requestId: data.requestId ?? null,
                        reservationId: reservationId ?? null,
                        eventName: "parent_ingest_started",
                        message: "Starting main Thai card ingest",
                        metadata: { target: "main" },
                    });
                    void handleThaiCardConfirmed(data.payload as ThaiCardImportPayload);
                });
                return;
            }
            if (data.target === "accompany") {
                traceSmartCardUiEvent({
                    requestId: data.requestId ?? null,
                    reservationId: reservationId ?? null,
                    eventName: "parent_ingest_deferred",
                    message: "Delaying accompany passport ingest until popup close settles",
                    metadata: { target: "accompany" },
                });
                runAfterPopupCloseSettle(() => {
                    traceSmartCardUiEvent({
                        requestId: data.requestId ?? null,
                        reservationId: reservationId ?? null,
                        eventName: "parent_ingest_started",
                        message: "Starting accompany passport ingest",
                        metadata: { target: "accompany" },
                    });
                    void handlePartyPassportOcrConfirmed(data.payload as PassportOcrImportPayload);
                });
                return;
            }
            traceSmartCardUiEvent({
                requestId: data.requestId ?? null,
                reservationId: reservationId ?? null,
                eventName: "parent_ingest_deferred",
                message: "Delaying main passport ingest until popup close settles",
                metadata: { target: "main" },
            });
            runAfterPopupCloseSettle(() => {
                traceSmartCardUiEvent({
                    requestId: data.requestId ?? null,
                    reservationId: reservationId ?? null,
                    eventName: "parent_ingest_started",
                    message: "Starting main passport ingest",
                    metadata: { target: "main" },
                });
                void handlePassportOcrConfirmed(data.payload as PassportOcrImportPayload);
            });
        };

        const handleMessage = (event: MessageEvent) => {
            const savedWs = typeof window !== "undefined" ? window.localStorage.getItem("pms.smartcard.wsEndpoint") : "";
            const allowedOrigins = new Set([window.location.origin, "http://127.0.0.1:3001", "http://localhost:3001"]);
            if (savedWs) {
                try {
                    const wsUrl = new URL(savedWs);
                    allowedOrigins.add(`${wsUrl.protocol === "wss:" ? "https:" : "http:"}//${wsUrl.host}`);
                } catch {
                    // ignore invalid stored endpoint
                }
            }
            if (!allowedOrigins.has(event.origin)) return;
            handleSmartCardConfirmed(event.data as {
                type?: string;
                payload?: ThaiCardImportPayload | PassportOcrImportPayload;
                endpoint?: string;
                target?: IdentityImportTarget;
                requestId?: string;
            } | null, event.source, event.origin);
        };

        let smartCardChannel: BroadcastChannel | null = null;
        if (typeof window !== "undefined" && typeof window.BroadcastChannel !== "undefined") {
            smartCardChannel = new window.BroadcastChannel("pms-smart-card");
            smartCardChannel.onmessage = (event) => {
                handleSmartCardConfirmed(event.data as {
                    type?: string;
                    payload?: ThaiCardImportPayload | PassportOcrImportPayload;
                    endpoint?: string;
                    target?: IdentityImportTarget;
                    requestId?: string;
                } | null);
            };
        }
        window.addEventListener("message", handleMessage);
        return () => {
            window.removeEventListener("message", handleMessage);
            smartCardChannel?.close();
        };
    }, [handlePartyPassportOcrConfirmed, handlePartyThaiCardConfirmed, handlePassportOcrConfirmed, handleThaiCardConfirmed]);

    useEffect(() => {
        void loadReservationParty();
    }, [loadReservationParty]);

    useEffect(() => {
        let cancelled = false;
        fetch("/api/settings", { cache: "no-store" })
            .then((response) => response.json().catch(() => null))
            .then((data) => {
                if (cancelled) return;
                if (data?.success) {
                    setIdentityAlertSettings(mergeIdentityAlertSettings(data.settings));
                    if (typeof data.settings?.business_date === "string" && data.settings.business_date) {
                        setBusinessDate(data.settings.business_date);
                    }
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setIdentityAlertSettings(DEFAULT_IDENTITY_ALERT_SETTINGS);
                }
            });

        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (mode !== "checkin" || !roomId || !businessDate) {
            setCheckinAssignedRoomStatus(null);
            return;
        }

        let cancelled = false;
        fetch(`/api/housekeeping/status?date=${businessDate}`, { cache: "no-store" })
            .then((response) => response.json().catch(() => null))
            .then((data) => {
                if (cancelled) return;
                if (!data?.success || !Array.isArray(data.rooms)) {
                    setCheckinAssignedRoomStatus(null);
                    return;
                }

                const matched = data.rooms.find((room: any) => String(room?.room_id ?? "") === roomId);
                if (!matched) {
                    setCheckinAssignedRoomStatus(null);
                    return;
                }

                setCheckinAssignedRoomStatus({
                    room_id: String(matched.room_id),
                    room_number: String(matched.room_number ?? ""),
                    hk_status: matched.hk_status ? String(matched.hk_status) : null,
                    due_out: Boolean(matched.due_out),
                    back_to_back: Boolean(matched.back_to_back),
                    in_house: Boolean(matched.in_house),
                    guest_name: matched.guest_name ? String(matched.guest_name) : null,
                    due_out_guest_name: matched.due_out_guest_name ? String(matched.due_out_guest_name) : null,
                });
            })
            .catch(() => {
                if (!cancelled) setCheckinAssignedRoomStatus(null);
            });

        return () => {
            cancelled = true;
        };
    }, [mode, roomId, businessDate]);

    const showCreateWalkInIdentityImport =
        mode === "create" &&
        source === "walkin" &&
        checkinDate === businessDate;

    // Load Metadata
    useEffect(() => {
        fetch("/api/booking-meta")
            .then(r => r.json())
            .then(d => {
                if (d.success) {
                    setRoomTypes(d.roomTypes || []);
                    setRooms(d.rooms || []);
                    if (roomNumber && mode === "create") {
                        const matched = d.rooms.find((r: any) => r.room_number === roomNumber);
                        if (matched) {
                            setRoomTypeId(matched.room_type_id);
                            setRoomId(matched.id);
                        }
                    }
                }
            });
    }, [roomNumber, mode]);

    useEffect(() => {
        setContinuousStayPreview(null);
        setContinuousStayPayload(null);
        setContinuousStayPlanMode(null);
    }, [checkinDate, checkoutDate, roomId, roomTypeId, source, ratePlanId]);

    // Fetch Existing Reservation
    useEffect(() => {
        // Reset policy-flow state when context changes (new reservation / new mode)
        // so Late/Early/Shorten prompts do not leak from previous bookings.
        setShowEarlyCheckinModal(false);
        setShowLateCheckoutModal(false);
        setShowShortenModal(false);
        setSuggestedPolicyFee(0);
        setIsAfter1600(false);
        setBypassPolicy(false);
        setHasPrepaidLateCheckout(false);
        setPolicyFeePayload(null);
        policyFeePayloadRef.current = null;
        setShowCheckinFieldValidation(false);

        if (mode === "create" || !reservationId) {
            setFetching(false);
            setDepositAmount(0);
            setDepositLines([]);
            setDepositGeneralNote("");
            setDepositWarning("");
            setGuestMatchEnabled(false);
            setDepositInputAmount(mode === "checkin" ? DEFAULT_CHECKIN_DEPOSIT_INPUT : "");
            setDepositInputNote("");
            setDepositInlineError("");
            setPendingCheckinPayments([]);
            setPendingInhousePayments([]);
            setRoomMoveHistory([]);
            setLinkedStay(null);
            setReservationStatus("");
            setInitialCheckedInAt("");
            setAssignedRoomLockActive(false);
            setAssignedRoomLockReason("");
            setAssignedRoomLockRoomNumber("");
            setAssignedRoomLockDraftReason("");
            setOriginalRoomTypeId("");
            setInitialAssignedRoomTypeId("");
            setInitialAssignedRoomId("");
            setOriginalRatePlanId("");
            setGuestProfileId(null);
            setIdentityText("");
            resetProfileDraft();
            setLiveGuestMatches([]);
            setPrefetchedPossibleReturnMatches([]);
            setShowManualGuestSearch(false);
            setManualGuestSearchQ("");
            setManualGuestResults([]);
            setUseSelectedRoomTypeForCharge(true);
            setExpectedArrivalTime("");
            setInitialExpectedArrivalTime("");
            return;
        }
        setFetching(true);
        let fetchUrl = `/api/bookings/${reservationId}`;
        if (shouldRequestIdentityUnmask(mode)) fetchUrl += "?checkin_mode=true";
        fetch(fetchUrl)
            .then(r => r.json())
            .then(d => {
                if (d.success && d.reservation) {
                    const res = d.reservation;
                    setCheckinDate(res.checkin_date || today);
                    setCheckoutDate(res.checkout_date || tomorrow);
                    setOriginalCheckoutDate(res.checkout_date || tomorrow);
                    setNights(res.total_nights || 1);
                    setSource(res.source || "walkin");
                    setReservationStatus(
                        res.status === "active" ||
                            res.status === "cancelled" ||
                            res.status === "checked_out" ||
                            res.status === "no_show"
                            ? res.status
                            : ""
                    );
                    setAssignedRoomLockActive(Boolean(res.do_not_move_assigned_room));
                    setAssignedRoomLockReason(String(res.do_not_move_reason || ""));
                    setAssignedRoomLockRoomNumber(String(res.do_not_move_room_number_snapshot || res.room_number || roomNumber || ""));
                    setAssignedRoomLockDraftReason("");
                    setRoomTypeId(res.room_type_id || "");
                    setOriginalRoomTypeId(res.room_type_id || "");
                    setInitialAssignedRoomTypeId(res.room_type_id || "");
                    setUseSelectedRoomTypeForCharge(true);
                    setRoomId(res.room_id || "");
                    setInitialAssignedRoomId(res.room_id || "");
                    setGuestName(res.guest_name || "");
                    const loadedGuestNameParts = splitGuestName(res.guest_name || "");
                    applyIdentityNameParts(loadedGuestNameParts.firstName, loadedGuestNameParts.lastName, { syncGuestName: false });
                    setInitialBookedGuestName(res.guest_name || "");
                    setPhone(formatPhoneInput(res.phone || ""));
                    setGuestProfileId(res.guest_profile_id || null);
                    setPrefetchedPossibleReturnMatches(Array.isArray(res.possible_return_matches) ? res.possible_return_matches : []);
                    setIsProfileMasked(res._masked === true || (res.guest_profile && res.guest_profile._masked === true));
                    if (!res.guest_profile_id) {
                        resetProfileDraft();
                    }
                    setShowManualGuestSearch(false);
                    setManualGuestSearchQ("");
                    setManualGuestResults([]);
                    setTotalPrice(res.total_price || 0);
                    const currentDepositAmount = Number(res.deposit_amount || 0);
                    const parsedDeposit = parseDepositState(res.deposit_note, currentDepositAmount);
                    const hasSavedDepositState =
                        currentDepositAmount > 0 || parsedDeposit.note.trim().length > 0;
                    setDepositAmount(currentDepositAmount);
                    setDepositLines(parsedDeposit.lines);
                    setDepositGeneralNote(parsedDeposit.note);
                    setDepositWarning(parsedDeposit.warning);
                    setDepositInputAmount(
                        mode === "checkin" && !hasSavedDepositState
                            ? DEFAULT_CHECKIN_DEPOSIT_INPUT
                            : ""
                    );
                    setDepositInputNote("");
                    setDepositInlineError("");
                    setPendingCheckinPayments([]);
                    setPendingInhousePayments([]);
                    setRoomMoveHistory(Array.isArray(res.room_moves) ? res.room_moves : []);
                    setLinkedStay(d.linked_stay || res.linked_stay || null);
                    const normalizedCheckinTime = typeof res.checkin_time === "string" ? res.checkin_time.slice(0, 5) : "";
                    const checkinTimeFromDraft = /^\d{2}:\d{2}$/.test(normalizedCheckinTime)
                        ? normalizedCheckinTime
                        : "";
                    const checkinDateBase = typeof res.checkin_date === "string" && res.checkin_date
                        ? res.checkin_date
                        : today;
                    const loadedCheckedInAt =
                        res.checked_in_at
                            ? formatBangkokDateTimeLocal(res.checked_in_at)
                            : mode === "checkin"
                                ? (checkinTimeFromDraft
                                    ? `${checkinDateBase}T${checkinTimeFromDraft}`
                                    : formatBangkokDateTimeLocal(new Date()))
                                : "";
                    setCheckedInAt(loadedCheckedInAt);
                    setInitialCheckedInAt(loadedCheckedInAt);
                    setOtaRef(res.ota_ref || "");
                    setNote(res.note || "");
                    setSpecials(res.specials || "");
                    const normalizedExpectedArrival = normalizeExpectedArrivalTimeDraft(
                        typeof res.expected_arrival_time === "string" ? res.expected_arrival_time.slice(0, 5) : ""
                    );
                    setExpectedArrivalTime(normalizedExpectedArrival);
                    setInitialExpectedArrivalTime(normalizedExpectedArrival);
                    setDiscountType(
                        res.discount_type === "fixed_total" || res.discount_type === "fixed_per_night" || res.discount_type === "percent"
                            ? res.discount_type
                            : "percent"
                    );
                    setDiscountValue(Number(res.discount_value ?? res.discount_percent ?? 0));
                    setDiscountReason(res.discount_reason || "");
                    setRatePlanId(res.rate_plan_id || "");
                    setOriginalRatePlanId(res.rate_plan_id || "");
                    setRatePlanEligibilityWarning("");

                    // Checkout starts blank; FO must explicitly enter the collected amount.
                    if (mode === "checkout") {
                        setPaymentAmount("");
                        setPaymentNote("");
                        setPaymentMethod("cash");
                    }

                    // Use actual per-night prices from API
                    if (Array.isArray(res.nights) && res.nights.length > 0) {
                        setNightlyRates(res.nights.map((n: any) => ({
                            date: n.stay_date,
                            rate: Number(n.nightly_price) || 0
                        })));
                    } else if (res.total_nights > 0 && res.total_price) {
                        const arr: NightlyRate[] = [];
                        const avgSatang = Math.trunc(toSatang(res.total_price) / Math.max(1, res.total_nights));
                        let cur = new Date(res.checkin_date);
                        for (let i = 0; i < res.total_nights; i++) {
                            arr.push({ date: cur.toISOString().slice(0, 10), rate: fromSatang(avgSatang) });
                            cur.setDate(cur.getDate() + 1);
                        }
                        setNightlyRates(arr);
                    }

                    // Reconcile payment/deposit state from folio ledger after loading reservation snapshot.
                    // This prevents stale reservations.deposit_amount from persisting in the booking panel.
                    setTimeout(() => {
                        void fetchPaymentsAndCharges();
                    }, 0);
                }
            })
            .catch(() => { })
            .finally(() => setFetching(false));
    }, [applyIdentityNameParts, mode, reservationId, resetProfileDraft, reloadToken]);

    const canManageAssignedRoomLock = Boolean(
        reservationId &&
        reservationStatus === "active" &&
        roomId &&
        !checkedInAt
    );

    async function handleUnlockAssignedRoom() {
        if (!reservationId) return;
        if (!confirm("Unlock this Do Not Move room lock?")) return;
        const unlockReason = window.prompt("Reason for unlocking this room lock:", "")?.trim() ?? "";
        if (!unlockReason) {
            setError("Please enter a reason before unlocking this room.");
            return;
        }
        setAssignedRoomLockLoading(true);
        try {
            const response = await fetch(`/api/bookings/${reservationId}/room-lock`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ enabled: false, reason: unlockReason }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload?.success === false) {
                setError(payload?.error ?? "Failed to unlock room.");
                return;
            }
            setAssignedRoomLockActive(false);
            setAssignedRoomLockReason("");
            setAssignedRoomLockRoomNumber("");
            setAssignedRoomLockDraftReason("");
        } finally {
            setAssignedRoomLockLoading(false);
        }
    }

    async function handleLockAssignedRoom() {
        if (!reservationId) return;
        const reason = assignedRoomLockDraftReason.trim();
        if (!reason) {
            setError("Please enter a reason before locking this room.");
            return;
        }
        setAssignedRoomLockLoading(true);
        try {
            const response = await fetch(`/api/bookings/${reservationId}/room-lock`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ enabled: true, reason }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload?.success === false) {
                setError(payload?.error ?? "Failed to lock room.");
                return;
            }
            setAssignedRoomLockActive(true);
            setAssignedRoomLockReason(String(payload?.reason || reason));
            setAssignedRoomLockRoomNumber(String(payload?.room_number_snapshot || roomNumber || assignedRoomLockRoomNumber || ""));
            setAssignedRoomLockDraftReason("");
        } finally {
            setAssignedRoomLockLoading(false);
        }
    }

    // Load full profile draft from linked guest profile
    useEffect(() => {
        if (!guestProfileId) return;
        let cancelled = false;
        loadGuestProfileById(guestProfileId, { overwriteGuest: false })
            .catch(() => {
                if (!cancelled) {
                    setError("Failed to load linked guest profile.");
                }
            });
        return () => {
            cancelled = true;
        };
    }, [guestProfileId, loadGuestProfileById]);

    useEffect(() => {
        const normalizedCode = normalizeNationalityCode(profileNationalityCode);
        if (!normalizedCode) return;
        if (!profileCountry) {
            const mappedCountry = getCountryByCode(normalizedCode);
            if (mappedCountry) setProfileCountry(mappedCountry);
        }
    }, [profileNationalityCode, profileCountry]);

    useEffect(() => {
        if (!showManualGuestSearch) {
            setManualGuestResults([]);
            return;
        }
        const query = manualGuestSearchQ.trim();
        if (query.length < 2) {
            setManualGuestResults([]);
            return;
        }

        const timer = setTimeout(() => {
            setManualGuestSearching(true);
            fetch(`/api/guests?q=${encodeURIComponent(query)}&limit=20`)
                .then((r) => r.json())
                .then((d) => {
                    if (d?.success) {
                        setManualGuestResults(Array.isArray(d.profiles) ? d.profiles : []);
                    } else {
                        setManualGuestResults([]);
                    }
                })
                .catch(() => {
                    setManualGuestResults([]);
                })
                .finally(() => setManualGuestSearching(false));
        }, 300);

        return () => clearTimeout(timer);
    }, [showManualGuestSearch, manualGuestSearchQ]);

    useEffect(() => {
        if (!partyModalOpen || !reservationId) {
            setPartySearchResults([]);
            return;
        }

        const query = partySearchQ.trim();
        if (query.length < 2) {
            setPartySearchResults([]);
            return;
        }

        const timer = setTimeout(() => {
            setPartySearchLoading(true);
            fetch(`/api/guests?q=${encodeURIComponent(query)}&limit=20`)
                .then((r) => r.json())
                .then((d) => {
                    if (d?.success) {
                        setPartySearchResults(Array.isArray(d.profiles) ? d.profiles : []);
                    } else {
                        setPartySearchResults([]);
                    }
                })
                .catch(() => {
                    setPartySearchResults([]);
                })
                .finally(() => setPartySearchLoading(false));
        }, 250);

        return () => clearTimeout(timer);
    }, [partyModalOpen, partySearchQ, reservationId]);

    const refreshPreCheckoutValidation = useCallback(
        async (options?: { resetPaymentAmount?: boolean; openOutstandingPopup?: boolean }) => {
            if (mode !== "checkout" || !reservationId) return;
            const resetPaymentAmount = options?.resetPaymentAmount ?? false;
            const openOutstandingPopup = options?.openOutstandingPopup ?? false;

            setPreCheckoutLoaded(false);
            try {
                const response = await fetch(`/api/bookings/${reservationId}/pre-checkout`);
                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data?.success) return;

                const nextBalance = Number(data.balance_due ?? 0);
                setCheckoutWarnings(data.warnings ?? []);
                setOpenLoans(data.open_loans ?? []);
                setCoAlerts(data.co_alerts ?? []);
                setPreCheckoutBalance(nextBalance);
                setHasPrepaidLateCheckout(Boolean(data.has_late_checkout_fee_paid));
                if (resetPaymentAmount) {
                    setPaymentAmount((current) => {
                        if (policyFeePayloadRef.current) return current;
                        return "";
                    });
                }
                if (openOutstandingPopup) {
                    setShowCheckoutOutstandingPopup(nextBalance > 0);
                } else if (nextBalance <= 0) {
                    setShowCheckoutOutstandingPopup(false);
                }
            } catch {
                // ignore network errors; checkout guard will remain conservative
            } finally {
                setPreCheckoutLoaded(true);
            }
        },
        [mode, reservationId]
    );

    const refreshReservationAlerts = useCallback(async () => {
        if (!reservationId || mode === "create") {
            setReservationAlerts([]);
            return;
        }
        setReservationAlertsLoading(true);
        try {
            const response = await fetch(`/api/bookings/${reservationId}/alerts?surface=reservation`, { cache: "no-store" });
            const data = await response.json().catch(() => ({}));
            if (response.ok && data?.success) {
                setReservationAlerts(Array.isArray(data.alerts) ? data.alerts : []);
            } else {
                setReservationAlerts([]);
            }
        } catch {
            setReservationAlerts([]);
        } finally {
            setReservationAlertsLoading(false);
        }
    }, [mode, reservationId]);

    useEffect(() => {
        void refreshReservationAlerts();
    }, [refreshReservationAlerts, reloadToken]);

    const dismissReservationAlert = useCallback(async (alertId: string) => {
        if (!reservationId) return;
        try {
            const response = await fetch(`/api/bookings/${reservationId}/alerts`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ alert_id: alertId, action: "dismiss" }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data?.success) {
                throw new Error(data?.error || "Failed to dismiss alert.");
            }
            setReservationAlerts((current) => current.filter((alert) => String(alert.id) !== String(alertId)));
        } catch (alertError) {
            setError(alertError instanceof Error ? alertError.message : "Failed to dismiss alert.");
        }
    }, [reservationId]);

    // Pre-checkout validation fetch
    useEffect(() => {
        void refreshPreCheckoutValidation({ resetPaymentAmount: true, openOutstandingPopup: true });
    }, [refreshPreCheckoutValidation]);

    useEffect(() => {
        if (!dayUseAmountOnlyMode) {
            setDayUseExtendMinutes(null);
            setDayUseExtendSettingsLoading(false);
            return;
        }

        let cancelled = false;
        setDayUseExtendSettingsLoading(true);
        fetch("/api/dayuse/settings")
            .then((r) => r.json())
            .then((d) => {
                if (cancelled || !d?.success) return;
                const extendRate = Number(d.settings?.dayuse_extend_rate ?? 100);
                const extendMin = Number(d.settings?.dayuse_extend_min ?? 60);
                setDayUseExtendMinutes(Number.isFinite(extendMin) ? Math.max(1, extendMin) : 60);
                setPaymentAmount((current) => {
                    const trimmed = String(current || "").trim();
                    if (trimmed.length > 0) return current;
                    return toMoneyInput(extendRate);
                });
            })
            .catch(() => {
                if (!cancelled) {
                    setDayUseExtendMinutes(60);
                    setPaymentAmount((current) => {
                        const trimmed = String(current || "").trim();
                        return trimmed.length > 0 ? current : "0.00";
                    });
                }
            })
            .finally(() => {
                if (!cancelled) setDayUseExtendSettingsLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [dayUseAmountOnlyMode]);

    function buildZeroRates(ci: string, co: string): NightlyRate[] {
        if (!ci || !co || co <= ci) return [];
        const dates: NightlyRate[] = [];
        let cur = ci;
        while (cur < co) {
            dates.push({ date: cur, rate: 0 });
            cur = addDays(cur, 1);
        }
        return dates;
    }

    function buildOtaManualRates(ci: string, co: string, seed: NightlyRate[] = nightlyRates): NightlyRate[] {
        if (!ci || !co || co <= ci) return [];
        const seedByDate = new Map(seed.map((item) => [item.date, fromSatang(toSatang(item.rate))]));
        const dates: NightlyRate[] = [];
        let cur = ci;
        while (cur < co) {
            dates.push({ date: cur, rate: seedByDate.get(cur) ?? 0 });
            cur = addDays(cur, 1);
        }
        return dates;
    }

    const chargeRoomTypeId = mode === "checkin" && !useSelectedRoomTypeForCharge && originalRoomTypeId
        ? originalRoomTypeId
        : roomTypeId;

    const addAccompanyingGuest = useCallback(async (profileId: string): Promise<ReservationGuestWithProfile[]> => {
        if (!reservationId || partySaving) return [];
        setPartySaving(true);
        setError("");
        try {
            const response = await fetch(`/api/bookings/${reservationId}/guests`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ guest_profile_id: profileId })
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || !data?.success) {
                throw new Error(data?.error || "Failed to add accompanying guest.");
            }
            setPartySearchQ("");
            setPartySearchResults([]);
            return await loadReservationParty();
        } catch (partyError) {
            setError(partyError instanceof Error ? partyError.message : "Failed to add accompanying guest.");
            return [];
        } finally {
            setPartySaving(false);
        }
    }, [loadReservationParty, partySaving, reservationId]);

    const removeAccompanyingGuest = useCallback(async (profileId: string): Promise<ReservationGuestWithProfile[]> => {
        if (!reservationId || partySaving) return [];
        setPartySaving(true);
        setError("");
        try {
            const response = await fetch(`/api/bookings/${reservationId}/guests?guest_profile_id=${encodeURIComponent(profileId)}`, {
                method: "DELETE"
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || !data?.success) {
                throw new Error(data?.error || "Failed to remove accompanying guest.");
            }
            return await loadReservationParty();
        } catch (partyError) {
            setError(partyError instanceof Error ? partyError.message : "Failed to remove accompanying guest.");
            return [];
        } finally {
            setPartySaving(false);
        }
    }, [loadReservationParty, partySaving, reservationId]);

    const selectPartySearchProfile = useCallback(async (profileId: string) => {
        setPartyDraftError("");
        setPartyDraftLoading(true);
        try {
            const profile = await fetchGuestProfileById(profileId);
            applyPartyDraftFromProfile(profile);
        } catch (draftError) {
            setPartyDraftError(draftError instanceof Error ? draftError.message : "Failed to load guest profile.");
        } finally {
            setPartyDraftLoading(false);
        }
    }, [applyPartyDraftFromProfile, fetchGuestProfileById]);

    const saveAccompanyingGuest = useCallback(async () => {
        if (!reservationId) {
            setPartyDraftError("Save the reservation first, then add accompanying guests.");
            return;
        }

        const nextFirstName = partyDraft.firstName.trim();
        const nextLastName = partyDraft.lastName.trim();
        if (!nextFirstName && !nextLastName) {
            setPartyDraftError("Guest name is required.");
            return;
        }
        if (partyDraft.idType === "thai_id" && !/^\d{13}$/.test(partyDraft.idNumber.trim())) {
            setPartyDraftError("Thai ID must be exactly 13 digits.");
            return;
        }

        const currentPartySize = reservationParty.length > 0
            ? reservationParty.length
            : guestProfileId || guestName.trim()
                ? 1
                : 0;
        const availableSlots = Math.max(0, 4 - currentPartySize);

        if (!partyDraft.linkedMemberId && availableSlots === 0) {
            setPartyDraftError("Room is already full.");
            return;
        }

        setPartySaving(true);
        setPartyDraftError("");
        try {
            let profileId = partyDraft.guestProfileId;
            const payload = {
                first_name: nextFirstName || undefined,
                last_name: nextLastName || nextFirstName || "Guest",
                phone: partyDraft.phone.trim() || undefined,
                gender: partyDraft.gender || undefined,
                nationality_code: partyDraft.nationalityCode || undefined,
                country: partyDraft.country.trim() || getCountryByCode(partyDraft.nationalityCode) || undefined,
                id_type: partyDraft.idType || undefined,
                id_number: partyDraft.idNumber.trim() || undefined,
                passport_no: partyDraft.idType === "passport" ? partyDraft.idNumber.trim() || undefined : undefined,
                id_card_number: partyDraft.idType === "thai_id" ? partyDraft.idNumber.trim() || undefined : undefined,
                dob: partyDraft.dob || undefined,
                profile_status: (partyDraft.profileStatus || "draft") as "draft" | "verified" | "merged" | "blacklisted",
                reservation_id: reservationId || undefined,
                source_flow: mode === "checkin"
                    ? "pms_checkin_sync_profile_accompanying"
                    : "pms_reservation_detail_accompanying",
            };
            const compactPayload = Object.fromEntries(
                Object.entries(payload).filter(([, value]) => value !== undefined)
            );

            if (profileId) {
                const patchRes = await fetch(`/api/guests/${profileId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(compactPayload),
                });
                const patchData = await patchRes.json().catch(() => null);
                if (!patchRes.ok || !patchData?.success) {
                    throw new Error(patchData?.error || "Failed to update accompanying guest profile.");
                }
                profileId = String(patchData?.profile?.id ?? profileId);
            } else {
                const createRes = await fetch("/api/guests", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(compactPayload),
                });
                const createData = await createRes.json().catch(() => null);
                if (!createRes.ok || !createData?.success || !createData?.profile?.id) {
                    throw new Error(createData?.error || "Failed to create guest profile.");
                }
                profileId = String(createData.profile.id);
            }

            if (!profileId) {
                throw new Error("Failed to resolve accompanying guest profile.");
            }

            if (!partyDraft.linkedMemberId) {
                const guests = await addAccompanyingGuest(profileId);
                const linkedMember = guests.find((member) => String(member.guest_profile_id) === String(profileId));
                const profile = await fetchGuestProfileById(profileId);
                applyPartyDraftFromProfile(profile, linkedMember?.id || null);
            } else {
                const guests = await loadReservationParty();
                const linkedMember = guests.find((member) => String(member.guest_profile_id) === String(profileId));
                const profile = await fetchGuestProfileById(profileId);
                applyPartyDraftFromProfile(profile, linkedMember?.id || null);
            }
        } catch (draftError) {
            setPartyDraftError(draftError instanceof Error ? draftError.message : "Failed to save accompanying guest.");
        } finally {
            setPartySaving(false);
        }
    }, [addAccompanyingGuest, applyPartyDraftFromProfile, fetchGuestProfileById, guestName, guestProfileId, loadReservationParty, partyDraft, reservationId, reservationParty.length]);

    const handleRemovePartyDraft = useCallback(async () => {
        if (!partyDraft.guestProfileId || !partyDraft.linkedMemberId) return;
        const confirmed = window.confirm("Are you sure to delete? Guest profile record will still remain.");
        if (!confirmed) return;
        const guests = await removeAccompanyingGuest(partyDraft.guestProfileId);
        if (guests.length === 0) {
            resetPartyDraft();
            return;
        }
        const nextMember = guests.find((member) => member.role === "accompanying") || null;
        if (nextMember) {
            await openPartyMemberModal(nextMember);
        } else {
            resetPartyDraft();
        }
    }, [openPartyMemberModal, partyDraft.guestProfileId, partyDraft.linkedMemberId, removeAccompanyingGuest, resetPartyDraft]);

    // Calculate nightly rates (rack or selected rate plan) by room type
    const fetchRatesForDates = useCallback(async (
        ci: string,
        co: string,
        options?: {
            roomTypeIdOverride?: string;
            roomIdOverride?: string;
            ratePlanIdOverride?: string;
            chargeRoomTypeIdOverride?: string;
            sourceOverride?: string;
        }
    ) => {
        if (!ci || !co || co <= ci) return [];
        const effectiveSource = options?.sourceOverride ?? source;

        if (effectiveSource === "ota") {
            return buildOtaManualRates(ci, co);
        }

        const selectedRoomId = options?.roomIdOverride ?? roomId;
        const roomRef = selectedRoomId
            ? rooms.find((r: any) => String(r.id) === String(selectedRoomId))
            : null;
        const inferredRoomTypeId = roomRef?.room_type_id != null ? String(roomRef.room_type_id) : "";
        const effectiveRoomTypeId =
            options?.chargeRoomTypeIdOverride ||
            options?.roomTypeIdOverride ||
            chargeRoomTypeId ||
            inferredRoomTypeId;
        const effectiveRatePlanId = options?.ratePlanIdOverride ?? ratePlanId;

        if (!effectiveRoomTypeId) {
            return buildZeroRates(ci, co);
        }

        try {
            const res = await fetch("/api/rate-plans/calculate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    room_id: selectedRoomId || undefined,
                    room_type_id: effectiveRoomTypeId,
                    checkin_date: ci,
                    checkout_date: co,
                    rate_plan_id: effectiveRatePlanId || undefined
                })
            });
            const d = await res.json();
            if (res.ok && d.success && Array.isArray(d.nights)) {
                return d.nights.map((night: any) => ({
                    date: String(night.date),
                    rate: Number(night.applied_rate ?? night.rack_rate ?? 0)
                }));
            }
        } catch {
            // Fallback below
        }

        return buildZeroRates(ci, co);
    }, [source, roomId, chargeRoomTypeId, ratePlanId, rooms, nightlyRates]);

    const refreshNightlyRates = useCallback(async (
        ci: string,
        co: string,
        options?: {
            roomTypeIdOverride?: string;
            roomIdOverride?: string;
            ratePlanIdOverride?: string;
            chargeRoomTypeIdOverride?: string;
            sourceOverride?: string;
        }
    ) => {
        const seq = ++rateRefreshSeqRef.current;
        setRateRefreshing(true);
        try {
            const rates = await fetchRatesForDates(ci, co, options);
            if (seq === rateRefreshSeqRef.current) {
                setNightlyRates(rates);
            }
        } finally {
            if (seq === rateRefreshSeqRef.current) {
                setRateRefreshing(false);
            }
        }
    }, [fetchRatesForDates]);

    const handleDatesChange = async (ci: string, co: string, n: number) => {
        if (mode === "create" && continuousStayPreview) clearContinuousStayPlan();
        setCheckinDate(ci);
        setCheckoutDate(co);
        setNights(n);
        await refreshNightlyRates(ci, co);
    };

    const handleChargeModeChange = async (nextUseSelected: boolean) => {
        setUseSelectedRoomTypeForCharge(nextUseSelected);
        const nextChargeRoomTypeId = nextUseSelected ? roomTypeId : (originalRoomTypeId || roomTypeId);
        await refreshNightlyRates(checkinDate, checkoutDate, {
            chargeRoomTypeIdOverride: nextChargeRoomTypeId
        });
    };

    const handleOtaNightlyRateChange = useCallback((index: number, nextValue: number) => {
        const normalized = fromSatang(toSatang(Math.max(0, nextValue)));
        setNightlyRates((current) =>
            current.map((item, idx) => (idx === index ? { ...item, rate: normalized } : item))
        );
    }, []);

    // Ensure create mode gets initial prices when room/room type is prefilled.
    useEffect(() => {
        if (mode !== "create") return;
        if (!roomTypeId || !checkinDate || !checkoutDate || checkoutDate <= checkinDate) return;
        if (nightlyRates.length > 0) return;

        void refreshNightlyRates(checkinDate, checkoutDate);
    }, [mode, roomTypeId, roomId, checkinDate, checkoutDate, nightlyRates.length, refreshNightlyRates]);

    /* ─── Computed ─── */
    const computedTotalSatang = nightlyRates.reduce((sum, n) => sum + toSatang(n.rate), 0);
    const discountPercent = useMemo(() => {
        if (computedTotalSatang <= 0) return 0;
        if (discountType === "percent") return Math.min(100, Math.max(0, discountValue));
        const totalDiscountSatang = discountType === "fixed_total"
            ? toSatang(discountValue)
            : toSatang(discountValue) * nightlyRates.length;
        return Math.min(100, Math.max(0, (totalDiscountSatang / computedTotalSatang) * 100));
    }, [computedTotalSatang, discountType, discountValue, nightlyRates.length]);
    const discountSatang = Math.min(
        computedTotalSatang,
        discountType === "percent"
            ? Math.trunc((computedTotalSatang * discountPercent) / 100)
            : Math.max(
                0,
                discountType === "fixed_total"
                    ? toSatang(discountValue)
                    : toSatang(discountValue) * nightlyRates.length
            )
    );
    const afterDiscount = fromSatang(computedTotalSatang - discountSatang);
    const effectiveTotal = mode === "checkout"
        ? totalPrice || afterDiscount
        : afterDiscount;
    const manualPlanStartDate = checkinDate && checkoutDate > checkinDate ? addDays(checkinDate, 1) : "";
    const hasContinuousStayPlanDraft = Boolean(
        mode === "create" &&
        continuousStayPayload &&
        continuousStayPreview?.requires_continuous_plan
    );
    const manualPlanDisabledReason = mode !== "create"
        ? "Manual Plan Move is available while creating a booking."
        : source === "ota"
            ? "OTA bookings should use the normal booking flow."
            : !roomId
                ? "Select the first room before planning a move."
                : !checkinDate || !checkoutDate || checkoutDate <= checkinDate
                    ? "Select valid stay dates first."
                    : checkoutDate <= manualPlanStartDate
                        ? "Plan Move needs at least 2 nights."
                        : "";
    const selectedRoomForPlanMove = roomId
        ? rooms.find((room: any) => String(room.id) === String(roomId))
        : null;
    const selectedRoomNumberForPlanMove = String(selectedRoomForPlanMove?.room_number || roomNumber || "");
    const canShowPreArrivalPlanMoveAction = Boolean(
        mode === "edit" &&
        reservationId &&
        reservationStatus === "active" &&
        !checkedInAt &&
        roomId &&
        roomTypeId &&
        selectedRoomNumberForPlanMove &&
        checkoutDate > addDays(checkinDate, 1)
    );
    const checkoutPaymentSatang = toSatang(paymentAmount);
    const checkoutBalanceSatang = toSatang(preCheckoutBalance);
    const checkoutRemainingSatang = Math.max(0, checkoutBalanceSatang - checkoutPaymentSatang);
    const checkoutRequiresPayment = mode === "checkout" && checkoutBalanceSatang > 0;
    const checkoutPaymentInsufficient = checkoutRequiresPayment && checkoutPaymentSatang < checkoutBalanceSatang;
    const blockingOpenLoans = openLoans.filter((loan: any) => !loan?.requires_hk_collection);
    const hkCollectOpenLoans = openLoans.filter((loan: any) => Boolean(loan?.requires_hk_collection));
    const isCheckedOutReservation = reservationStatus === "checked_out";
    const isCancelledReservation = reservationStatus === "cancelled";
    const isClosedReservation = isCheckedOutReservation || isCancelledReservation;
    const canEditCheckedOutReservation = mode === "edit" && isCheckedOutReservation && isCheckedOutEditAdmin;
    const readonlyCheckedOutReservation = isCheckedOutReservation && mode !== "checkout" && !canEditCheckedOutReservation;
    const readonlyClosedReservation = (isCancelledReservation || readonlyCheckedOutReservation) && mode !== "checkout";
    const isReadonly = mode === "checkout" || readonlyClosedReservation || dayUseAmountOnlyMode;
    const lockStayFields = isReadonly || canEditCheckedOutReservation;
    const lockPricingFields = isReadonly || canEditCheckedOutReservation;
    const interactionLocked = loading || rateRefreshing || continuousStayConfirming || continuousStayRefreshing;
    const checkoutSubmitDisabled =
        interactionLocked ||
        readonlyClosedReservation ||
        (dayUseAmountOnlyMode && dayUseExtendSettingsLoading) ||
        (mode === "checkout" && !preCheckoutLoaded);
    const lockCheckinDate =
        (reservationStatus === "active" &&
            mode !== "checkin" &&
            Boolean(checkedInAt)) ||
        canEditCheckedOutReservation;
    const lockMessage = loading ? "Saving changes..." : rateRefreshing ? "Updating rates..." : "";
    const bangkokTodayYmd = dateToYmd(getBangkokTodayDate());
    const canEditDeposit =
        !dayUseAmountOnlyMode &&
        (
            (mode === "checkin" && checkinDate <= bangkokTodayYmd) ||
            (mode === "edit" && reservationStatus === "active" && Boolean(checkedInAt))
        );
    const pendingDepositPreviewLines = useMemo(() => {
        const payments =
            mode === "checkin"
                ? pendingCheckinPayments
                : mode === "inhouse"
                    ? pendingInhousePayments
                    : [];
        return payments
            .map((payment) => ({
                method: payment.method,
                amount: getTransferDepositSplitAmount(payment.transfer_deposit_split),
                note: payment.note,
            }))
            .filter((line) => line.amount > 0);
    }, [mode, pendingCheckinPayments, pendingInhousePayments]);
    const pendingDepositPreviewSatang = pendingDepositPreviewLines.reduce(
        (sum, line) => sum + toSatang(line.amount),
        0
    );
    const depositSplitTargetAmount = mode === "checkin" && toSatang(depositInputAmount) > 0
        ? fromSatang(Math.max(0, toSatang(depositInputAmount) - pendingDepositPreviewSatang))
        : 0;

    const persistDeposit = useCallback(async (lines: DepositLine[], generalNote?: string) => {
        if (!reservationId) return false;
        const depositTotalSatang = lines.reduce((sum, line) => sum + toSatang(line.amount), 0);
        const depositTotal = fromSatang(depositTotalSatang);
        const normalizedGeneralNote = (generalNote ?? depositGeneralNote).trim();
        const effectiveGeneralNote = depositTotalSatang > 0 ? "" : normalizedGeneralNote;
        const payload = {
            deposit_amount: depositTotal,
            deposit_note: (lines.length > 0 || effectiveGeneralNote.length > 0)
                ? JSON.stringify({
                    lines,
                    note: effectiveGeneralNote || undefined
                })
                : null,
            allow_during_checkin: mode === "checkin",
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

        try {
            const res = await fetch(`/api/bookings/${reservationId}/deposit`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                setDepositInlineError(data?.error || "Failed to save deposit.");
                return false;
            }

            setDepositAmount(depositTotal);
            setDepositLines(lines);
            setDepositGeneralNote(effectiveGeneralNote);
            setDepositWarning(lines.length > 0 || effectiveGeneralNote.length > 0 ? "Deposit note stored as a snapshot." : "");
            setDepositInlineError("");
            return true;
        } catch (error) {
            if ((error as { name?: string })?.name === "AbortError") {
                setDepositInlineError("Deposit request timed out. Please try again.");
                return false;
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }, [reservationId, depositGeneralNote]);

    const handleAddDeposit = useCallback(async () => {
        if (!reservationId || depositSaving) return;
        if (depositInputAmount.trim() === "") {
            setDepositInlineError("Please enter deposit amount.");
            return;
        }
        const amountVal = Number(depositInputAmount);
        if (!Number.isFinite(amountVal) || amountVal < 0) {
            setDepositInlineError("Deposit amount must be 0 or greater.");
            return;
        }

        if (amountVal === 0) {
            if (!depositGeneralNote.trim()) {
                setDepositInlineError("Please enter deposit note for 0 amount.");
                return;
            }
            setDepositSaving(true);
            try {
                const ok = await persistDeposit(depositLines, depositGeneralNote);
                if (!ok) return;
                setDepositInputAmount("");
            } catch {
                setDepositInlineError("Network error while saving deposit.");
            } finally {
                setDepositSaving(false);
            }
            return;
        }

        const method = depositMethod || "cash";
        const nextLine: DepositLine = {
            method,
            amount: fromSatang(toSatang(amountVal)),
            note: depositInputNote.trim() || undefined
        };

        setDepositSaving(true);
        try {
            const ok = await persistDeposit([...depositLines, nextLine], depositGeneralNote);
            if (!ok) return;
            setDepositInputAmount("");
            setDepositInputNote("");
        } catch {
            setDepositInlineError("Network error while saving deposit.");
        } finally {
            setDepositSaving(false);
        }
    }, [reservationId, depositSaving, depositInputAmount, depositInputNote, depositMethod, depositLines, depositGeneralNote, persistDeposit]);

    const handleSaveDepositNote = useCallback(async () => {
        if (!reservationId || depositSaving) return;
        setDepositSaving(true);
        try {
            const ok = await persistDeposit(depositLines, depositGeneralNote);
            if (!ok) return;
        } catch {
            setDepositInlineError("Network error while saving deposit note.");
        } finally {
            setDepositSaving(false);
        }
    }, [reservationId, depositSaving, depositLines, depositGeneralNote, persistDeposit]);

    const [postChargeModalOpen, setPostChargeModalOpen] = useState(false);
    const [settlementDrawerOpen, setSettlementDrawerOpen] = useState(false);
    const [extraChargesTotalSatang, setExtraChargesTotalSatang] = useState(0);
    const [checkoutCreditsTotalSatang, setCheckoutCreditsTotalSatang] = useState(0);

    const fetchDepositTransactions = useCallback(async () => {
        if (!reservationId || mode === "create") return;
        try {
            const res = await fetch(`/api/bookings/${reservationId}/payments`);
            if (res.ok) {
                const data = await res.json();
                if (data.success && data.payments) {
                    const depTotal = computeHeldDepositFromRows(data.payments ?? []);
                    setDepositAmount(depTotal);
                }
            }
        } catch {
            // ignore
        }
    }, [reservationId, mode]);

    const fetchPaymentsAndCharges = useCallback(async () => {
        if (!reservationId || mode === "create") return;
        try {
            const [payRes, extraRes] = await Promise.all([
                 fetch(`/api/bookings/${reservationId}/payments`).catch(() => null),
                 fetch(`/api/bookings/${reservationId}/extra-charges`).catch(() => null),
            ]);
            let totalChargesSatang = 0;
            let totalCreditsSatang = 0;

            if (extraRes && extraRes.ok) {
                 const eData = await extraRes.json();
                 if (eData.success && eData.charges) {
                      const summaryTotal = Number(eData.summary?.extra_charges_total);
                      const totalAmt = Number.isFinite(summaryTotal)
                        ? summaryTotal
                        : (eData.charges || []).reduce((sum: number, c: any) => {
                              const amount = Number(c?.amount || 0);
                              if (!Number.isFinite(amount) || amount === 0) return sum;
                              return sum + (c?.tx_type === "refund" ? -Math.abs(amount) : Math.abs(amount));
                          }, 0);
                      totalChargesSatang = toSatang(totalAmt);
                      setExtraChargesTotalSatang(totalChargesSatang);
                 }
            }
            if (payRes && payRes.ok) {
                 const pData = await payRes.json();
                 if (pData.success && pData.payments) {
                      const persistedPaidSatang = pData.payments.reduce((sum: number, p: any) => {
                          const amount = toSatang(p.amount);
                          if (p.tx_type === "deposit") return sum;
                          if (p.tx_type === "payment") return sum + amount;
                          if (p.tx_type === "refund") return sum - amount;
                          return sum;
                      }, 0);
                      totalCreditsSatang = persistedPaidSatang;
                      setCheckoutCreditsTotalSatang(totalCreditsSatang);
                 }
            }
        } catch {
             // ignore
        }
        await fetchDepositTransactions();
    }, [reservationId, mode, fetchDepositTransactions]);

    useEffect(() => {
        if (!reservationId || mode === "create") return;
        void fetchPaymentsAndCharges();
    }, [reservationId, mode, fetchPaymentsAndCharges]);

    const handleClearDeposit = useCallback(async () => {
        if (!reservationId || depositSaving || (depositAmount <= 0 && !depositGeneralNote.trim())) return;
        setDepositSaving(true);
        try {
            const allowDuringCheckin = mode === "checkin" ? "?allow_during_checkin=1" : "";
            const res = await fetch(`/api/bookings/${reservationId}/deposit${allowDuringCheckin}`, { method: "DELETE" });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                setDepositInlineError(data?.error || "Failed to clear deposit.");
                return;
            }
            setDepositAmount(0);
            setDepositLines([]);
            setDepositGeneralNote("");
            setDepositWarning("");
            setDepositInputAmount(mode === "checkin" ? DEFAULT_CHECKIN_DEPOSIT_INPUT : "");
            setDepositInputNote("");
            setDepositInlineError("");
        } catch {
            setDepositInlineError("Network error while clearing deposit.");
        } finally {
            setDepositSaving(false);
        }
    }, [reservationId, depositAmount, depositGeneralNote, depositSaving, mode]);

    const handleDepositEnter = (e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        e.stopPropagation();
        if (canEditDeposit) {
            void handleAddDeposit();
        }
    };

    const syncGuestProfile = useCallback(async (): Promise<string | null> => {
        const { firstName, lastName } = splitGuestName(guestName);
        const normalizedFirstName = firstName.trim();
        const normalizedLastName = lastName.trim();
        const hasSingleNameToken = Boolean(normalizedFirstName) && !normalizedLastName;
        const normalizedCode = normalizeNationalityCode(profileNationalityCode);
        const inferredCountry = getCountryByCode(normalizedCode);
        const rawIdentity = profileIdNumber.trim() || identityText.trim();
        const identity = sanitizeIdentityForSubmit(rawIdentity, isProfileMasked);
        const normalizedProfileStatus = String(profileStatus || "").trim();
        const nextProfileNotes = (() => {
            const currentNotes = profileNotes.trim();
            const bookedName = initialBookedGuestName.trim();
            const actualName = guestName.trim();
            if (!bookedName || !actualName) return currentNotes || undefined;
            if (classifyGuestNameMatch(bookedName, actualName) !== "mismatch") {
                return currentNotes || undefined;
            }
            const merged = upsertBookedMainGuestNameNote(currentNotes, bookedName);
            return merged || undefined;
        })();

            const payload: Record<string, unknown> = {
                first_name: hasSingleNameToken ? undefined : normalizedFirstName || undefined,
                last_name: normalizedLastName || normalizedFirstName || "Guest",
            phone: phone.trim() || undefined,
            email: profileEmail.trim() || undefined,
            gender: profileGender || undefined,
            nationality_code: normalizedCode || undefined,
            country: profileCountry.trim() || inferredCountry || undefined,
            province: profileProvince.trim() || undefined,
            id_type: profileIdType || undefined,
            id_number: identity || undefined,
            passport_no: profileIdType === "passport" ? identity || undefined : undefined,
            id_card_number: profileIdType === "thai_id" ? identity || undefined : undefined,
            dob: profileDob || undefined,
            whatsapp: profileWhatsapp.trim() || undefined,
            line_id: profileLineId.trim() || undefined,
            address: profileAddress.trim() || undefined,
            vip_tier: profileVipTier.trim() || undefined,
            preferences: profilePreferences.trim() || undefined,
                notes: nextProfileNotes,
                profile_status: normalizedProfileStatus || (mode === "checkin" ? "draft" : undefined),
                blacklisted: profileBlacklisted,
                reservation_id: reservationId || undefined,
                source_flow: mode === "checkin"
                    ? "pms_checkin_sync_profile_primary"
                    : "pms_reservation_detail_primary",
            };

        const compactPayload = Object.fromEntries(
            Object.entries(payload).filter(([, value]) => value !== undefined)
        );

        let profileId = guestProfileId;
        const forkSharedProfile = shouldForkSharedProfile({
            profileId, reservationId, activeReservationCount: linkedProfileActiveReservationCount,
            linkedProfileName, guestName, profileBookingNames,
        });

        if (!profileId || forkSharedProfile) {
            const createRes = await fetch("/api/guests", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(compactPayload)
            });
            const createData = await createRes.json().catch(() => null);
            if (!createRes.ok || !createData?.success || !createData?.profile?.id) {
                throw new Error(createData?.error || "Failed to create guest profile.");
            }
            profileId = String(createData.profile.id);
            setGuestProfileId(profileId);
            applyProfileDraft(createData.profile, { overwriteGuest: false });
            if (createData?.rerouted) {
                const profileName = joinGuestName(createData.profile.first_name || "", createData.profile.last_name || "").trim() || "Unknown";
                const nextMessage = `เลขเอกสารนี้มี guest profile อยู่แล้ว ระบบจึงใช้โปรไฟล์เดิมแทน: ${profileName}`;
                setDocumentProfileHint(nextMessage);
                setSuccessMessage(nextMessage);
            }
        } else {
            const patchRes = await fetch(`/api/guests/${profileId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(compactPayload)
            });
            const patchData = await patchRes.json().catch(() => null);
            if (!patchRes.ok || !patchData?.success) {
                throw new Error(patchData?.error || "Failed to update guest profile.");
            }
            profileId = String(patchData?.profile?.id ?? profileId);
            setGuestProfileId(profileId);
            applyProfileDraft(patchData.profile, { overwriteGuest: false });
            if (patchData?.rerouted) {
                const profileName = joinGuestName(patchData.profile.first_name || "", patchData.profile.last_name || "").trim() || "Unknown";
                const nextMessage = `เลขเอกสารนี้มี guest profile อยู่แล้ว ระบบจึงใช้โปรไฟล์เดิมแทน: ${profileName}`;
                setDocumentProfileHint(nextMessage);
                setSuccessMessage(nextMessage);
            }
        }

        if (profileId && reservationId) {
            const linkRes = await fetch(`/api/bookings/${reservationId}/guest-profile`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ guest_profile_id: profileId })
            });
            const linkData = await linkRes.json().catch(() => null);
            if (!linkRes.ok || !linkData?.success) {
                throw new Error(linkData?.error || "Failed to link guest profile.");
            }
        }

        return profileId;
    }, [
        guestName,
        profileNationalityCode,
        profileIdNumber,
        identityText,
        phone,
        profileEmail,
        profileGender,
        profileCountry,
        profileProvince,
        profileIdType,
        profileDob,
        profileWhatsapp,
        profileLineId,
        profileAddress,
        profileVipTier,
        profilePreferences,
        profileNotes,
        initialBookedGuestName,
        profileStatus,
        profileBlacklisted,
        isProfileMasked,
        mode,
        guestProfileId,
        reservationId,
        linkedProfileName,
        linkedProfileActiveReservationCount,
        profileBookingNames,
        applyProfileDraft
    ]);

    const isActiveCheckedInReservation = reservationStatus === "active" && Boolean(checkedInAt);
    const checkedInBusinessDate =
        /^\d{4}-\d{2}-\d{2}/.test(checkedInAt) ? checkedInAt.slice(0, 10) : "";
    const canEditCheckedInTimestamp =
        !isActiveCheckedInReservation ||
        isCheckedOutEditAdmin ||
        !businessDate ||
        !checkedInBusinessDate ||
        businessDate <= checkedInBusinessDate;
    const shouldApplyShortenPolicy =
        Boolean(reservationId) &&
        (mode === "inhouse" || (mode === "edit" && isActiveCheckedInReservation));

    function flattenContinuousStayRates(preview: ContinuousStayPreviewState): NightlyRate[] {
        return preview.segments
            .flatMap((segment) =>
                segment.nightly_rates.map((night) => ({
                    date: night.stay_date,
                    rate: fromSatang(toSatang(night.rate)),
                }))
            )
            .sort((left, right) => left.date.localeCompare(right.date));
    }

    function applyContinuousStayPreview(preview: ContinuousStayPreviewState) {
        setContinuousStayPreview(preview);
        setNightlyRates(flattenContinuousStayRates(preview));
    }

    function clearContinuousStayPlan() {
        setContinuousStayPayload(null);
        setContinuousStayPreview(null);
        setContinuousStayPlanMode(null);
    }

    function buildCreateBookingPayload(options?: {
        guestNameOverride?: string;
        guestProfileIdOverride?: string | null;
        expectedArrivalOverride?: string | null;
        roomOverrides?: Array<{ start_date: string; end_date: string; room_id: string }>;
    }) {
        const normalizedName = (options?.guestNameOverride ?? cleanBookingNameInput(guestName)) || "Guest";
        const expectedArrival =
            options && "expectedArrivalOverride" in options
                ? options.expectedArrivalOverride
                : normalizeExpectedArrivalTimeDraft(expectedArrivalTime) || null;
        const payload: any = {
            guest_name: normalizedName,
            checkin_date: checkinDate,
            checkout_date: checkoutDate,
            source,
            phone: phone.trim() || undefined,
            note: note.trim() || undefined,
            specials: specials.trim() || undefined,
            discount_percent: discountPercent || undefined,
            discount_type: discountType,
            discount_value: discountValue || 0,
            discount_reason: discountReason.trim() || undefined,
            expected_arrival_time: expectedArrival || null,
        };
        if (roomId) payload.room_id = roomId;
        else if (roomTypeId) payload.room_type_id = roomTypeId;
        if (ratePlanId) payload.rate_plan_id = ratePlanId;
        if (bookingGroupId) payload.booking_group_id = bookingGroupId;
        const effectiveGuestProfileId =
            options && "guestProfileIdOverride" in options
                ? options.guestProfileIdOverride
                : guestProfileId;
        if (effectiveGuestProfileId) payload.guest_profile_id = effectiveGuestProfileId;
        if (source === "ota") {
            payload.ota_prices = nightlyRates.map(r => r.rate);
            if (otaRef) payload.ota_ref = otaRef;
        }
        if (options?.roomOverrides?.length) payload.room_overrides = options.roomOverrides;
        return payload;
    }

    async function previewContinuousStayPayload(payload: any, planMode: "conflict" | "manual") {
        const previewRes = await fetch("/api/bookings/continuous-stay/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const previewData = await previewRes.json().catch(() => null);
        if (!previewRes.ok || !previewData?.success) {
            throw new Error(previewData?.error || "Failed to preview room plan.");
        }
        if (!previewData.requires_continuous_plan) {
            throw new Error("Selected room plan does not create a room move.");
        }
        setContinuousStayPayload(payload);
        setContinuousStayPlanMode(planMode);
        applyContinuousStayPreview(previewData as ContinuousStayPreviewState);
        setError("");
    }

    async function handleStartManualRoomPlan() {
        if (manualPlanDisabledReason) {
            setError(manualPlanDisabledReason);
            return;
        }
        const overrideStartDate = manualPlanStartDate;
        const currentRoomId = String(roomId || "");
        const candidates = rooms
            .filter((room: any) => String(room?.id || "") && String(room.id) !== currentRoomId)
            .sort((left: any, right: any) => {
                const leftSameType = String(left.room_type_id) === String(roomTypeId) ? 0 : 1;
                const rightSameType = String(right.room_type_id) === String(roomTypeId) ? 0 : 1;
                if (leftSameType !== rightSameType) return leftSameType - rightSameType;
                return String(left.room_number || "").localeCompare(String(right.room_number || ""), undefined, {
                    numeric: true,
                    sensitivity: "base",
                });
            });

        if (candidates.length === 0) {
            setError("No room candidates are available for Plan Move.");
            return;
        }

        setContinuousStayRefreshing(true);
        setError("");
        try {
            let lastError = "";
            for (const candidate of candidates) {
                const roomOverrides = [{
                    start_date: overrideStartDate,
                    end_date: checkoutDate,
                    room_id: String(candidate.id),
                }];
                const payload = buildCreateBookingPayload({
                    guestNameOverride: cleanBookingNameInput(guestName) || "Guest",
                    guestProfileIdOverride: guestProfileId,
                    roomOverrides,
                });
                try {
                    await previewContinuousStayPayload(payload, "manual");
                    return;
                } catch (error) {
                    lastError = error instanceof Error ? error.message : "Selected move room is not available.";
                }
            }
            setError(lastError || "No available room found for the planned move segment.");
        } finally {
            setContinuousStayRefreshing(false);
        }
    }

    const handleReverseNoShow = useCallback(async () => {
        if (!reservationId || reverseNoShowLoading) return;
        setReverseNoShowLoading(true);
        setError("");
        setSuccessMessage("");
        try {
            const response = await fetch(`/api/bookings/${reservationId}/reverse-no-show`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || !payload?.success) {
                setError(payload?.error || "Failed to reverse no-show.");
                return;
            }
            setShowReverseNoShowDialog(false);
            setSuccessMessage(
                payload?.room_assignment_cleared
                    ? "No-show reversed. Reservation is active again; assign a room before check-in."
                    : "No-show reversed. Reservation is active again."
            );
            setReloadToken((value) => value + 1);
        } catch {
            setError("Failed to reverse no-show.");
        } finally {
            setReverseNoShowLoading(false);
        }
    }, [reservationId, reverseNoShowLoading]);

    /* ─── Submit ─── */
    const handleSubmit = async (e?: FormEvent) => {
        if (e) e.preventDefault();
        if (profileIdType === "thai_id" && hasInvalidThaiId(profileIdNumber, isProfileMasked)) {
            if (mode === "checkin") {
                setShowCheckinFieldValidation(true);
            }
            setError("Thai ID must be exactly 13 digits.");
            return;
        }
        if (expectedArrivalTime.trim() && !/^\d{2}:\d{2}$/.test(expectedArrivalTime.trim())) {
            setError("Expected arrival time must be HH:mm.");
            return;
        }
        const normalizedGuestName = cleanBookingNameInput(guestName);
        if (normalizedGuestName !== guestName) {
            setGuestName(normalizedGuestName);
        }
        if (!normalizedGuestName) {
            setError("Guest Name is required.");
            return;
        }
        setLoading(true);
        setError("");
        setSuccessMessage("");
        const submitter = (e?.nativeEvent as SubmitEvent | undefined)?.submitter as HTMLButtonElement | null;
        const currentSubmitIntent = submitter?.dataset?.checkinIntent === "draft" ? "draft" : "confirm";
        if (e) setSubmitIntentState(currentSubmitIntent);
        const activeIntent = e ? currentSubmitIntent : submitIntentState;

        if (!bypassPolicy) {
            if (shouldApplyShortenPolicy) {
                if (checkoutDate < originalCheckoutDate && !showShortenModal) {
                    try {
                        const previewRes = await fetch(
                            `/api/bookings/${reservationId}/settlement-preview?action=shorten&new_checkout_date=${encodeURIComponent(checkoutDate)}`
                        );
                        const previewData = await previewRes.json().catch(() => null);
                        if (!previewRes.ok || !previewData?.success) {
                            setError(previewData?.error || "Failed to load shorten settlement preview.");
                            setLoading(false);
                            return;
                        }
                        setShortenPreview(previewData);
                    } catch {
                        setError("Failed to load shorten settlement preview.");
                        setLoading(false);
                        return;
                    }
                    setShowShortenModal(true);
                    setLoading(false);
                    return;
                }
            }
            if (mode === "checkin" && reservationId && activeIntent !== "draft") {
                const nowCheckin = formatBangkokDateTimeLocal(new Date());
                const timePart = checkedInAt ? (checkedInAt.includes('T') ? checkedInAt.split('T')[1].slice(0, 5) : checkedInAt.slice(11, 16)) : nowCheckin.split('T')[1].slice(0, 5);
                if (timePart >= "04:00" && timePart <= "08:59" && !showEarlyCheckinModal) {
                    const firstNightRate = nightlyRates.length > 0 ? nightlyRates[0].rate : 0;
                    setSuggestedPolicyFee(firstNightRate * 0.5);
                    setShowEarlyCheckinModal(true);
                    setLoading(false);
                    return;
                }
            }
            if (mode === "checkout" && reservationId && !dayUseAmountOnlyMode && !isDayUse) {
                const nowCheckout = formatBangkokDateTimeLocal(new Date());
                const timePart = nowCheckout.split('T')[1].slice(0, 5);
                if (timePart >= "13:01" && !showLateCheckoutModal) {
                    const shouldShowLatePolicyModal = timePart >= "16:01" || !hasPrepaidLateCheckout;
                    if (!shouldShowLatePolicyModal) {
                        // Late checkout fee already collected on Due Out day.
                        // Skip 13:01-16:00 prompt to avoid charging twice.
                        setShowLateCheckoutModal(false);
                    } else {
                    const lastNightRate = nightlyRates.length > 0 ? nightlyRates[nightlyRates.length - 1].rate : 0;
                    if (timePart >= "16:01") {
                        setIsAfter1600(true);
                        setSuggestedPolicyFee(lastNightRate);
                    } else {
                        setIsAfter1600(false);
                        setSuggestedPolicyFee(lastNightRate * 0.5);
                    }
                    setShowLateCheckoutModal(true);
                    setLoading(false);
                    return;
                    }
                }
            }
        }

        try {
            const normalizedExpectedArrival = normalizeExpectedArrivalTimeDraft(expectedArrivalTime);
            const normalizedInitialExpectedArrival = normalizeExpectedArrivalTimeDraft(initialExpectedArrivalTime);
            const shouldSendExpectedArrivalField =
                mode === "create" || normalizedExpectedArrival !== normalizedInitialExpectedArrival;
            let syncedGuestProfileId = guestProfileId;
            if (!dayUseAmountOnlyMode && (mode === "create" || mode === "edit" || mode === "checkin" || mode === "inhouse")) {
                try {
                    syncedGuestProfileId = await syncGuestProfile();
                } catch (identityError) {
                    setError(identityError instanceof Error ? identityError.message : "Failed to save guest profile.");
                    setLoading(false);
                    return;
                }
            }

            let priceChangeChoice: "keep_existing" | "apply_rate_grid" | undefined;
            const isEditFlow = mode === "edit" || mode === "inhouse" || mode === "checkin";
            const roomTypeChangedInForm =
                Boolean(originalRoomTypeId) &&
                Boolean(roomTypeId) &&
                String(originalRoomTypeId) !== String(roomTypeId);
            const ratePlanChangedInForm =
                String(originalRatePlanId || "") !== String(ratePlanId || "");

            if (reservationId && isEditFlow && source !== "ota") {
                if (roomTypeChangedInForm) {
                    window.alert(
                        "Room type changed. The system will recalculate rates from the current Rate Grid for this room type."
                    );
                    priceChangeChoice = "apply_rate_grid";
                } else if (ratePlanChangedInForm) {
                    const applyRateGrid = window.confirm(
                        [
                            "Rate plan has changed.",
                            "",
                            "OK = Recalculate all current nights with latest Rate Grid/Rate Plan.",
                            "Cancel = Keep existing booked prices for current nights (only newly added nights follow latest rate).",
                        ].join("\n")
                    );
                    priceChangeChoice = applyRateGrid ? "apply_rate_grid" : "keep_existing";
                }
            }

            if (reservationId && isEditFlow && source === "ota" && roomTypeChangedInForm) {
                window.alert("OTA room type changed. Please manually re-check OTA nightly prices after saving.");
            }

            if (dayUseAmountOnlyMode && reservationId) {
                const parsedAmount = fromSatang(toSatang(paymentAmount));
                const extendRequest = buildDayUseExtendRequest({ paymentMethod, paymentAmount: parsedAmount });
                if (!extendRequest) {
                    setError("Invalid extension amount.");
                    setLoading(false);
                    return;
                }

                const methodLabel = extendRequest.payment_method === "transfer"
                    ? "Bank Transfer" : extendRequest.payment_method === "credit_card" ? "Credit Card" : "Cash";
                if (!window.confirm(formatDayUseExtendConfirm({
                    minutes: dayUseExtendMinutes ?? 60,
                    amountLabel: `฿${formatMoney(extendRequest.payment_amount)}`,
                    methodLabel,
                }))) {
                    setLoading(false);
                    return;
                }
                const extendRes = await fetch(`/api/dayuse/${reservationId}/extend`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(extendRequest)
                });
                const extendData = await extendRes.json().catch(() => null);
                if (!extendRes.ok || !extendData?.success) {
                    setError(extendData?.error || "Failed to extend day use session.");
                    setLoading(false);
                    return;
                }
                onSuccess();
                return;
            }

            if (mode === "create") {
                if (source === "ota") {
                    const hasInvalidOtaRates =
                        nightlyRates.length === 0 ||
                        nightlyRates.some((night) => !Number.isFinite(Number(night.rate)) || Number(night.rate) <= 0);
                    if (hasInvalidOtaRates) {
                        setError("Please fill OTA nightly prices before creating booking.");
                        setLoading(false);
                        return;
                    }
                    const confirmed = window.confirm(
                        "OTA booking selected. Confirm OTA nightly prices are filled correctly before saving."
                    );
                    if (!confirmed) {
                        setLoading(false);
                        return;
                    }
                }

                const roomOverrides = Array.isArray(continuousStayPayload?.room_overrides)
                    ? continuousStayPayload.room_overrides
                    : undefined;
                const payload = buildCreateBookingPayload({
                    guestNameOverride: normalizedGuestName,
                    guestProfileIdOverride: syncedGuestProfileId,
                    expectedArrivalOverride: shouldSendExpectedArrivalField ? normalizedExpectedArrival || null : undefined,
                    roomOverrides,
                });

                if (hasContinuousStayPlanDraft && continuousStayPreview) {
                    await handleConfirmContinuousStayPlan(payload, continuousStayPreview);
                    return;
                }

                const res = await fetch("/api/bookings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                const d = await res.json();
                if (!res.ok) {
                    if (res.status === 409 && source !== "ota") {
                        try {
                            await previewContinuousStayPayload(payload, "conflict");
                            setLoading(false);
                            return;
                        } catch (previewError) {
                            console.error("Continuous stay preview failed", previewError);
                        }
                    }
                    setError(d.error || "Failed to create.");
                    setLoading(false);
                    return;
                }
                clearContinuousStayPlan();
                const created = d?.reservation ?? {};
                const createdReservationId = String(created?.id || "");
                const canContinueToCheckinAfterCreate = Boolean(
                    onOpenCheckin &&
                    source === "walkin" &&
                    checkinDate === businessDate &&
                    roomTypeId &&
                    roomId &&
                    hasMainGuestIdentityImport &&
                    canOfferContinueToCheckin(syncedGuestProfileId)
                );
                const selectedRoom = roomId
                    ? rooms.find((r: any) => String(r.id) === String(roomId))
                    : null;
                const selectedRoomType = roomTypeId
                    ? roomTypes.find((rt: any) => String(rt.id) === String(roomTypeId))
                    : null;
                const createdTotal = Number(created?.total_price);

                if (syncedGuestProfileId) {
                    try {
                        const lfRes = await fetch(`/api/lost-found/check-guest?guest_profile_id=${syncedGuestProfileId}`);
                        if (lfRes.ok) {
                            const lfData = await lfRes.json();
                            if (lfData.alert) showPopup(lfData.alert);
                            else if (lfData.items) showPopup(lfData);
                        }
                    } catch (e) {
                        console.error("L&F check failed", e);
                    }
                }

                setLoading(false);
                setCreatedSummary({
                    bookingCode: String(created?.booking_code || created?.id || "N/A"),
                    guestName: normalizedGuestName || String(created?.guest_name || "Guest"),
                    source,
                    roomTypeName: selectedRoomType?.name_en || "Unspecified",
                    roomNumber: selectedRoom?.room_number || created?.room_number || null,
                    checkinDate,
                    checkoutDate,
                    nights,
                    totalPrice: Number.isFinite(createdTotal) ? fromSatang(toSatang(createdTotal)) : effectiveTotal,
                    createdReservationId: createdReservationId || null,
                    canContinueToCheckin: Boolean(canContinueToCheckinAfterCreate && createdReservationId),
                });
                return;

            } else if (mode === "edit" && reservationId) {
                const shouldUseShortenSettlement = shouldApplyShortenPolicy && checkoutDate < originalCheckoutDate;
                const checkedOutMetadataOnlyEdit = canEditCheckedOutReservation;

                const payload: any = {
                    guest_name: normalizedGuestName,
                    checkin_date: checkinDate,
                    checkout_date: checkoutDate,
                    source,
                    phone: phone.trim() || undefined,
                    note: note.trim() || undefined,
                    specials: specials.trim(),
                };
                const roomAssignmentChanged = String(roomId || "") !== String(initialAssignedRoomId || "");
                const roomTypeAssignmentChanged = String(roomTypeId || "") !== String(initialAssignedRoomTypeId || "");
                if (roomAssignmentChanged) {
                    payload.room_id = roomId || null;
                }
                if (roomTypeAssignmentChanged && roomTypeId) payload.room_type_id = roomTypeId;
                if (syncedGuestProfileId) payload.guest_profile_id = syncedGuestProfileId;
                if (shouldSendExpectedArrivalField) payload.expected_arrival_time = normalizedExpectedArrival || null;
                if (!checkedOutMetadataOnlyEdit) {
                    payload.discount_percent = discountPercent || undefined;
                    payload.discount_type = discountType;
                    payload.discount_value = discountValue || 0;
                    payload.discount_reason = discountReason.trim() || undefined;
                    if (ratePlanId) payload.rate_plan_id = ratePlanId;
                    else if (originalRatePlanId) payload.rate_plan_id = null;
                    if (priceChangeChoice) payload.price_change_choice = priceChangeChoice;
                    if (source === "ota") payload.ota_prices = nightlyRates.map(r => r.rate);
                }

                if (shouldUseShortenSettlement) {
                    const shortenRes = await fetch(`/api/bookings/${reservationId}/shorten`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            new_checkout_date: checkoutDate,
                            update_payload: payload,
                            fee_amount: Number(policyFeePayload?.amount ?? 0),
                            fee_collect_method: policyFeePayload?.fee_collect_method
                                ?? (policyFeePayload?.payment_method === "cash"
                                    || policyFeePayload?.payment_method === "transfer"
                                    || policyFeePayload?.payment_method === "credit_card"
                                    ? policyFeePayload.payment_method
                                    : undefined),
                            refund_method: policyFeePayload?.refund_method,
                            fee_note: policyFeePayload?.note,
                            refund_note: policyFeePayload?.refund_note,
                        })
                    });
                    const shortenData = await shortenRes.json().catch(() => null);
                    if (!shortenRes.ok || !shortenData?.success) {
                        setError(shortenData?.error || shortenData?.warning || "Failed to shorten stay.");
                        setLoading(false);
                        return;
                    }
                } else {
                    const res = await fetch(`/api/bookings/${reservationId}`, {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload)
                    });
                    const d = await res.json();
                    if (!res.ok) {
                        setError(d.error || "Failed to update.");
                        setLoading(false);
                        return;
                    }
                    if (Array.isArray(d?.warnings) && d.warnings.length > 0) {
                        window.alert(d.warnings.join("\n"));
                    }
                }
                onSuccess();

            } else if (mode === "inhouse" && reservationId) {
                const shouldUseShortenSettlement = shouldApplyShortenPolicy && checkoutDate < originalCheckoutDate;
                const checkinTimestampChanged = checkedInAt !== initialCheckedInAt;

                const payload: any = {
                    guest_name: normalizedGuestName,
                    checkin_date: checkinDate,
                    checkout_date: checkoutDate,
                    source,
                    phone: phone.trim() || undefined,
                    note: note.trim() || undefined,
                    specials: specials.trim(),
                    discount_percent: discountPercent || undefined,
                    discount_type: discountType,
                    discount_value: discountValue || 0,
                    discount_reason: discountReason.trim() || undefined,
                };
                const roomAssignmentChanged = String(roomId || "") !== String(initialAssignedRoomId || "");
                const roomTypeAssignmentChanged = String(roomTypeId || "") !== String(initialAssignedRoomTypeId || "");
                if (roomAssignmentChanged) {
                    payload.room_id = roomId || null;
                }
                if (roomTypeAssignmentChanged && roomTypeId) payload.room_type_id = roomTypeId;
                if (ratePlanId) payload.rate_plan_id = ratePlanId;
                else if (originalRatePlanId) payload.rate_plan_id = null;
                if (priceChangeChoice) payload.price_change_choice = priceChangeChoice;
                if (syncedGuestProfileId) payload.guest_profile_id = syncedGuestProfileId;
                if (shouldSendExpectedArrivalField) payload.expected_arrival_time = normalizedExpectedArrival || null;
                if (source === "ota") payload.ota_prices = nightlyRates.map(r => r.rate);
                if (checkinTimestampChanged) {
                    payload.checkin_time = extractHHmmFromLocalDateTime(checkedInAt);
                    payload.checked_in_at = checkedInAt ? bangkokLocalToIso(checkedInAt) : null;
                }

                if (shouldUseShortenSettlement) {
                    const shortenRes = await fetch(`/api/bookings/${reservationId}/shorten`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            new_checkout_date: checkoutDate,
                            update_payload: payload,
                            fee_amount: Number(policyFeePayload?.amount ?? 0),
                            fee_collect_method: policyFeePayload?.fee_collect_method
                                ?? (policyFeePayload?.payment_method === "cash"
                                    || policyFeePayload?.payment_method === "transfer"
                                    || policyFeePayload?.payment_method === "credit_card"
                                    ? policyFeePayload.payment_method
                                    : undefined),
                            refund_method: policyFeePayload?.refund_method,
                            fee_note: policyFeePayload?.note,
                            refund_note: policyFeePayload?.refund_note,
                        })
                    });
                    const shortenData = await shortenRes.json().catch(() => null);
                    if (!shortenRes.ok || !shortenData?.success) {
                        setError(shortenData?.error || shortenData?.warning || "Failed to shorten in-house stay.");
                        setLoading(false);
                        return;
                    }
                } else {
                    const res = await fetch(`/api/bookings/${reservationId}`, {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload)
                    });
                    const d = await res.json();
                    if (!res.ok) {
                        setError(d.error || "Failed to update in-house details.");
                        setLoading(false);
                        return;
                    }
                    if (Array.isArray(d?.warnings) && d.warnings.length > 0) {
                        window.alert(d.warnings.join("\n"));
                    }
                }
                if (pendingInhousePayments.length > 0) {
                    let paymentTargetReservationId = reservationId;
                    for (const payment of pendingInhousePayments) {
                        const paymentRes = await fetch(`/api/bookings/${paymentTargetReservationId}/payments`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                tx_type: "payment",
                                method: payment.method,
                                amount: payment.amount,
                                note: payment.note || null,
                                transfer_detail: payment.transfer_detail,
                                require_transfer_detail: payment.method === "transfer" && !!payment.transfer_detail,
                                transfer_deposit_split: payment.transfer_deposit_split,
                            })
                        });
                        const paymentData = await paymentRes.json().catch(() => null);
                        if (!paymentRes.ok || !paymentData?.success) {
                            setError(paymentData?.error || "Failed to save in-house payment.");
                            setLoading(false);
                            return;
                        }
                        const effectiveReservationId =
                            typeof paymentData?.effective_reservation_id === "string"
                                ? paymentData.effective_reservation_id
                                : paymentTargetReservationId;
                        if (effectiveReservationId && effectiveReservationId !== paymentTargetReservationId) {
                            paymentTargetReservationId = effectiveReservationId;
                            handleSwitchLinkedTab(effectiveReservationId);
                        }
                    }
                }
                setPendingInhousePayments([]);
                onSuccess();

            } else if (mode === "checkin" && reservationId) {
                if (activeIntent !== "draft" && !roomId && !initialAssignedRoomId) {
                    setError("Please assign a room before check-in.");
                    setLoading(false);
                    return;
                }
                if (activeIntent !== "draft" && !checkinProfileCompleteness.is_complete) {
                    setShowCheckinFieldValidation(true);
                    setError(
                        `Incomplete profile: ${checkinProfileCompleteness.missing_fields.join(", ")}. Complete profile or Save Draft.`
                    );
                    setLoading(false);
                    return;
                }

                const updatePayload: any = {
                    guest_name: normalizedGuestName,
                    checkin_date: checkinDate,
                    checkout_date: checkoutDate,
                    source,
                    phone: phone.trim() || undefined,
                    note: note.trim() || undefined,
                    specials: specials.trim(),
                    discount_percent: discountPercent || undefined,
                    discount_type: discountType,
                    discount_value: discountValue || 0,
                    discount_reason: discountReason.trim() || undefined,
                };
                const checkinTimeDraft = extractHHmmFromLocalDateTime(checkedInAt);
                if (activeIntent === "draft" && checkinTimeDraft) {
                    updatePayload.checkin_time = checkinTimeDraft;
                }
                const roomAssignmentChanged = String(roomId || "") !== String(initialAssignedRoomId || "");
                const roomTypeAssignmentChanged = String(chargeRoomTypeId || "") !== String(initialAssignedRoomTypeId || "");
                if (roomAssignmentChanged) {
                    updatePayload.room_id = roomId || null;
                }
                if (roomTypeAssignmentChanged && chargeRoomTypeId) updatePayload.room_type_id = chargeRoomTypeId;
                if (ratePlanId) updatePayload.rate_plan_id = ratePlanId;
                else if (originalRatePlanId) updatePayload.rate_plan_id = null;
                if (priceChangeChoice) updatePayload.price_change_choice = priceChangeChoice;
                if (syncedGuestProfileId) updatePayload.guest_profile_id = syncedGuestProfileId;
                if (shouldSendExpectedArrivalField) updatePayload.expected_arrival_time = normalizedExpectedArrival || null;
                if (source === "ota") updatePayload.ota_prices = nightlyRates.map(r => r.rate);

                const updateRes = await fetch(`/api/bookings/${reservationId}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(updatePayload)
                });
                const updateData = await updateRes.json();
                if (!updateRes.ok) {
                    setError(updateData.error || "Failed to save check-in changes.");
                    setLoading(false);
                    return;
                }
                if (Array.isArray(updateData?.warnings) && updateData.warnings.length > 0) {
                    window.alert(updateData.warnings.join("\n"));
                }

                if (activeIntent === "draft") {
                    if (pendingCheckinPayments.length > 0) {
                        let paymentTargetReservationId = reservationId;
                        for (const payment of pendingCheckinPayments) {
                            const paymentRes = await fetch(`/api/bookings/${paymentTargetReservationId}/payments`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    tx_type: "payment",
                                    method: payment.method,
                                    amount: payment.amount,
                                    note: payment.note || null,
                                    transfer_detail: payment.transfer_detail,
                                    require_transfer_detail: payment.method === "transfer" && !!payment.transfer_detail,
                                    transfer_deposit_split: payment.transfer_deposit_split,
                                })
                            });
                            const paymentData = await paymentRes.json().catch(() => null);
                            if (!paymentRes.ok || !paymentData?.success) {
                                setError(paymentData?.error || "Failed to save payment draft.");
                                setLoading(false);
                                return;
                            }
                            const effectiveReservationId =
                                typeof paymentData?.effective_reservation_id === "string"
                                    ? paymentData.effective_reservation_id
                                    : paymentTargetReservationId;
                            if (effectiveReservationId && effectiveReservationId !== paymentTargetReservationId) {
                                paymentTargetReservationId = effectiveReservationId;
                                handleSwitchLinkedTab(effectiveReservationId);
                            }
                        }
                    }
                    setPendingCheckinPayments([]);
                    setShowCheckinFieldValidation(false);
                    onSuccess();
                    return;
                }

                const checkedInIso = checkedInAt ? bangkokLocalToIso(checkedInAt) : new Date().toISOString();
                if (!checkedInIso) {
                    setError("Invalid check-in datetime.");
                    setLoading(false);
                    return;
                }
                const checkedInTime = extractHHmmFromLocalDateTime(checkedInAt)
                    ?? extractHHmmFromLocalDateTime(formatBangkokDateTimeLocal(new Date()))
                    ?? "00:00";
                const checkinPayload: any = {
                    checked_in_at: checkedInIso,
                    checkin_time: checkedInTime
                };
                if (pendingCheckinPayments.length > 0) {
                    checkinPayload.payments = pendingCheckinPayments;
                }
                if (policyFeePayload?.waived) {
                    checkinPayload.early_checkin_fee_waived = true;
                } else if (policyFeePayload) {
                    checkinPayload.policy_fee = policyFeePayload;
                }
                const res = await fetch(`/api/bookings/${reservationId}/checkin`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(checkinPayload)
                });
                const d = await res.json();
                if (!res.ok) {
                    if (Array.isArray(d?.missing_fields) && d.missing_fields.length > 0) {
                        setShowCheckinFieldValidation(true);
                    }
                    setError(d.error || "Check-in failed.");
                    setLoading(false);
                    return;
                }
                setPendingCheckinPayments([]);
                setShowCheckinFieldValidation(false);
                onSuccess();

                // L&F Alert
                if (syncedGuestProfileId) {
                    try {
                        const lfRes = await fetch(`/api/lost-found/check-guest?guest_profile_id=${syncedGuestProfileId}`);
                        if (lfRes.ok) {
                            const lfData = await lfRes.json();
                            if (lfData.alert) showPopup(lfData.alert);
                            else if (lfData.items) showPopup(lfData);
                        }
                    } catch(e) { console.error("L&F check failed", e); }
                }

            } else if (mode === "checkout" && reservationId) {
                const amt = fromSatang(toSatang(paymentAmount));
                if (!preCheckoutLoaded) {
                    setError("Checkout validation is still loading.");
                    setLoading(false);
                    return;
                }
                const effectivePreCheckoutBalance = preCheckoutBalance;
                if (toSatang(paymentAmount) < toSatang(effectivePreCheckoutBalance)) {
                    setShowCheckoutOutstandingPopup(true);
                    setError("");
                    setLoading(false);
                    return;
                }
                const checkoutPayload: any = {
                    payment_method: paymentMethod,
                    payment_amount: amt,
                    payment_note: paymentNote.trim() || undefined,
                    deposit_action: depositAction,
                    force_checkout: forceCheckout
                };
                if (policyFeePayload) {
                    checkoutPayload.policy_fee = policyFeePayload;
                }
                const res = await fetch(`/api/bookings/${reservationId}/checkout`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(checkoutPayload)
                });
                const d = await res.json();
                if (!res.ok) {
                    if (d.code === "OPEN_LOANS") {
                        setForceCheckout(true);
                        setError("Unreturned front-desk loan items detected. Return items first, or click Check-out again to force checkout.");
                    } else if (typeof d?.error === "string" && d.error.toLowerCase().includes("outstanding balance")) {
                        setShowCheckoutOutstandingPopup(true);
                        setError("");
                    } else {
                        setError(d.error || "Checkout failed.");
                    }
                    setLoading(false);
                    return;
                }
                onSuccess();
            }
        } catch {
            setError("Network error.");
            setLoading(false);
        }
    };

    const handleConfirmContinuousStayPlan = async (
        payloadOverride?: any,
        previewOverride?: ContinuousStayPreviewState
    ) => {
        const payload = payloadOverride ?? continuousStayPayload;
        const preview = previewOverride ?? continuousStayPreview;
        if (!payload || !preview) {
            setError("Continuous stay plan is no longer available. Please create again.");
            return;
        }

        setContinuousStayConfirming(true);
        setError("");
        setSuccessMessage("");
        try {
            const res = await fetch("/api/bookings/continuous-stay/commit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                setError(data?.error || "Failed to create continuous stay booking.");
                setContinuousStayConfirming(false);
                setLoading(false);
                return;
            }

            const created = data?.reservation ?? {};
            const plan = (data?.continuous_stay_plan ?? preview) as ContinuousStayPreviewState;
            const createdReservationId = String(created?.id || "");
            const createdTotal = Number(created?.continuous_stay_total_after_discount ?? plan?.totals?.total ?? created?.total_price);
            const roomPathLabel = formatContinuousStayRoomPath(plan?.segments);
            const firstSegment = plan?.segments?.[0] ?? null;
            const firstRoomTypeName =
                firstSegment?.room_type_name ||
                roomTypes.find((rt: any) => String(rt.id) === String(roomTypeId))?.name_en ||
                "Unspecified";
            const canContinueToCheckinAfterCreate = Boolean(
                onOpenCheckin &&
                source === "walkin" &&
                checkinDate === businessDate &&
                firstSegment?.room_id &&
                hasMainGuestIdentityImport &&
                canOfferContinueToCheckin(payload.guest_profile_id ?? null)
            );

            if (payload.guest_profile_id) {
                try {
                    const lfRes = await fetch(`/api/lost-found/check-guest?guest_profile_id=${payload.guest_profile_id}`);
                    if (lfRes.ok) {
                        const lfData = await lfRes.json();
                        if (lfData.alert) showPopup(lfData.alert);
                        else if (lfData.items) showPopup(lfData);
                    }
                } catch (e) {
                    console.error("L&F check failed", e);
                }
            }

            clearContinuousStayPlan();
            setContinuousStayConfirming(false);
            setLoading(false);
            setCreatedSummary({
                bookingCode: String(created?.booking_code || created?.id || "N/A"),
                guestName: String(created?.guest_name || payload.guest_name || "Guest"),
                source,
                roomTypeName: firstRoomTypeName,
                roomNumber: firstSegment?.room_number || created?.room_number || null,
                roomPathLabel,
                checkinDate,
                checkoutDate,
                nights,
                totalPrice: Number.isFinite(createdTotal) ? fromSatang(toSatang(createdTotal)) : plan.totals.total,
                createdReservationId: createdReservationId || null,
                canContinueToCheckin: Boolean(canContinueToCheckinAfterCreate && createdReservationId),
            });
        } catch (error) {
            console.error("Continuous stay commit failed", error);
            setError(error instanceof Error ? error.message : "Network error.");
            setContinuousStayConfirming(false);
            setLoading(false);
        }
    };

    const handleContinuousStayRoomChange = async (segment: ContinuousStayPreviewSegment, nextRoomId: string) => {
        if (!continuousStayPayload || !continuousStayPreview || nextRoomId === segment.room_id) return;
        const existingOverrides = Array.isArray(continuousStayPayload.room_overrides)
            ? continuousStayPayload.room_overrides
            : [];
        const nextOverrides = [
            ...existingOverrides.filter((item: any) =>
                !(String(item.start_date) < segment.end_date && String(item.end_date) > segment.start_date)
            ),
            {
                start_date: segment.start_date,
                end_date: segment.end_date,
                room_id: nextRoomId,
            },
        ];
        const nextPayload = {
            ...continuousStayPayload,
            room_overrides: nextOverrides,
        };

        setContinuousStayRefreshing(true);
        setError("");
        try {
            const previewRes = await fetch("/api/bookings/continuous-stay/preview", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(nextPayload),
            });
            const previewData = await previewRes.json().catch(() => null);
            if (!previewRes.ok || !previewData?.success) {
                setError(previewData?.error || "Selected room is not available for this segment.");
                setContinuousStayRefreshing(false);
                return;
            }
            setContinuousStayPayload(nextPayload);
            applyContinuousStayPreview(previewData as ContinuousStayPreviewState);
            setContinuousStayRefreshing(false);
        } catch (error) {
            console.error("Continuous stay room change failed", error);
            setError("Failed to refresh continuous stay plan.");
            setContinuousStayRefreshing(false);
        }
    };

    const guestNameParts = identityFirstName || identityLastName
        ? { firstName: identityFirstName, lastName: identityLastName }
        : splitGuestName(guestName);
    const normalizedNationalityCode = normalizeNationalityCode(profileNationalityCode);
    const isThaiNationality = normalizedNationalityCode === "THA";
    const thaiProvinceSuggestions = useMemo(
        () => (isThaiNationality ? suggestThaiProvinces(profileProvince, 2, 20) : []),
        [isThaiNationality, profileProvince]
    );
    const formattedNationality = formatNationality(normalizedNationalityCode);
    const normalizedCheckinIdentity = useMemo(
        () => sanitizeIdentityForSubmit(profileIdNumber.trim() || identityText.trim(), isProfileMasked),
        [profileIdNumber, identityText, isProfileMasked]
    );
    const checkinProfileCompleteness = useMemo(
        () =>
            checkProfileCompleteness({
                first_name: guestNameParts.firstName,
                last_name: guestNameParts.lastName,
                gender: profileGender,
                nationality_code: normalizedNationalityCode,
                id_type: profileIdType,
                id_number: sanitizeIdentityForSubmit(profileIdNumber, isProfileMasked),
                _masked: isProfileMasked,
                country: profileCountry,
                province: profileProvince,
                phone,
            }),
        [
            guestNameParts.firstName,
            guestNameParts.lastName,
            profileGender,
            normalizedNationalityCode,
            profileIdType,
            profileIdNumber,
            isProfileMasked,
            profileCountry,
            profileProvince,
            phone,
        ]
    );
    const canOfferContinueToCheckin = useCallback((profileIdOverride?: string | null) => {
        const effectiveProfileId = String(profileIdOverride || guestProfileId || "").trim();
        if (!effectiveProfileId) return false;
        if (!phone.trim()) return false;
        if (!checkinProfileCompleteness.is_complete) return false;

        if (normalizedNationalityCode === "THA") {
            if (profileIdType !== "thai_id") return false;
            if (!/^\d{13}$/.test(normalizedCheckinIdentity)) return false;
            if (!normalizeDobYmd(profileDob)) return false;
        } else if (profileIdType === "passport" && !normalizedCheckinIdentity) {
            return false;
        }

        return true;
    }, [
        guestProfileId,
        phone,
        checkinProfileCompleteness.is_complete,
        normalizedNationalityCode,
        profileIdType,
        normalizedCheckinIdentity,
        profileDob,
    ]);
    const checkinMissingFields = useMemo(() => {
        if (mode !== "checkin" || !showCheckinFieldValidation) return new Set<string>();
        return new Set(checkinProfileCompleteness.missing_fields);
    }, [mode, showCheckinFieldValidation, checkinProfileCompleteness.missing_fields]);
    const checkinFieldErrorClass = (field: string | string[]) => {
        const fields = Array.isArray(field) ? field : [field];
        const hasError = fields.some((item) => checkinMissingFields.has(item));
        return hasError ? "!border-rose-300 !bg-rose-100 dark:!bg-rose-500/10 dark:!border-rose-500/30 text-[var(--text-primary)] dark:!text-rose-200 placeholder:text-[var(--text-muted)]" : "";
    };

    /* ─── Loading state ─── */
    if (fetching) {
        return (
            <PmsModal title="Loading..." size="folio" onClose={onClose}>
                <div className="p-8 text-center text-[var(--text-muted)]">Loading reservation data...</div>
            </PmsModal>
        );
    }

    const nowForTimestamp = formatBangkokDateTimeLocal(new Date());
    const selectedRoomTypeName =
        roomTypes.find((rt: any) => String(rt.id) === String(roomTypeId))?.name_en || "Selected room type";
    const originalRoomTypeName =
        roomTypes.find((rt: any) => String(rt.id) === String(originalRoomTypeId))?.name_en || "Original room type";
    const showChargeRoomTypeChoice =
        mode === "checkin" &&
        Boolean(roomTypeId) &&
        Boolean(originalRoomTypeId) &&
        String(roomTypeId) !== String(originalRoomTypeId);
    const possibleReturnMatches = guestProfileId
        ? []
        : (liveGuestMatches.length > 0 ? liveGuestMatches : prefetchedPossibleReturnMatches)
            .filter((match) => match.profile.id !== guestProfileId);
    const possibleReturnSuggestion = possibleReturnMatches.find((match) => match.score >= 70) ?? possibleReturnMatches[0] ?? null;
    const autoSelectedPossibleReturn = possibleReturnMatches.length === 1 ? possibleReturnMatches[0] : null;
    const profileBookingNamesPreview = profileBookingNames.length <= 2
        ? profileBookingNames.join(", ")
        : `${profileBookingNames.slice(0, 2).join(", ")} +${profileBookingNames.length - 2}`;
    const displayedParty: ReservationGuestWithProfile[] = reservationParty.length > 0
        ? reservationParty
        : guestProfileId || guestName.trim()
            ? [{
                id: "draft-primary",
                reservation_id: reservationId || "",
                guest_profile_id: guestProfileId || "",
                role: "primary",
                display_order: 1,
                created_at: "",
                guest_profile: guestProfileId ? {
                    id: guestProfileId,
                    first_name: guestNameParts.firstName || "",
                    last_name: guestNameParts.lastName || "",
                    phone: phone || null,
                    nationality_code: profileNationalityCode || null,
                    country: profileCountry || null,
                    profile_status: (profileStatus as "draft" | "verified" | "merged" | "blacklisted") || null,
                } : null,
            }]
            : [];
    const accompanyingGuests = displayedParty.filter((member) => member.role === "accompanying");
    const partyCount = accompanyingGuests.length;
    const remainingPartySlots = Math.max(0, 4 - displayedParty.length);

    const MODE_LABEL: Record<BookingMode, string> = {
        create: "New Reservation",
        edit: "Edit Reservation",
        checkin: "Check-in",
        inhouse: "In-House View",
        checkout: "Check-out",
    };

    const submitLabel = loading
        ? "Processing..."
        : rateRefreshing
            ? "Updating rates..."
            : readonlyClosedReservation ? "Read Only"
                : dayUseAmountOnlyMode ? "Save & Extend"
                    : mode === "create" ? "Create Booking"
                        : mode === "edit" ? "Save Changes"
                            : mode === "checkin" ? "Confirm Check-in"
                                : mode === "checkout" ? `Confirm Check-out`
                                    : "Save";
    const roomChannelLocked = mode === "inhouse" || mode === "checkout";
    const showReassignButton = mode === "checkin" && Boolean(reservationId) && Boolean(roomTypeId);
    const checkinAssignedRoomCapsule = mode === "checkin"
        ? resolveCheckinAssignedRoomCapsule(checkinAssignedRoomStatus)
        : null;

    const closeCreatedSummary = () => {
        setCreatedSummary(null);
        onSuccess();
    };

    const continueCreatedSummaryToCheckin = () => {
        const nextReservationId = String(createdSummary?.createdReservationId || "").trim();
        if (!createdSummary?.canContinueToCheckin || !nextReservationId || !onOpenCheckin) {
            closeCreatedSummary();
            return;
        }
        setLoading(false);
        setError("");
        setSuccessMessage("");
        setSubmitIntentState("confirm");
        setShowCheckinFieldValidation(false);
        setCreatedSummary(null);
        onOpenCheckin(nextReservationId);
    };

    if (createdSummary) {
        return (
            <PmsModal
                title="Confirm Reservation"
                size="md"
                onClose={closeCreatedSummary}
                footer={
                    <div className="flex w-full justify-end gap-2">
                        <button type="button" className="btn btn-secondary" onClick={closeCreatedSummary}>
                            Done
                        </button>
                        {createdSummary.canContinueToCheckin && (
                            <button type="button" className="btn btn-primary" onClick={continueCreatedSummaryToCheckin}>
                                Continue to Check-in
                            </button>
                        )}
                    </div>
                }
            >
                <div className="space-y-3">
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:border-emerald-500/20 dark:bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-400">
                        Reservation created successfully.
                    </div>
                    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-3">
                        <div className="grid grid-cols-2 gap-2 text-sm">
                            <p className="text-[var(--text-muted)]">Booking Code</p>
                            <p className="font-semibold text-[var(--text-primary)] text-right">{createdSummary.bookingCode}</p>

                            <p className="text-[var(--text-muted)]">Guest</p>
                            <p className="font-semibold text-[var(--text-primary)] text-right">{createdSummary.guestName}</p>

                            <p className="text-[var(--text-muted)]">Stay</p>
                            <p className="font-semibold text-[var(--text-primary)] text-right">
                                {createdSummary.checkinDate} → {createdSummary.checkoutDate} ({createdSummary.nights} night{createdSummary.nights > 1 ? "s" : ""})
                            </p>

                            <p className="text-[var(--text-muted)]">Room Type</p>
                            <p className="font-semibold text-[var(--text-primary)] text-right">{createdSummary.roomTypeName}</p>

                            <p className="text-[var(--text-muted)]">Room</p>
                            <p className="font-semibold text-[var(--text-primary)] text-right">
                                {createdSummary.roomNumber ? `Room ${createdSummary.roomNumber}` : "Not assigned"}
                            </p>

                            {createdSummary.roomPathLabel && (
                                <>
                                    <p className="text-[var(--text-muted)]">Room Path</p>
                                    <p className="font-semibold text-[var(--text-primary)] text-right">{createdSummary.roomPathLabel}</p>
                                </>
                            )}

                            <p className="text-[var(--text-muted)]">Channel</p>
                            <p className="font-semibold text-[var(--text-primary)] text-right">
                                {BOOKING_SOURCE_LABEL[createdSummary.source] ?? createdSummary.source}
                            </p>

                            <p className="text-[var(--text-muted)]">Total</p>
                            <p className="font-semibold text-[var(--text-primary)] text-right">฿ {formatMoney(createdSummary.totalPrice)}</p>
                        </div>
                    </div>
                </div>
            </PmsModal>
        );
    }

    return (
        <>
            <PmsModal
                title={MODE_LABEL[mode]}
                size="folio"
                onClose={onClose}
                footer={
                    <div className="flex w-full justify-between items-center gap-2">
                        <div className="flex items-center gap-2">
                            <span className={`text-xs font-bold uppercase tracking-widest px-2 py-1 rounded ${mode === "checkout" ? "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400"
                                : mode === "checkin" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
                                    : "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-400"
                                }`}>{mode}</span>
                            {readonlyClosedReservation && (
                                <span className="rounded bg-[var(--bg-muted)] px-2 py-1 text-xs font-bold uppercase tracking-widest text-[var(--text-secondary)]">
                                    {reservationStatus === "cancelled" ? "cancelled" : "checked out"}
                                </span>
                            )}
                            {mode === "create" && (
                                <button
                                    type="button"
                                    className={`btn btn-ghost btn-sm text-xs ${hasContinuousStayPlanDraft ? "text-amber-700 dark:text-amber-300" : ""}`}
                                    onClick={() => void handleStartManualRoomPlan()}
                                    disabled={interactionLocked || Boolean(manualPlanDisabledReason)}
                                    title={manualPlanDisabledReason || "Create a planned room move before saving this booking."}
                                >
                                    {continuousStayRefreshing
                                        ? "Planning..."
                                        : hasContinuousStayPlanDraft
                                            ? "Rebuild Plan"
                                            : "Plan Move"}
                                </button>
                            )}
                            {mode !== "create" && reservationId && (
                                <>
                                    {reservationStatus === "no_show" && (
                                        <button
                                            type="button"
                                            className="btn btn-secondary btn-sm text-amber-700 border-amber-200 hover:bg-amber-50 dark:text-amber-400 dark:border-amber-800 dark:hover:bg-amber-950/40"
                                            onClick={() => setShowReverseNoShowDialog(true)}
                                            disabled={reverseNoShowLoading}
                                        >
                                            {reverseNoShowLoading ? "Reversing..." : "Reverse No-Show"}
                                        </button>
                                    )}
                                    <button type="button" className="btn btn-ghost btn-sm text-xs" onClick={() => setShowOptions(true)}>
                                        Options
                                    </button>
                                    <button type="button" className="btn btn-ghost btn-sm text-xs" onClick={() => setShowLinkStayModal(true)}>
                                        Link Stay
                                    </button>
                                    {canShowPreArrivalPlanMoveAction && (
                                        <button
                                            type="button"
                                            className="btn btn-ghost btn-sm text-xs"
                                            onClick={() => setShowPreArrivalPlanMoveModal(true)}
                                            title="Schedule a room move before check-in."
                                        >
                                            Plan Move
                                        </button>
                                    )}
                                    <button type="button" className="btn btn-ghost btn-sm text-xs" onClick={() => setShowHistoryModal(true)}>
                                        History
                                    </button>
                                    <button type="button" className="btn btn-ghost btn-sm text-xs" onClick={() => setShowConfirmation(true)}>
                                        Print
                                    </button>
                                    <button type="button" className="btn btn-ghost btn-sm text-xs" onClick={() => setShowRegCard(true)}>
                                        Reg Card
                                    </button>
                                    <button type="button" className="btn btn-ghost btn-sm text-xs" onClick={() => setShowFolioModal(true)}>
                                        View Folio
                                    </button>
                                </>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={interactionLocked}>
                                Close
                            </button>
                            {mode === "checkin" && (
                                <button
                                    form="res-form"
                                    type="submit"
                                    data-checkin-intent="draft"
                                    className="btn btn-secondary"
                                    disabled={interactionLocked}
                                >
                                    Save Draft
                                </button>
                            )}
                            {!readonlyClosedReservation && (
                                <button
                                    form="res-form"
                                    type="submit"
                                    data-checkin-intent={mode === "checkin" ? "confirm" : undefined}
                                    className={`btn ${mode === "checkout" ? "btn-success" : "btn-primary"}`}
                                    disabled={checkoutSubmitDisabled}
                                >
                                    {submitLabel}
                                </button>
                            )}
                        </div>
                    </div>
                }
            >
                {error && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 mb-4">{error}</div>
                )}
                {successMessage && (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 mb-4">{successMessage}</div>
                )}
                {readonlyClosedReservation && (
                    <div className="mb-4 rounded-lg border border-[var(--border-default)] bg-[var(--bg-body)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                        This reservation is {reservationStatus === "cancelled" ? "cancelled" : "checked out"}. Details are available in read-only mode.
                    </div>
                )}
                {canEditCheckedOutReservation && (
                    <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
                        Checked-out reservation: guest/profile metadata can still be edited here. Stay dates and pricing remain locked. Use Audit Correction for those changes.
                    </div>
                )}
                {dayUseAmountOnlyMode && (
                    <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                        Day Use edit is locked to view-only. Only extension amount is editable in this screen.
                    </div>
                )}
                {(reservationAlertsLoading || reservationAlerts.length > 0) && (
                    <div className="mb-4 space-y-2">
                        {reservationAlertsLoading && reservationAlerts.length === 0 ? (
                            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-body)] px-3 py-2 text-sm text-[var(--text-muted)]">
                                Loading alerts...
                            </div>
                        ) : (
                            reservationAlerts.map((alert) => {
                                const severity = String(alert.severity ?? "info");
                                const tone =
                                    severity === "critical"
                                        ? "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
                                        : severity === "warning"
                                            ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                                            : "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300";
                                return (
                                    <div
                                        key={String(alert.id)}
                                        className={`rounded-xl border px-3 py-3 ${tone}`}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="space-y-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-sm">{alert.icon ?? "🔔"}</span>
                                                    <span className="text-xs font-bold uppercase tracking-wide">
                                                        {severity}
                                                    </span>
                                                </div>
                                                <p className="text-sm font-semibold">{alert.message}</p>
                                                {(alert.created_at || alert.created_by) && (
                                                    <p className="text-[11px] opacity-80">
                                                        {alert.created_by ? `By ${alert.created_by}` : "Alert"}
                                                        {alert.created_at ? ` • ${new Date(alert.created_at).toLocaleString("th-TH")}` : ""}
                                                    </p>
                                                )}
                                            </div>
                                            <button
                                                type="button"
                                                className="btn btn-ghost btn-sm text-xs"
                                                onClick={() => dismissReservationAlert(String(alert.id))}
                                            >
                                                Dismiss
                                            </button>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                )}

                {linkedStay && reservationId && (
                    <LinkedStayPanel
                        linkedStay={linkedStay}
                        currentReservationId={reservationId}
                        onSwitchTab={handleSwitchLinkedTab}
                        onUnlinked={() => onSuccess()}
                    />
                )}

                {mode === "create" && continuousStayPreview && (
                    <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                        <div className="flex items-start justify-between gap-4">
                            <div className="space-y-2">
                                <div>
                                    <p className="font-bold">
                                        {continuousStayPlanMode === "manual" ? "Manual room plan" : "Selected stay has an availability conflict."}
                                    </p>
                                    <p className="text-xs opacity-80">
                                        {continuousStayPlanMode === "manual"
                                            ? "Create this booking with scheduled room moves."
                                            : "Confirm this plan to keep one booking and schedule room moves automatically."}
                                    </p>
                                </div>
                                {continuousStayPreview.blocked_nights.length > 0 && (
                                    <div className="rounded-lg border border-amber-200 bg-white/60 px-3 py-2 text-xs dark:border-amber-500/20 dark:bg-black/10">
                                        {continuousStayPreview.blocked_nights.slice(0, 3).map((night) => (
                                            <div key={night.stay_date} className="flex flex-wrap items-center gap-1.5">
                                                <span className="font-semibold">{formatYmdAsDmy(night.stay_date)}</span>
                                                <span>
                                                    {night.requested_room_number
                                                        ? `Room ${night.requested_room_number}`
                                                        : night.requested_room_type_name}
                                                </span>
                                                <span>→</span>
                                                <span className="font-semibold">
                                                    Room {night.assigned_room_number} ({night.assigned_room_type_name})
                                                </span>
                                            </div>
                                        ))}
                                        {continuousStayPreview.blocked_nights.length > 3 && (
                                            <div className="mt-1 opacity-70">
                                                +{continuousStayPreview.blocked_nights.length - 3} more affected night(s)
                                            </div>
                                        )}
                                    </div>
                                )}
                                <div className="space-y-1">
                                    {continuousStayPreview.segments.map((segment) => (
                                        <div
                                            key={`${segment.room_id}-${segment.start_date}-${segment.end_date}`}
                                            className="grid gap-2 rounded-lg bg-white/70 px-3 py-2 text-xs dark:bg-black/10 sm:grid-cols-[1fr_auto_auto]"
                                        >
                                            <div>
                                                <div className="font-semibold">{formatContinuousStaySegmentRange(segment)}</div>
                                                <div className="opacity-75">{segment.room_type_name}</div>
                                            </div>
                                            <select
                                                className="form-select h-8 min-w-[180px] bg-white text-xs dark:bg-[var(--bg-surface)]"
                                                value={segment.room_id}
                                                onChange={(event) => handleContinuousStayRoomChange(segment, event.target.value)}
                                                disabled={continuousStayRefreshing || continuousStayConfirming}
                                            >
                                                {(segment.available_rooms && segment.available_rooms.length > 0
                                                    ? segment.available_rooms
                                                    : [{
                                                        room_id: segment.room_id,
                                                        room_number: segment.room_number,
                                                        room_type_id: segment.room_type_id,
                                                        room_type_name: segment.room_type_name,
                                                        nightly_rates: segment.nightly_rates,
                                                        subtotal: segment.subtotal,
                                                    }]
                                                ).map((option) => (
                                                    <option key={option.room_id} value={option.room_id}>
                                                        Room {option.room_number} · {option.room_type_name} · ฿ {formatMoney(option.subtotal)}
                                                    </option>
                                                ))}
                                            </select>
                                            <span className="self-center font-semibold">฿ {formatMoney(segment.subtotal)}</span>
                                        </div>
                                    ))}
                                </div>
                                {continuousStayRefreshing && (
                                    <div className="text-xs font-semibold opacity-75">Refreshing room plan...</div>
                                )}
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                                    <span>Subtotal: ฿ {formatMoney(continuousStayPreview.totals.subtotal)}</span>
                                    {continuousStayPreview.totals.discount_amount > 0 && (
                                        <span>Discount: -฿ {formatMoney(continuousStayPreview.totals.discount_amount)}</span>
                                    )}
                                    <span className="font-bold">Total: ฿ {formatMoney(continuousStayPreview.totals.total)}</span>
                                </div>
                            </div>
                            <div className="flex shrink-0 flex-col gap-2">
                                <button
                                    form="res-form"
                                    type="submit"
                                    className="btn btn-primary btn-sm"
                                    disabled={continuousStayConfirming}
                                >
                                    {continuousStayConfirming ? "Creating..." : "Create With Plan"}
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => {
                                        clearContinuousStayPlan();
                                        void refreshNightlyRates(checkinDate, checkoutDate);
                                    }}
                                    disabled={continuousStayConfirming}
                                >
                                    Cancel Plan
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                <form id="res-form" ref={formRef} onSubmit={handleSubmit}>
                    <div className="relative">
                        {lockMessage && (
                            <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl bg-[var(--bg-muted)]/40 backdrop-blur-[1px]">
                                <div className="rounded-lg border border-[var(--border-input)] bg-[var(--bg-surface)] px-3 py-2 text-xs font-semibold text-[var(--text-secondary)] shadow-sm">
                                    {lockMessage}
                                </div>
                            </div>
                        )}
                        <fieldset disabled={interactionLocked}>
                            {/* ── TWO-COLUMN LAYOUT ── */}
                            <div className="grid grid-cols-[54fr_46fr] gap-6">

                                {/* ═══ LEFT COLUMN ═══ */}
                                <div className="space-y-4">

                                    {/* Header Badge */}
                                    {reservationId && (
                                    <div className="bg-[var(--bg-body)] border border-[var(--border-default)] rounded-lg px-3 py-2 flex justify-between items-center text-sm">
                                            <div className="flex items-stretch gap-2">
                                                <span className="font-bold text-[var(--text-primary)]">{guestName || "—"}</span>
                                                <span className="text-[var(--text-muted)] font-mono text-xs">#{reservationId.slice(0, 8).toUpperCase()}</span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                {rooms.find(r => r.id === roomId) && (
                                                    <span className="font-bold text-indigo-700 dark:text-indigo-400 text-xs bg-indigo-50 dark:bg-indigo-950/40 px-2 py-0.5 rounded">
                                                        Room {rooms.find(r => r.id === roomId)?.room_number}
                                                    </span>
                                                )}
                                                {checkinAssignedRoomCapsule && (
                                                    <span
                                                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${checkinAssignedRoomCapsule.className}`}
                                                        title={checkinAssignedRoomCapsule.title}
                                                    >
                                                        {checkinAssignedRoomCapsule.label}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Night Counter */}
                                    <NightCounter
                                        checkinDate={checkinDate}
                                        checkoutDate={checkoutDate}
                                        nights={nights}
                                        onChange={handleDatesChange}
                                        disabled={lockStayFields}
                                        lockCheckin={lockCheckinDate}
                                    />

                                    {/* Room / Channel Row */}
                                    <div className={`grid ${source === "ota" ? "grid-cols-[2.1fr_2.0fr_1fr_1fr]" : "grid-cols-[2.1fr_2.0fr_1fr]"} gap-3`}>
                                        <div>
                                            <label className="form-label">Room Type *</label>
                                            <select
                                                className="form-select h-[35px] text-sm"
                                                value={roomTypeId}
                                                onChange={async (e) => {
                                                    const nextRoomTypeId = e.target.value;
                                                    if (mode === "create" && continuousStayPreview) clearContinuousStayPlan();
                                                    setRoomTypeId(nextRoomTypeId);
                                                    setRoomId("");
                                                    if (!nextRoomTypeId) {
                                                        setNightlyRates([]);
                                                        return;
                                                    }
                                                    const nextChargeRoomTypeId =
                                                        mode === "checkin" && !useSelectedRoomTypeForCharge && originalRoomTypeId
                                                            ? originalRoomTypeId
                                                            : nextRoomTypeId;
                                                    await refreshNightlyRates(checkinDate, checkoutDate, {
                                                        roomIdOverride: "",
                                                        chargeRoomTypeIdOverride: nextChargeRoomTypeId
                                                    });
                                                }}
                                                disabled={lockPricingFields || roomChannelLocked}
                                                required
                                            >
                                                <option value="">Select</option>
                                                {roomTypes.map(rt => <option key={rt.id} value={rt.id}>{rt.name_en}</option>)}
                                            </select>
                                            {showChargeRoomTypeChoice && (
                                                <div className="mt-2 rounded-lg border border-indigo-200 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950/40 px-2.5 py-2 space-y-1.5">
                                                    <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-400">
                                                        Room Type to Charge
                                                    </p>
                                                    <label className="flex items-start gap-2 text-xs text-indigo-900 dark:text-indigo-300">
                                                        <input
                                                            type="radio"
                                                            name="charge-room-type-mode"
                                                            className="mt-0.5"
                                                            checked={useSelectedRoomTypeForCharge}
                                                            onChange={() => void handleChargeModeChange(true)}
                                                            disabled={lockPricingFields}
                                                        />
                                                        <span>
                                                            Update charge to selected room type ({selectedRoomTypeName})
                                                        </span>
                                                    </label>
                                                    <label className="flex items-start gap-2 text-xs text-indigo-900">
                                                        <input
                                                            type="radio"
                                                            name="charge-room-type-mode"
                                                            className="mt-0.5"
                                                            checked={!useSelectedRoomTypeForCharge}
                                                            onChange={() => void handleChargeModeChange(false)}
                                                            disabled={lockPricingFields}
                                                        />
                                                        <span>
                                                            Keep original charge type ({originalRoomTypeName}) - complimentary upgrade
                                                        </span>
                                                    </label>
                                                </div>
                                            )}
                                        </div>
                                        <div>
                                            <label className="form-label">Room</label>
                                            <div className="flex items-center gap-2">
                                                <div className="min-w-0 flex-1">
                                                    <AvailableRoomSelect
                                                        roomTypeId={roomTypeId}
                                                        checkinDate={checkinDate}
                                                        checkoutDate={checkoutDate}
                                                        excludeReservationId={mode === "edit" || mode === "checkin" || mode === "inhouse" ? reservationId : undefined}
                                                        value={roomId}
                                                        selectClassName="h-[35px]"
                                                        onChange={async (id) => {
                                                            if (mode === "create" && continuousStayPreview) clearContinuousStayPlan();
                                                            setRoomId(id);
                                                            await refreshNightlyRates(checkinDate, checkoutDate, {
                                                                roomIdOverride: id || ""
                                                            });
                                                        }}
                                                        disabled={isReadonly || roomChannelLocked || !roomTypeId}
                                                    />
                                                </div>
                                                {showReassignButton && (
                                                    <button
                                                        type="button"
                                                        className="inline-flex h-[35px] shrink-0 items-center justify-center rounded-lg border border-[var(--border-input)] bg-[var(--bg-surface)] px-2 text-[11px] font-semibold leading-none text-[var(--text-secondary)] transition hover:bg-[var(--bg-surface-hover)]"
                                                        onClick={() => setShowAssignRoomModal(true)}
                                                    >
                                                        Re-Assign
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        <div>
                                            <label className="form-label">Channel</label>
                                            <select
                                                className="form-select h-[35px] text-sm"
                                                value={source}
                                                onChange={async (e) => {
                                                    const nextSource = e.target.value;
                                                    const switchedToOta = source !== "ota" && nextSource === "ota";
                                                    if (mode === "create" && continuousStayPreview) clearContinuousStayPlan();
                                                    setSource(nextSource);

                                                    if (nextSource === "ota") {
                                                        setRatePlanId("");
                                                        if (mode === "create" && switchedToOta) {
                                                            window.alert("OTA selected. Please fill OTA nightly prices before saving.");
                                                        }
                                                    }

                                                    await refreshNightlyRates(checkinDate, checkoutDate, {
                                                        sourceOverride: nextSource,
                                                        ratePlanIdOverride: nextSource === "ota" ? "" : ratePlanId
                                                    });
                                                }}
                                                disabled={lockPricingFields || roomChannelLocked}
                                            >
                                                <option value="walkin">Walk-in</option>
                                                <option value="direct">Direct</option>
                                                <option value="ota">OTA</option>
                                                <option value="agent">Agent</option>
                                            </select>
                                        </div>
                                        {source === "ota" && (
                                            <div>
                                                <label className="form-label">OTA Ref</label>
                                                <input
                                                    type="text"
                                                    className="form-input text-sm"
                                                    value={otaRef}
                                                    onChange={(e) => setOtaRef(e.target.value)}
                                                    disabled={lockPricingFields || roomChannelLocked}
                                                    placeholder="Booking ref #"
                                                />
                                            </div>
                                        )}
                                    </div>

                                    {(assignedRoomLockActive || canManageAssignedRoomLock) && (
                                        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 dark:border-rose-500/30 dark:bg-rose-500/10">
                                            {/* Lane 1: Room, Message, Capsule, Button */}
                                            <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
                                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                                    <span className="text-sm font-bold text-rose-900 dark:text-rose-200 whitespace-nowrap">
                                                        Room {assignedRoomLockRoomNumber || roomNumber || "—"}
                                                    </span>
                                                    <span className="text-xs text-rose-800 dark:text-rose-300">
                                                        {assignedRoomLockActive
                                                            ? assignedRoomLockReason || "No reason provided."
                                                            : "Lock before check-in"}
                                                    </span>
                                                    <div className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/20 dark:text-rose-400">
                                                        <span>🔒</span>
                                                        <span>Do Not Move</span>
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-2">
                                                    {!assignedRoomLockActive && canManageAssignedRoomLock && (
                                                        <button
                                                            type="button"
                                                            className="btn btn-secondary text-rose-700 hover:bg-rose-100 text-[10px] px-2 py-1 h-auto min-h-0"
                                                            onClick={() => void handleLockAssignedRoom()}
                                                            disabled={assignedRoomLockLoading || !assignedRoomLockDraftReason.trim()}
                                                        >
                                                            {assignedRoomLockLoading ? "…" : "🔒 Lock Room"}
                                                        </button>
                                                    )}
                                                    {assignedRoomLockActive && (
                                                        <button
                                                            type="button"
                                                            className="btn btn-secondary text-[10px] px-2 py-1 h-auto min-h-0"
                                                            onClick={() => void handleUnlockAssignedRoom()}
                                                            disabled={assignedRoomLockLoading}
                                                        >
                                                            {assignedRoomLockLoading ? "…" : "Unlock"}
                                                        </button>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Lane 2: Single-line Note Input */}
                                            {!assignedRoomLockActive && canManageAssignedRoomLock && (
                                                <div className="flex items-center gap-2">
                                                    <input
                                                        type="text"
                                                        className="form-input text-xs h-8 bg-[var(--bg-surface)] py-1"
                                                        value={assignedRoomLockDraftReason}
                                                        onChange={(e) => setAssignedRoomLockDraftReason(e.target.value)}
                                                        placeholder="Why must this reservation stay in this room?"
                                                        disabled={assignedRoomLockLoading}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    <div className="space-y-3">
                                        <CollapsibleSection
                                            id="guest-info"
                                            title="Guest Info"
                                            icon="🏷️"
                                            forceOpen
                                                badge={
                                                guestProfileId ? (
                                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400">
                                                        Linked Profile
                                                    </span>
                                                ) : possibleReturnSuggestion ? (
                                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400">
                                                        PR
                                                    </span>
                                                ) : null
                                            }
                                        >
                                            <div className="space-y-3">
                                                <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-[minmax(0,1.9fr)_152px_185px] xl:items-end">
                                                    <div className="relative">
                                                        <label className="form-label mb-1">Guest Name *</label>
                                                        <input
                                                            type="text"
                                                            className={`form-input text-[15px] font-medium ${checkinFieldErrorClass(["first_name", "last_name"])}`}
                                                            value={guestName}
                                                            onChange={(e) => setGuestName(cleanFloatingThaiMarks(e.target.value))}
                                                            onFocus={() => setGuestMatchEnabled(true)}
                                                            disabled={isReadonly}
                                                            required
                                                            placeholder="Guest Name *"
                                                        />
                                                        {!isReadonly && (
                                                            <GuestMatchDropdown
                                                                guestName={guestName}
                                                                enabled={guestMatchEnabled}
                                                                className="xl:w-[calc(100%+240px)] xl:max-w-[760px]"
                                                                onSelect={(match) => { void handleSelectMatchedProfile(match); }}
                                                                onCreate={() => {
                                                                    setGuestProfileId(null);
                                                                    resetProfileDraft();
                                                                    setDocumentProfileHint("");
                                                                    setLiveGuestMatches([]);
                                                                    setPrefetchedPossibleReturnMatches([]);
                                                                    setShowManualGuestSearch(false);
                                                                    setManualGuestSearchQ("");
                                                                    setManualGuestResults([]);
                                                                }}
                                                                onMatchResults={setLiveGuestMatches}
                                                            />
                                                        )}
                                                    </div>

                                                    <div className="pt-[4px] xl:pb-0">
                                                        <div className="form-label mb-1">
                                                            Accompanying Guest
                                                        </div>
                                                        <div className="flex h-[38px] items-stretch overflow-hidden rounded-lg border border-[var(--border-input)] bg-[var(--bg-surface)] shadow-sm">
                                                            <button
                                                                type="button"
                                                                className="flex w-9 items-center justify-center text-[17px] font-bold text-[var(--text-secondary)] transition hover:bg-[var(--bg-body)] disabled:cursor-not-allowed disabled:text-[var(--text-muted)]"
                                                                onClick={openNewPartyModal}
                                                                disabled={isReadonly || !reservationId}
                                                                aria-label="Add accompanying guest"
                                                            >
                                                                +
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="flex min-w-[66px] items-center justify-center border-x border-[var(--border-default)] px-2 text-[11px] font-bold tracking-wide text-[var(--text-secondary)] transition hover:bg-[var(--bg-body)]"
                                                                onClick={() => setPartyModalOpen(true)}
                                                            >
                                                                {partyLoading ? "..." : `${partyCount} PAX`}
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="px-3 text-[11px] font-bold tracking-wide text-[var(--text-secondary)] transition hover:bg-[var(--bg-body)]"
                                                                onClick={() => setPartyModalOpen(true)}
                                                            >
                                                                EDIT
                                                            </button>
                                                        </div>
                                                    </div>

                                                    <div className="xl:max-w-[185px]">
                                                        <label className="form-label mb-1">Phone</label>
                                                        <input
                                                            type="text"
                                                            className={`form-input text-sm ${checkinFieldErrorClass("phone")}`}
                                                            value={phone}
                                                            onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
                                                            disabled={isReadonly}
                                                            placeholder="Phone"
                                                        />
                                                    </div>
                                                </div>

                                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                                    {!isReadonly && (
                                                        <button
                                                            type="button"
                                                            className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--text-secondary)] transition hover:bg-[var(--bg-body)]"
                                                            onClick={() => setShowManualGuestSearch((value) => !value)}
                                                        >
                                                            <span>{showManualGuestSearch ? "Hide Search" : "Search Profile"}</span>
                                                        </button>
                                                    )}
                                                    {profileLinking && (
                                                        <span className="rounded px-2 py-0.5 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-400 font-semibold">
                                                            Linking profile...
                                                        </span>
                                                    )}
                                                    {!isReadonly && (
                                                        <button
                                                            type="button"
                                                            className="btn btn-ghost btn-sm"
                                                            onClick={() => window.open("/pms/guests/duplicates", "_blank", "noopener,noreferrer")}
                                                        >
                                                            Merge Profiles
                                                        </button>
                                                    )}
                                                    {guestProfileId && (
                                                        <>
                                                            <span className="rounded px-2 py-0.5 bg-[var(--bg-surface-hover)] text-[var(--text-secondary)] font-semibold">
                                                                ID: {guestProfileId.slice(0, 8)}
                                                            </span>
                                                            {profileStatus && (
                                                                <span className="rounded px-2 py-0.5 bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-400 font-semibold">
                                                                    {profileStatus}
                                                                </span>
                                                            )}
                                                            <button
                                                                type="button"
                                                                className="btn btn-ghost btn-sm text-red-500 hover:text-red-600 dark:text-rose-400 dark:hover:text-rose-300"
                                                                onClick={async () => {
                                                                    if (!reservationId) {
                                                                    setGuestProfileId(null);
                                                                    resetProfileDraft();
                                                                    setDocumentProfileHint("");
                                                                    setPrefetchedPossibleReturnMatches([]);
                                                                    setReservationParty([]);
                                                                    return;
                                                                }
                                                                    const res = await fetch(`/api/bookings/${reservationId}/guest-profile`, { method: "DELETE" });
                                                                    const data = await res.json().catch(() => null);
                                                                    if (!res.ok || !data?.success) {
                                                                        setError(data?.error || "Failed to unlink profile.");
                                                                        return;
                                                                    }
                                                                    setGuestProfileId(null);
                                                                    resetProfileDraft();
                                                                    setDocumentProfileHint("");
                                                                    setPrefetchedPossibleReturnMatches([]);
                                                                    await loadReservationParty();
                                                                }}
                                                            >
                                                                Unlink
                                                            </button>
                                                        </>
                                                    )}
                                                    {!guestProfileId && possibleReturnSuggestion && (
                                                        <span className="rounded px-2 py-0.5 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400">
                                                            PR please check
                                                            {autoSelectedPossibleReturn
                                                                ? ` • auto-selected ${autoSelectedPossibleReturn.profile.first_name || ""} ${autoSelectedPossibleReturn.profile.last_name || ""}`.trim()
                                                                : ""}
                                                        </span>
                                                    )}
                                                </div>

                                                {guestProfileId && profileBookingNames.length > 0 && (
                                                    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-body)] px-3 py-2">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                                                                Booking Name
                                                            </span>
                                                            {profileBookingNames.map((bookingName) => (
                                                                <span
                                                                    key={bookingName}
                                                                    className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                                                                >
                                                                    {bookingName}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}

                                                {accompanyingGuests.length > 0 && (
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        {accompanyingGuests.map((member) => {
                                                            const memberName = member.guest_profile
                                                                ? [member.guest_profile.first_name, member.guest_profile.last_name].filter(Boolean).join(" ")
                                                                : `Accompany #${member.display_order - 1}`;
                                                            return (
                                                                <button
                                                                    key={`${member.id}-${member.guest_profile_id || member.display_order}`}
                                                                    type="button"
                                                                    className="rounded-full border border-[var(--border-default)] bg-[var(--bg-body)] px-3 py-1 text-xs font-semibold text-[var(--text-secondary)] transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/40 dark:hover:text-indigo-400"
                                                                    onClick={() => { void openPartyMemberModal(member); }}
                                                                >
                                                                    {memberName || "Guest"}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                )}

                                                {showManualGuestSearch && !isReadonly && (
                                                    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-2 shadow-sm">
                                                        <input
                                                            type="text"
                                                            className="form-input text-sm"
                                                            value={manualGuestSearchQ}
                                                            onChange={(e) => setManualGuestSearchQ(e.target.value)}
                                                            placeholder="Search by name / phone / member no"
                                                        />
                                                        <div className="mt-2 max-h-40 overflow-y-auto rounded border border-[var(--border-subtle)]">
                                                            {manualGuestSearching && (
                                                                <div className="px-2 py-2 text-xs text-[var(--text-muted)]">Searching...</div>
                                                            )}
                                                            {!manualGuestSearching && manualGuestSearchQ.trim().length < 2 && (
                                                                <div className="px-2 py-2 text-xs text-[var(--text-muted)]">Type at least 2 characters.</div>
                                                            )}
                                                            {!manualGuestSearching && manualGuestSearchQ.trim().length >= 2 && manualGuestResults.length === 0 && (
                                                                <div className="px-2 py-2 text-xs text-[var(--text-muted)]">No profile found.</div>
                                                            )}
                                                            {!manualGuestSearching && manualGuestResults.map((profile: any) => (
                                                                <button
                                                                    key={profile.id}
                                                                    type="button"
                                                                    className="w-full border-b border-[var(--border-subtle)] px-2 py-2 text-left text-xs hover:bg-indigo-50 dark:hover:bg-indigo-950/40 last:border-b-0"
                                                                    onClick={() => {
                                                                        void selectProfileById(String(profile.id), {
                                                                            first_name: profile.first_name,
                                                                            last_name: profile.last_name,
                                                                            phone: profile.phone
                                                                        });
                                                                    }}
                                                                >
                                                                    <div className="font-semibold text-[var(--text-primary)]">
                                                                        {[profile.first_name, profile.last_name].filter(Boolean).join(" ") || "—"}
                                                                    </div>
                                                                    <div className="text-[var(--text-muted)]">
                                                                        {profile.phone || "—"} {profile.member_no ? `• ${profile.member_no}` : ""}
                                                                    </div>
                                                                </button>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}

                                            </div>
                                        </CollapsibleSection>

                                        <CollapsibleSection
                                            id="guest-identity"
                                            title="Identity"
                                            icon="🪪"
                                            defaultOpen={mode === "checkin" || mode === "inhouse" || showCreateWalkInIdentityImport}
                                        >
                                            <div className="space-y-3">
                                                {(mode === "checkin" || mode === "inhouse" || showCreateWalkInIdentityImport) && (
                                                    <div className="flex items-center justify-between rounded-lg border border-indigo-200 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950/40 px-3 py-2">
                                                        <div>
                                                            <p className="text-xs font-semibold text-indigo-800 dark:text-indigo-300">
                                                                Thai ID / Passport OCR
                                                            </p>
                                                            <p className="text-[11px] text-indigo-700 dark:text-indigo-400">
                                                                {showCreateWalkInIdentityImport
                                                                    ? "Walk-in today: scan ID first, then create booking and continue to check-in."
                                                                    : "Please check again before filling the check-in form."}
                                                            </p>
                                                        </div>
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <button
                                                                type="button"
                                                                className="btn btn-secondary btn-sm"
                                                                onClick={() => openThaiCardReader("main")}
                                                                disabled={isReadonly}
                                                            >
                                                                Read Thai ID
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="btn btn-secondary btn-sm"
                                                                onClick={() => openPassportOcr("main")}
                                                                disabled={isReadonly}
                                                            >
                                                                Passport OCR
                                                            </button>
                                                        </div>
                                                    </div>
                                                )}
                                                <div className="grid grid-cols-1 gap-3 md:grid-cols-[1.4fr_1.4fr_0.6fr_0.6fr]">
                                                    <div>
                                                        <label className="form-label">First Name</label>
                                                        <input
                                                            type="text"
                                                            className={`form-input h-10 text-sm ${checkinFieldErrorClass("first_name")}`}
                                                            value={guestNameParts.firstName}
                                                            onChange={(e) => applyIdentityNameParts(e.target.value, guestNameParts.lastName)}
                                                            disabled={isReadonly}
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="form-label">Last Name</label>
                                                        <input
                                                            type="text"
                                                            className={`form-input h-10 text-sm ${checkinFieldErrorClass("last_name")}`}
                                                            value={guestNameParts.lastName}
                                                            onChange={(e) => applyIdentityNameParts(guestNameParts.firstName, e.target.value)}
                                                            disabled={isReadonly}
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="form-label">Nationality</label>
                                                        <input
                                                            type="text"
                                                            list="nationality-code-list"
                                                            className={`form-input h-10 text-sm uppercase ${checkinFieldErrorClass("nationality_code")}`}
                                                            value={profileNationalityCode}
                                                            onChange={(e) => {
                                                                const nextCode = e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
                                                                setProfileNationalityCode(nextCode);
                                                            }}
                                                            disabled={isReadonly}
                                                            placeholder="Type code e.g. GBR"
                                                            maxLength={3}
                                                            autoComplete="off"
                                                        />
                                                        <datalist id="nationality-code-list">
                                                            {NATIONALITIES.map((entry) => (
                                                                <option key={entry.code} value={entry.code}>
                                                                    {entry.demonym}
                                                                </option>
                                                            ))}
                                                        </datalist>
                                                    </div>
                                                    <div>
                                                        <label className="form-label">Gender</label>
                                                        <select
                                                            className={`form-select h-10 text-sm ${checkinFieldErrorClass("gender")}`}
                                                            value={profileGender}
                                                            onChange={(e) => setProfileGender((e.target.value as "" | "M" | "F" | "Other"))}
                                                            disabled={isReadonly}
                                                        >
                                                            <option value="">Select</option>
                                                            <option value="M">Male</option>
                                                            <option value="F">Female</option>
                                                            <option value="Other">Other</option>
                                                        </select>
                                                    </div>
                                                </div>
                                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                                    <div>
                                                        <label className="form-label">ID Type</label>
                                                        <select
                                                            className={`form-select h-10 text-sm ${checkinFieldErrorClass("id_type")}`}
                                                            value={profileIdType}
                                                            onChange={(e) => {
                                                                const nextType = e.target.value as "" | "thai_id" | "passport" | "other";
                                                                setProfileIdType(nextType);
                                                                const normalized = normalizeIdentityNumberByType(profileIdNumber, nextType);
                                                                setProfileIdNumber(normalized);
                                                                setIdentityText(normalized);
                                                                setDocumentProfileHint("");
                                                            }}
                                                            disabled={isReadonly}
                                                        >
                                                            <option value="">Select</option>
                                                            <option value="thai_id">Thai ID</option>
                                                            <option value="passport">Passport</option>
                                                            <option value="other">Other</option>
                                                        </select>
                                                    </div>
                                                    <div>
                                                        <label className="form-label flex items-center gap-1">
                                                            ID Number
                                                            {isProfileMasked && (
                                                                <span className="cursor-help text-[var(--text-muted)] hover:text-[var(--text-primary)]" title="ข้อมูลนี้เฉพาะ Admin เท่านั้น">🔒</span>
                                                            )}
                                                        </label>
                                                        <input
                                                            type="text"
                                                            inputMode={profileIdType === "thai_id" ? "numeric" : undefined}
                                                            maxLength={profileIdType === "thai_id" ? 13 : undefined}
                                                            className={`form-input h-10 text-sm ${checkinFieldErrorClass("id_number")} ${profileIdType === "thai_id" && hasInvalidThaiId(profileIdNumber, isProfileMasked) ? "!border-rose-300 !bg-rose-100 dark:!bg-rose-500/10 dark:!border-rose-500/30 text-[var(--text-primary)] dark:!text-rose-200" : ""}`}
                                                            value={profileIdNumber}
                                                            onChange={(e) => {
                                                                const normalized = normalizeIdentityNumberByType(e.target.value, profileIdType);
                                                                setProfileIdNumber(normalized);
                                                                setIdentityText(normalized);
                                                                setDocumentProfileHint("");
                                                            }}
                                                            onBlur={() => {
                                                                if (isReadonly || isProfileMasked) return;
                                                                if (profileIdType !== "thai_id") return;
                                                                if (hasInvalidThaiId(profileIdNumber, false)) return;
                                                                void autoResolveMainGuestThaiId(profileIdNumber);
                                                            }}
                                                            disabled={isReadonly || isProfileMasked}
                                                            placeholder={isProfileMasked ? "ข้อมูลถูกซ่อน — Admin เท่านั้นที่แก้ไขได้" : (profileIdType === "thai_id" ? "Thai ID (13 digits)" : "ID / Passport Number")}
                                                        />
                                                        {profileIdType === "thai_id" && !isProfileMasked && (
                                                            <p className={`mt-1 text-[11px] ${hasInvalidThaiId(profileIdNumber, false) ? "text-rose-600" : "text-emerald-700"}`}>
                                                                Thai ID must be exactly 13 digits.
                                                            </p>
                                                        )}
                                                        {documentProfileHint && (
                                                            <p className="mt-1 text-[11px] text-sky-700 dark:text-sky-300">
                                                                {documentProfileHint}
                                                            </p>
                                                        )}
                                                    </div>
                                                    <div>
                                                        <label className="form-label">DOB</label>
                                                        <DateInput
                                                            className="h-10 text-sm"
                                                            value={profileDob}
                                                            onChange={setProfileDob}
                                                            disabled={isReadonly}
                                                        />
                                                    </div>
                                                </div>
                                                {(mode === "checkin" || mode === "inhouse") && (
                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                                        <div>
                                                            <label className="form-label text-amber-900">Check-in Time</label>
                                                            <input
                                                                type="datetime-local"
                                                                className="form-input h-10 text-sm bg-[var(--bg-surface)]"
                                                                value={checkedInAt || nowForTimestamp}
                                                                onChange={(e) => setCheckedInAt(e.target.value)}
                                                                disabled={isReadonly || !canEditCheckedInTimestamp}
                                                            />
                                                            {!canEditCheckedInTimestamp && (
                                                                <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                                                                    Check-in time is locked after this business date. Admin can still edit it.
                                                                </p>
                                                            )}
                                                        </div>
                                                        <div>
                                                            <label className="form-label">Nationality Display</label>
                                                            <input
                                                                type="text"
                                                                className="form-input h-10 text-sm bg-[var(--bg-body)]"
                                                                value={formattedNationality || "—"}
                                                                readOnly
                                                            />
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </CollapsibleSection>

                                        <CollapsibleSection id="guest-contact" title="Contact" icon="📍">
                                            <div className="space-y-3">
                                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                                    <div>
                                                        <label className="form-label">Phone</label>
                                                        <input
                                                            type="text"
                                                            className={`form-input text-sm ${checkinFieldErrorClass("phone")}`}
                                                            value={phone}
                                                            onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
                                                            disabled={isReadonly}
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="form-label">WhatsApp</label>
                                                        <input
                                                            type="text"
                                                            className="form-input text-sm"
                                                            value={profileWhatsapp}
                                                            onChange={(e) => setProfileWhatsapp(e.target.value)}
                                                            disabled={isReadonly}
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="form-label">LINE ID</label>
                                                        <input
                                                            type="text"
                                                            className="form-input text-sm"
                                                            value={profileLineId}
                                                            onChange={(e) => setProfileLineId(e.target.value)}
                                                            disabled={isReadonly}
                                                        />
                                                    </div>
                                                </div>
                                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                                    <div>
                                                        <label className="form-label">Email</label>
                                                        <input
                                                            type="email"
                                                            className="form-input text-sm"
                                                            value={profileEmail}
                                                            onChange={(e) => setProfileEmail(e.target.value)}
                                                            disabled={isReadonly}
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="form-label">Country</label>
                                                        <input
                                                            type="text"
                                                            className={`form-input text-sm ${checkinFieldErrorClass("country")}`}
                                                            value={profileCountry}
                                                            onChange={(e) => setProfileCountry(e.target.value)}
                                                            disabled={isReadonly}
                                                            placeholder="Country"
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="form-label">Province {isThaiNationality ? "*" : ""}</label>
                                                        <input
                                                            type="text"
                                                            className={`form-input text-sm ${checkinFieldErrorClass("province")}`}
                                                            value={profileProvince}
                                                            onChange={(e) => setProfileProvince(e.target.value)}
                                                            disabled={isReadonly}
                                                            list={isThaiNationality ? "thai-province-list" : undefined}
                                                            placeholder={isThaiNationality ? "จังหวัด (จำเป็นสำหรับสัญชาติไทย)" : "Province"}
                                                        />
                                                        {isThaiNationality ? (
                                                            <>
                                                                <datalist id="thai-province-list">
                                                                    {thaiProvinceSuggestions.map((province) => (
                                                                        <option key={province} value={province} />
                                                                    ))}
                                                                </datalist>
                                                                {profileProvince.trim().length > 0 && profileProvince.trim().length < 2 ? (
                                                                    <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                                                                        พิมพ์อย่างน้อย 2 ตัวอักษรเพื่อค้นหาจังหวัด
                                                                    </p>
                                                                ) : null}
                                                            </>
                                                        ) : null}
                                                    </div>
                                                </div>
                                                <div>
                                                    <label className="form-label">Address</label>
                                                    <input
                                                        type="text"
                                                        className="form-input text-sm"
                                                        value={profileAddress}
                                                        onChange={(e) => setProfileAddress(e.target.value)}
                                                        disabled={isReadonly}
                                                        placeholder="Address"
                                                    />
                                                </div>
                                            </div>
                                        </CollapsibleSection>

                                        <CollapsibleSection id="guest-preferences" title="Preferences" icon="⭐">
                                            <div className="space-y-3">
                                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                                    <div>
                                                        <label className="form-label">VIP Tier</label>
                                                        <input
                                                            type="text"
                                                            className="form-input text-sm"
                                                            value={profileVipTier}
                                                            onChange={(e) => setProfileVipTier(e.target.value)}
                                                            disabled={isReadonly}
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="form-label">Profile Status</label>
                                                        <input
                                                            type="text"
                                                            className="form-input text-sm bg-[var(--bg-body)]"
                                                            value={profileStatus || "draft"}
                                                            readOnly
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="form-label">Last Stay</label>
                                                        <input
                                                            type="text"
                                                            className="form-input text-sm bg-[var(--bg-body)]"
                                                            value={profileLastStayDate || "—"}
                                                            readOnly
                                                        />
                                                    </div>
                                                </div>
                                                <div>
                                                    <label className="form-label">Preferences</label>
                                                    <textarea
                                                        className="form-input text-sm w-full"
                                                        rows={2}
                                                        value={profilePreferences}
                                                        onChange={(e) => setProfilePreferences(e.target.value)}
                                                        disabled={isReadonly}
                                                        placeholder="Preferences / requests"
                                                    />
                                                </div>
                                            </div>
                                        </CollapsibleSection>

                                        <CollapsibleSection id="guest-notes" title="Notes" icon="📝">
                                            <div className="space-y-3">
                                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                                    <div>
                                                        <label className="form-label">Reservation Notes</label>
                                                        <textarea
                                                            className="form-input text-sm w-full"
                                                            rows={2}
                                                            value={note}
                                                            onChange={e => setNote(e.target.value)}
                                                            disabled={isReadonly}
                                                            placeholder="Internal notes..."
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="form-label">Special Requests</label>
                                                        <textarea
                                                            className="form-input text-sm w-full"
                                                            rows={2}
                                                            value={specials}
                                                            onChange={e => setSpecials(e.target.value)}
                                                            disabled={isReadonly}
                                                            placeholder="Guest requests..."
                                                        />
                                                    </div>
                                                    {(mode === "create" || mode === "edit" || mode === "checkin" || mode === "inhouse") && (
                                                        <div>
                                                            <label className="form-label">Expected Arrival Time</label>
                                                            <input
                                                                type="time"
                                                                className="form-input h-10 text-sm"
                                                                value={expectedArrivalTime}
                                                                onChange={(e) => setExpectedArrivalTime(e.target.value)}
                                                                disabled={isReadonly}
                                                            />
                                                            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                                                                Before 14:00 creates auto alert.
                                                            </p>
                                                        </div>
                                                    )}
                                                </div>
                                                <div>
                                                    <label className="form-label">Profile Notes</label>
                                                    <textarea
                                                        className="form-input text-sm w-full"
                                                        rows={2}
                                                        value={profileNotes}
                                                        onChange={(e) => setProfileNotes(e.target.value)}
                                                        disabled={isReadonly}
                                                        placeholder="Profile notes..."
                                                    />
                                                </div>
                                                <label className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                                                    <input
                                                        type="checkbox"
                                                        checked={profileBlacklisted}
                                                        onChange={(e) => setProfileBlacklisted(e.target.checked)}
                                                        disabled={isReadonly}
                                                    />
                                                    Mark as blacklisted
                                                </label>
                                            </div>
                                        </CollapsibleSection>

                                        <CollapsibleSection id="guest-history" title="History" icon="📊">
                                            {guestProfileId ? (
                                                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-body)] px-3 py-2 text-sm">
                                                    <div className="space-y-0.5">
                                                        <p className="font-semibold text-[var(--text-primary)]">
                                                            Stays: {profileStayCount} {profileStayCount > 0 ? "(Return Guest)" : ""}
                                                        </p>
                                                        <p className="text-xs text-[var(--text-muted)]">
                                                            Profile: {guestProfileId} {profileLastStayDate ? `• Last stay ${profileLastStayDate}` : ""}
                                                        </p>
                                                        {profileBookingNames.length > 0 && (
                                                            <p className="text-xs text-[var(--text-muted)]">
                                                                Booking name{profileBookingNames.length > 1 ? "s" : ""}: {profileBookingNamesPreview}
                                                            </p>
                                                        )}
                                                    </div>
                                                    <a
                                                        href={`/pms/guests/${guestProfileId}`}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="btn btn-secondary btn-sm"
                                                    >
                                                        Open Full Profile
                                                    </a>
                                                </div>
                                            ) : possibleReturnMatches.length > 0 ? (
                                                <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-3 text-sm dark:border-emerald-900/60 dark:bg-emerald-950/20">
                                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                                        <div>
                                                            <p className="font-semibold text-emerald-800 dark:text-emerald-300">
                                                                Possible return
                                                            </p>
                                                            <p className="text-xs text-[var(--text-muted)]">
                                                                {autoSelectedPossibleReturn
                                                                    ? "1 strong candidate auto-selected. Please confirm before check-in."
                                                                    : `${possibleReturnMatches.length} possible matches found. Please confirm before check-in.`}
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div className="space-y-2">
                                                        {possibleReturnMatches.slice(0, 4).map((match) => {
                                                            const profileName = [match.profile.first_name, match.profile.last_name].filter(Boolean).join(" ").trim() || "Unknown";
                                                            const isAutoSelected = autoSelectedPossibleReturn?.profile.id === match.profile.id;
                                                            return (
                                                                <div
                                                                    key={match.profile.id}
                                                                    className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${isAutoSelected
                                                                        ? "border-emerald-300 bg-white/80 dark:border-emerald-700 dark:bg-emerald-950/20"
                                                                        : "border-[var(--border-default)] bg-[var(--bg-surface)]"
                                                                        }`}
                                                                >
                                                                    <div className="space-y-0.5">
                                                                        <p className="font-medium text-[var(--text-primary)]">
                                                                            {profileName}
                                                                            {isAutoSelected && (
                                                                                <span className="ml-2 rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                                                                                    AUTO
                                                                                </span>
                                                                            )}
                                                                        </p>
                                                                        <p className="text-xs text-[var(--text-muted)]">
                                                                            {match.profile.stay_count} stays
                                                                            {match.matched_booking_name ? ` • Booking name ${match.matched_booking_name}` : ""}
                                                                        </p>
                                                                    </div>
                                                                    {!isReadonly && (
                                                                        <button
                                                                            type="button"
                                                                            className="btn btn-secondary btn-sm"
                                                                            onClick={() => { void handleSelectMatchedProfile(match); }}
                                                                        >
                                                                            Link This Profile
                                                                        </button>
                                                                    )}
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            ) : (
                                                <p className="text-sm text-[var(--text-muted)]">Link profile to show guest history.</p>
                                            )}
                                        </CollapsibleSection>
                                    </div>

                                    {/* Checkout timestamp (readonly) */}
                                    {mode === "checkout" && checkedInAt && (
                                        <div className="flex items-center gap-3 bg-[var(--bg-body)] border border-[var(--border-default)] rounded-lg px-3 py-2 text-sm text-[var(--text-secondary)]">
                                            <span className="opacity-50">Checked in:</span>
                                            <span className="font-semibold">{new Date(checkedInAt).toLocaleString("th-TH")}</span>
                                        </div>
                                    )}

                                    {roomMoveHistory.length > 0 && (
                                        <div className="rounded-lg border border-indigo-200 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950/40 p-3">
                                            <p className="text-[11px] font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-400 mb-2">
                                                Room Move History
                                            </p>
                                            <div className="space-y-1.5">
                                                {roomMoveHistory.map((move, index) => (
                                                    <div
                                                        key={`${move.moved_at || move.move_date}-${index}`}
                                                        className="rounded-md border border-indigo-100 dark:border-indigo-800/50 bg-[var(--bg-surface)] px-2.5 py-1.5 text-xs text-indigo-900 dark:text-indigo-300"
                                                    >
                                                        <p className="font-semibold">
                                                            {move.move_date || "Unknown date"}: Room {move.from_room_number} {"->"} Room {move.to_room_number}
                                                        </p>
                                                        {move.reason && (
                                                            <p className="text-indigo-700 dark:text-indigo-400 mt-0.5">Reason: {move.reason}</p>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* ═══ RIGHT COLUMN ═══ */}
                                <div className="space-y-4">

                                    {/* Rate Plan */}
                                    {(mode === "create" || mode === "edit" || mode === "checkin" || mode === "inhouse") && source !== "ota" && (
                                        <>
                                            <RatePlanSelect
                                                value={ratePlanId}
                                                onChange={async (planId, _plan, meta) => {
                                                    if (mode === "create" && continuousStayPreview) clearContinuousStayPlan();
                                                    setRatePlanId(planId);
                                                    if (meta?.clearedIneligible) {
                                                        setRatePlanEligibilityWarning("Selected rate plan is not available for this guest. Please choose a new eligible rate.");
                                                    } else {
                                                        setRatePlanEligibilityWarning("");
                                                    }
                                                    await refreshNightlyRates(checkinDate, checkoutDate, {
                                                        ratePlanIdOverride: planId
                                                    });
                                                }}
                                                roomTypeId={chargeRoomTypeId}
                                                nights={nights}
                                                guestProfileId={guestProfileId || undefined}
                                                checkinDate={checkinDate}
                                                checkoutDate={checkoutDate}
                                                disabled={lockPricingFields}
                                            />
                                            {ratePlanEligibilityWarning && (
                                                <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                                                    {ratePlanEligibilityWarning}
                                                </div>
                                            )}
                                        </>
                                    )}
                                    {(mode === "create" || mode === "edit" || mode === "checkin" || mode === "inhouse") && source === "ota" && (
                                        <div className="rounded-lg border border-orange-200 bg-orange-50 dark:border-orange-800 dark:bg-orange-950/40 px-3 py-2">
                                            <p className="text-[11px] font-bold uppercase tracking-widest text-orange-700 dark:text-orange-400">Rate Plan</p>
                                            <p className="text-sm font-semibold text-orange-800 dark:text-orange-300">OTA Manual Price (per night)</p>
                                        </div>
                                    )}
                                    {mode !== "create" && mode !== "edit" && mode !== "checkin" && mode !== "inhouse" && (
                                        ratePlanId ? (
                                            <RatePlanSelect
                                                value={ratePlanId}
                                                onChange={() => { }}
                                                roomTypeId={roomTypeId}
                                                nights={nights}
                                                guestProfileId={guestProfileId || undefined}
                                                checkinDate={checkinDate}
                                                checkoutDate={checkoutDate}
                                                disabled
                                            />
                                        ) : (
                                            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-body)] px-3 py-2">
                                                <p className="text-[11px] font-bold uppercase tracking-widest text-[var(--text-muted)]">Rate Plan</p>
                                                <p className="text-sm font-semibold text-[var(--text-secondary)]">Rack / Rate Grid</p>
                                            </div>
                                        )
                                    )}

                                    {dayUseAmountOnlyMode && (
                                        <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40 p-3 space-y-2">
                                            <h4 className="text-xs font-bold uppercase tracking-widest text-emerald-800 dark:text-emerald-300">
                                                Day Use Extend
                                            </h4>
                                            <div>
                                                <label className="form-label text-emerald-900 dark:text-emerald-300">Extension Amount (THB)</label>
                                                <input
                                                    type="number"
                                                    min="0"
                                                    step="0.01"
                                                    className="form-input text-sm"
                                                    value={paymentAmount}
                                                    onChange={(e) => setPaymentAmount(e.target.value)}
                                                    disabled={interactionLocked || dayUseExtendSettingsLoading}
                                                />
                                            </div>
                                            <div>
                                                <label className="form-label text-emerald-900 dark:text-emerald-300">Payment Method</label>
                                                <select className="form-input text-sm" value={paymentMethod}
                                                    onChange={(e) => setPaymentMethod(e.target.value)}
                                                    disabled={interactionLocked || dayUseExtendSettingsLoading}>
                                                    <option value="cash">Cash</option>
                                                    <option value="transfer">Bank Transfer</option>
                                                    <option value="credit_card">Credit Card</option>
                                                </select>
                                            </div>
                                            <p className="text-[11px] text-emerald-700">
                                                Save will extend session by {dayUseExtendMinutes ?? 60} minutes.
                                            </p>
                                        </div>
                                    )}

                                    {/* Rate Summary */}
                                    <RateSummaryPanel
                                        nightlyRates={nightlyRates}
                                        nightDates={nightlyRates.map(r => r.date)}
                                        discountType={discountType}
                                        discountValue={discountValue}
                                        discountPercent={discountPercent}
                                        discountReason={discountReason}
                                        onDiscountChange={(type, value, reason) => {
                                            setDiscountType(type);
                                            setDiscountValue(value);
                                            setDiscountReason(reason);
                                        }}
                                        onNightlyRateChange={source === "ota" && !lockPricingFields ? handleOtaNightlyRateChange : undefined}
                                        editable={!lockPricingFields}
                                        source={source}
                                    />

                                    {/* Deposit (supports split methods) */}
                                    {mode !== "create" && reservationId && (
                                        <DepositPanel
                                            reservationId={reservationId}
                                            mode={mode}
                                            depositAmount={depositAmount}
                                            depositNote={depositGeneralNote}
                                            depositMethod={depositMethod}
                                            depositInputAmount={depositInputAmount}
                                            depositInputNote={depositInputNote}
                                            depositSaving={depositSaving}
                                            depositInlineError={depositInlineError}
                                            depositLines={depositLines}
                                            pendingDepositLines={mode === "checkin" ? pendingDepositPreviewLines : []}
                                            onDepositMethodChange={setDepositMethod}
                                            onDepositInputAmountChange={setDepositInputAmount}
                                            onDepositInputNoteChange={setDepositInputNote}
                                            onDepositNoteChange={setDepositGeneralNote}
                                            onAddDeposit={handleAddDeposit}
                                            onSaveDepositNote={handleSaveDepositNote}
                                            onClearDeposit={handleClearDeposit}
                                            onKeyDown={handleDepositEnter}
                                            canEditDeposit={canEditDeposit}
                                        />
                                    )}



                                    {/* ── CHECKOUT WARNINGS ── */}
                                    {mode === "checkout" && preCheckoutLoaded && checkoutWarnings.length > 0 && (
                                        <div className="space-y-2">
                                            {checkoutWarnings.map((w, i) => (
                                                <div
                                                    key={i}
                                                    className={`rounded-lg border px-3 py-2 text-sm ${w.severity === "error"
                                                        ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-400"
                                                        : w.severity === "warning"
                                                            ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400"
                                                            : "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-400"
                                                        }`}
                                                >
                                                    <span className="font-semibold mr-1">
                                                        {w.severity === "error" ? "⛔" : w.severity === "warning" ? "⚠️" : "ℹ️"}
                                                    </span>
                                                    {w.message}
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {/* ── BILLING & SETTLEMENT (Phase 26A) ── */}
                                    {mode !== "create" && (
                                        <div className="space-y-4">
                                            <BillingPanel
                                                reservationId={reservationId}
                                                guestName={guestName}
                                                totalPrice={mode === "checkout" || dayUseAmountOnlyMode || isCheckedOutReservation ? totalPrice : fromSatang(computedTotalSatang)}
                                                discountAmount={fromSatang(discountSatang)}
                                                discountReason={discountReason}
                                                depositNote={depositGeneralNote}
                                                depositSplitTargetAmount={depositSplitTargetAmount}
                                                mode={mode}
                                                policyFeePreview={
                                                    mode === "checkout"
                                                        && policyFeePayload
                                                        && (
                                                            policyFeePayload.payment_method === "cash"
                                                            || policyFeePayload.payment_method === "transfer"
                                                            || policyFeePayload.payment_method === "credit_card"
                                                        )
                                                        ? {
                                                            amount: Number(policyFeePayload.amount || 0),
                                                            payment_method: policyFeePayload.payment_method,
                                                            note: policyFeePayload.note,
                                                        }
                                                        : null
                                                }
                                                deferPersist={mode === "checkin" || mode === "inhouse"}
                                                pendingPayments={
                                                    mode === "checkin"
                                                        ? pendingCheckinPayments
                                                        : mode === "inhouse"
                                                            ? pendingInhousePayments
                                                            : []
                                                }
                                                onPendingPaymentsChange={
                                                    mode === "checkin"
                                                        ? (setPendingCheckinPayments as (payments: PendingPayment[]) => void)
                                                        : mode === "inhouse"
                                                            ? (setPendingInhousePayments as (payments: PendingPayment[]) => void)
                                                            : undefined
                                                }
                                                onTransferDepositSplitQueued={
                                                    mode === "checkin"
                                                        ? () => {
                                                            setDepositInputAmount("");
                                                            setDepositInputNote("");
                                                            setDepositInlineError("");
                                                        }
                                                        : undefined
                                                }
                                                onPaymentAdded={() => {
                                                    fetchPaymentsAndCharges();
                                                    if (mode === "checkout" && reservationId) {
                                                        void refreshPreCheckoutValidation({ resetPaymentAmount: true, openOutstandingPopup: false });
                                                    }
                                                }}
                                                onPostChargeClick={
                                                    mode === "inhouse" && !isReadonly
                                                        ? () => setPostChargeModalOpen(true)
                                                        : undefined
                                                }
                                                onCheckoutClick={
                                                    mode === "checkout" && !isReadonly
                                                        ? () => setSettlementDrawerOpen(true)
                                                        : undefined
                                                }
                                            />

                                            {/* Modals & Drawers */}
                                            {postChargeModalOpen && (
                                                <PostChargeModal
                                                    open={postChargeModalOpen}
                                                    onClose={() => setPostChargeModalOpen(false)}
                                                    reservationId={reservationId || ""}
                                                    onChargePosted={() => {
                                                        // Inform BillingPanel to refresh its data
                                                        window.dispatchEvent(new CustomEvent("billing-panel-refresh"));
                                                    }}
                                                />
                                            )}

                                            {settlementDrawerOpen && (
                                                <SettlementDrawer
                                                    open={settlementDrawerOpen}
                                                    onClose={() => setSettlementDrawerOpen(false)}
                                                    reservationId={reservationId || ""}
                                                    totalPrice={totalPrice || 0}
                                                    depositAmount={depositAmount || 0}
                                                    policyFeePayload={policyFeePayload}
                                                    billingData={{
                                                        roomTotalSatang: toSatang(totalPrice || 0),
                                                        extraChargesSatang: extraChargesTotalSatang,
                                                        totalChargesSatang: checkoutBalanceSatang + checkoutCreditsTotalSatang, // Approximation for drawer
                                                        totalCreditsSatang: checkoutCreditsTotalSatang,
                                                        outstandingSatang: checkoutBalanceSatang
                                                    }}
                                                    onCheckoutComplete={() => {
                                                        setSettlementDrawerOpen(false);
                                                        onSuccess();
                                                    }}
                                                />
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </fieldset>
                    </div>
                </form>
            </PmsModal>

            {partyModalOpen && (
                <PmsModal
                    title="Accompanying Guest"
                    size="xl"
                    onClose={() => {
                        setPartyModalOpen(false);
                        setPartyDraftError("");
                        setPartySearchQ("");
                        setPartySearchResults([]);
                    }}
                    footer={
                        <div className="flex w-full items-center justify-between gap-2">
                            <div>
                                {!isReadonly && partyDraft.linkedMemberId && partyDraft.guestProfileId && (
                                    <button
                                        type="button"
                                        className="btn btn-ghost text-rose-600"
                                        disabled={partySaving}
                                        onClick={() => { void handleRemovePartyDraft(); }}
                                    >
                                        Remove Guest
                                    </button>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => {
                                        setPartyModalOpen(false);
                                        setPartyDraftError("");
                                        setPartySearchQ("");
                                        setPartySearchResults([]);
                                    }}
                                >
                                    Close
                                </button>
                                {!isReadonly && (
                                    <button
                                        type="button"
                                        className="btn btn-primary"
                                        disabled={partySaving || (!partyDraft.linkedMemberId && !reservationId)}
                                        onClick={() => { void saveAccompanyingGuest(); }}
                                    >
                                        {partySaving ? "Saving..." : partyDraft.linkedMemberId ? "Save Guest" : "Add Guest"}
                                    </button>
                                )}
                            </div>
                        </div>
                    }
                >
                    <div className="space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--bg-body)] px-3 py-2">
                            <div>
                                <p className="text-sm font-semibold text-[var(--text-primary)]">Room party</p>
                                <p className="text-xs text-[var(--text-muted)]">Max 4 total guests per room. Primary guest always counts as 1.</p>
                            </div>
                            <span className="rounded-full bg-[var(--bg-surface)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text-secondary)] shadow-sm">
                                {partyCount} PAX • {remainingPartySlots} slots left
                            </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={openNewPartyModal}
                                disabled={isReadonly || !reservationId || remainingPartySlots === 0}
                            >
                                + New Accompany
                            </button>
                            {accompanyingGuests.map((member) => {
                                const memberName = member.guest_profile
                                    ? [member.guest_profile.first_name, member.guest_profile.last_name].filter(Boolean).join(" ")
                                    : `Accompany #${member.display_order - 1}`;
                                const isSelected =
                                    partyDraft.linkedMemberId === member.id ||
                                    (!!partyDraft.guestProfileId && String(partyDraft.guestProfileId) === String(member.guest_profile_id));
                                return (
                                    <button
                                        key={`party-modal-${member.id}`}
                                        type="button"
                                        className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${isSelected
                                            ? "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-400"
                                            : "border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--bg-body)]"
                                            }`}
                                        onClick={() => { void openPartyMemberModal(member); }}
                                    >
                                        {memberName || "Guest"}
                                    </button>
                                );
                            })}
                        </div>

                        {partyDraftError && (
                            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                                {partyDraftError}
                            </div>
                        )}

                        {!reservationId && (
                            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-body)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                                Save the reservation first, then add accompanying guests.
                            </div>
                        )}

                        <div className="grid gap-4 lg:grid-cols-[0.92fr_1.08fr]">
                            <div className="space-y-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-body)] p-3">
                                <div className="flex items-center justify-between gap-2">
                                    <p className="text-sm font-semibold text-[var(--text-primary)]">Search Existing Profile</p>
                                    <button
                                        type="button"
                                        className="btn btn-ghost btn-sm"
                                        onClick={resetPartyDraft}
                                        disabled={partySaving}
                                    >
                                        Manual
                                    </button>
                                </div>
                                <input
                                    type="text"
                                    className="form-input text-sm"
                                    value={partySearchQ}
                                    onChange={(e) => setPartySearchQ(e.target.value)}
                                    placeholder="Search name / phone / passport / ID"
                                    disabled={partySaving || !reservationId || remainingPartySlots === 0}
                                />
                                <div className="max-h-56 overflow-y-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)]">
                                    {partySearchLoading && (
                                        <div className="px-3 py-2 text-xs text-[var(--text-muted)]">Searching...</div>
                                    )}
                                    {!partySearchLoading && partySearchQ.trim().length < 2 && (
                                        <div className="px-3 py-2 text-xs text-[var(--text-muted)]">Type at least 2 characters.</div>
                                    )}
                                    {!partySearchLoading && partySearchQ.trim().length >= 2 && partySearchResults.length === 0 && (
                                        <div className="px-3 py-2 text-xs text-[var(--text-muted)]">No profile found.</div>
                                    )}
                                    {!partySearchLoading && partySearchResults.map((profile: any) => {
                                        const alreadyLinked = displayedParty.some((member) => String(member.guest_profile_id) === String(profile.id));
                                        const isMain = String(guestProfileId || "") === String(profile.id);
                                        return (
                                            <div
                                                key={`party-search-${profile.id}`}
                                                className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-3 py-2 last:border-b-0"
                                            >
                                                <div className="min-w-0">
                                                    <div className="truncate text-xs font-semibold text-[var(--text-primary)]">
                                                        {[profile.first_name, profile.last_name].filter(Boolean).join(" ") || "—"}
                                                    </div>
                                                    <div className="text-[11px] text-[var(--text-muted)]">
                                                        {profile.phone || "—"} {profile.member_no ? `• ${profile.member_no}` : ""}
                                                    </div>
                                                </div>
                                                <button
                                                    type="button"
                                                    className="rounded-lg border border-[var(--border-default)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text-secondary)] transition hover:bg-[var(--bg-body)] disabled:cursor-not-allowed disabled:text-[var(--text-muted)]"
                                                    disabled={partySaving || alreadyLinked || isMain}
                                                    onClick={() => { void selectPartySearchProfile(String(profile.id)); }}
                                                >
                                                    {isMain ? "Main" : alreadyLinked ? "Linked" : "Use"}
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="space-y-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div>
                                        <p className="text-sm font-semibold text-[var(--text-primary)]">
                                            {partyDraft.linkedMemberId ? "Edit accompanying guest" : "New accompanying guest"}
                                        </p>
                                        <p className="text-xs text-[var(--text-muted)]">
                                            OCR and Thai ID import fill this guest only.
                                        </p>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            className="btn btn-secondary btn-sm"
                                            onClick={() => openThaiCardReader("accompany")}
                                            disabled={isReadonly}
                                        >
                                            Read Thai ID
                                        </button>
                                        <button
                                            type="button"
                                            className="btn btn-secondary btn-sm"
                                            onClick={() => {
                                                const member = partyDraft.linkedMemberId
                                                    ? displayedParty.find((m) => m.id === partyDraft.linkedMemberId)
                                                    : null;
                                                // For a NEW guest this has to predict the slot the server will
                                                // assign — the first free one in [2,3,4], not the guest count.
                                                // Counting agreed with the server only while the slots happened
                                                // to be contiguous, so the button offered the previous guest's
                                                // passport again and the next passenger's scan was unreachable.
                                                const gi = passportOcrGuestIndex({
                                                    memberDisplayOrder: member ? (member.display_order ?? null) : null,
                                                    occupiedAccompanyingSlots: accompanyingGuests.map(
                                                        (m) => m.display_order ?? 0
                                                    ),
                                                });
                                                openPassportOcr("accompany", gi);
                                            }}
                                            disabled={isReadonly}
                                        >
                                            Passport OCR
                                        </button>
                                    </div>
                                </div>

                                {partyDraftLoading ? (
                                    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-body)] px-3 py-6 text-center text-sm text-[var(--text-muted)]">
                                        Loading guest profile...
                                    </div>
                                ) : (
                                    <>
                                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                            <div>
                                                <label className="form-label">First Name</label>
                                                <input
                                                    type="text"
                                                    className="form-input text-sm"
                                                    value={partyDraft.firstName}
                                                    onChange={(e) => setPartyDraft((current) => ({ ...current, firstName: e.target.value }))}
                                                    disabled={isReadonly}
                                                />
                                            </div>
                                            <div>
                                                <label className="form-label">Last Name</label>
                                                <input
                                                    type="text"
                                                    className="form-input text-sm"
                                                    value={partyDraft.lastName}
                                                    onChange={(e) => setPartyDraft((current) => ({ ...current, lastName: e.target.value }))}
                                                    disabled={isReadonly}
                                                />
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                            <div>
                                                <label className="form-label">Phone</label>
                                                <input
                                                    type="text"
                                                    className="form-input text-sm"
                                                    value={partyDraft.phone}
                                                    onChange={(e) => setPartyDraft((current) => ({ ...current, phone: formatPhoneInput(e.target.value) }))}
                                                    disabled={isReadonly}
                                                />
                                            </div>
                                            <div>
                                                <label className="form-label">Gender</label>
                                                <select
                                                    className="form-select text-sm"
                                                    value={partyDraft.gender}
                                                    onChange={(e) => setPartyDraft((current) => ({ ...current, gender: e.target.value as ProfileGenderValue }))}
                                                    disabled={isReadonly}
                                                >
                                                    <option value="">Select</option>
                                                    <option value="M">Male</option>
                                                    <option value="F">Female</option>
                                                    <option value="Other">Other</option>
                                                </select>
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-1 gap-3 md:grid-cols-[0.7fr_1fr_1.3fr]">
                                            <div>
                                                <label className="form-label">Nationality</label>
                                                <input
                                                    type="text"
                                                    list="party-nationality-code-list"
                                                    className="form-input text-sm uppercase"
                                                    value={partyDraft.nationalityCode}
                                                    onChange={(e) => {
                                                        const nextCode = e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
                                                        setPartyDraft((current) => ({
                                                            ...current,
                                                            nationalityCode: nextCode,
                                                            country: getCountryByCode(nextCode) || current.country,
                                                        }));
                                                    }}
                                                    disabled={isReadonly}
                                                    placeholder="GBR"
                                                    maxLength={3}
                                                />
                                                <datalist id="party-nationality-code-list">
                                                    {NATIONALITIES.map((entry) => (
                                                        <option key={`party-${entry.code}`} value={entry.code}>
                                                            {entry.demonym}
                                                        </option>
                                                    ))}
                                                </datalist>
                                            </div>
                                            <div>
                                                <label className="form-label">ID Type</label>
                                                <select
                                                    className="form-select text-sm"
                                                    value={partyDraft.idType}
                                                    onChange={(e) =>
                                                        setPartyDraft((current) => {
                                                            const nextType = e.target.value as ProfileIdTypeValue;
                                                            return {
                                                                ...current,
                                                                idType: nextType,
                                                                idNumber: normalizeIdentityNumberByType(current.idNumber, nextType),
                                                            };
                                                        })
                                                    }
                                                    disabled={isReadonly}
                                                >
                                                    <option value="">Select</option>
                                                    <option value="thai_id">Thai ID</option>
                                                    <option value="passport">Passport</option>
                                                    <option value="other">Other</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label className="form-label">ID Number</label>
                                                <input
                                                    type="text"
                                                    inputMode={partyDraft.idType === "thai_id" ? "numeric" : undefined}
                                                    maxLength={partyDraft.idType === "thai_id" ? 13 : undefined}
                                                    className={`form-input text-sm uppercase ${partyDraft.idType === "thai_id" && partyDraft.idNumber.trim().length > 0 && !/^\d{13}$/.test(partyDraft.idNumber.trim()) ? "!border-rose-300 !bg-rose-100 dark:!bg-rose-500/10 dark:!border-rose-500/30 text-[var(--text-primary)] dark:!text-rose-200" : ""}`}
                                                    value={partyDraft.idNumber}
                                                    onChange={(e) =>
                                                        setPartyDraft((current) => ({
                                                            ...current,
                                                            idNumber: normalizeIdentityNumberByType(e.target.value, current.idType),
                                                        }))
                                                    }
                                                    disabled={isReadonly}
                                                />
                                                {partyDraft.idType === "thai_id" && (
                                                    <p className={`mt-1 text-[11px] ${/^\d{13}$/.test(partyDraft.idNumber.trim()) ? "text-emerald-700" : "text-rose-600"}`}>
                                                        Thai ID must be exactly 13 digits.
                                                    </p>
                                                )}
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                            <div>
                                                <label className="form-label">DOB</label>
                                                <DateInput
                                                    className="text-sm"
                                                    value={partyDraft.dob}
                                                    onChange={(value) => setPartyDraft((current) => ({ ...current, dob: value }))}
                                                    disabled={isReadonly}
                                                />
                                            </div>
                                            <div>
                                                <label className="form-label">Status</label>
                                                <select
                                                    className="form-select text-sm"
                                                    value={partyDraft.profileStatus || "draft"}
                                                    onChange={(e) => setPartyDraft((current) => ({
                                                        ...current,
                                                        profileStatus: e.target.value as PartyDraft["profileStatus"],
                                                    }))}
                                                    disabled={isReadonly}
                                                >
                                                    <option value="draft">draft</option>
                                                    <option value="verified">verified</option>
                                                    <option value="blacklisted">blacklisted</option>
                                                </select>
                                            </div>
                                        </div>

                                        {partyDraft.guestProfileId && (
                                            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-body)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                                                Profile ID: <span className="font-semibold text-[var(--text-primary)]">{partyDraft.guestProfileId.slice(0, 8)}</span>
                                                {partyDraft.linkedMemberId ? " • already linked to this reservation" : " • ready to add"}
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                </PmsModal>
            )}

            <Dialog open={showCheckoutOutstandingPopup} onOpenChange={setShowCheckoutOutstandingPopup}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Outstanding Balance</DialogTitle>
                        <DialogDescription>
                            Full payment is required before checkout.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3 text-sm text-[var(--text-secondary)]">
                        <div className="rounded-lg border border-rose-200 bg-rose-50 dark:border-rose-800/30 dark:bg-rose-950/20 px-3 py-2">
                            <p>
                                Remaining balance: <span className="font-bold text-rose-700 dark:text-rose-400">฿{formatMoney(fromSatang(checkoutRemainingSatang))}</span>
                            </p>
                            <p className="mt-1 text-xs text-rose-700 dark:text-rose-500">
                                Enter the collected payment in the checkout payment panel first, then confirm checkout again.
                            </p>
                        </div>
                        {checkoutPaymentSatang > 0 && (
                            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-body)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                                Entered payment: ฿{formatMoney(fromSatang(checkoutPaymentSatang))} / Required: ฿{formatMoney(fromSatang(checkoutBalanceSatang))}
                            </div>
                        )}
                    </div>
                    <DialogFooter>
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => setShowCheckoutOutstandingPopup(false)}
                        >
                            OK
                        </button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={showReverseNoShowDialog} onOpenChange={setShowReverseNoShowDialog}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Reverse No-Show</DialogTitle>
                        <DialogDescription>
                            ลูกค้ามาถึงแล้ว ต้องการยกเลิก No-Show?
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3 text-sm text-[var(--text-secondary)]">
                        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300 px-3 py-2">
                            Reservation will return to active status. If no-show fee exists, the system will refund it automatically.
                        </div>
                        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-body)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                            If the original room is no longer available, room assignment will be cleared and FO will need to assign a new room before check-in.
                        </div>
                    </div>
                    <DialogFooter>
                        <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => setShowReverseNoShowDialog(false)}
                            disabled={reverseNoShowLoading}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={handleReverseNoShow}
                            disabled={reverseNoShowLoading}
                        >
                            {reverseNoShowLoading ? "Reversing..." : "Confirm Reverse"}
                        </button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <EarlyCheckinFeeModal
                isOpen={showEarlyCheckinModal}
                suggestedFee={suggestedPolicyFee}
                onClose={closePolicyModalOnly}
                onConfirm={continueWithPolicyDecision}
            />

            <LateCheckoutFeeModal
                isOpen={showLateCheckoutModal}
                isAfter1600={isAfter1600}
                suggestedFee={suggestedPolicyFee}
                skipFeeFormAfterWarning={hasPrepaidLateCheckout}
                onClose={closePolicyModalOnly}
                onExtendStay={() => {
                    closePolicyModalOnly();
                    setError("Please switch to In-house and extend stay before checkout.");
                }}
                onConfirm={continueWithPolicyDecision}
            />

            <ShortenFeeModal
                isOpen={showShortenModal}
                preview={shortenPreview}
                onClose={closePolicyModalOnly}
                onConfirm={continueWithPolicyDecision}
            />

            {/* Options Panel (Traces, Alerts, Loans) */}
            {showOptions && reservationId && (
                <ReservationOptionsPanel
                    reservationId={reservationId}
                    guestName={guestName}
                    checkinDate={checkinDate}
                    checkoutDate={checkoutDate}
                    layer="modal"
                    onClose={() => setShowOptions(false)}
                />
            )}

            {showLinkStayModal && reservationId && (
                <LinkStayModal
                    reservationId={reservationId}
                    guestName={guestName || "Guest"}
                    checkinDate={checkinDate}
                    checkoutDate={checkoutDate}
                    onClose={() => setShowLinkStayModal(false)}
                    onSuccess={() => {
                        setShowLinkStayModal(false);
                        setSuccessMessage("Reservations linked successfully.");
                        onSuccess();
                    }}
                />
            )}

            {/* Print: Confirmation Letter */}
            {showConfirmation && reservationId && (
                <ConfirmationLetter
                    reservationId={reservationId}
                    onClose={() => setShowConfirmation(false)}
                />
            )}

            {/* Print: Registration Card */}
            {showRegCard && reservationId && (
                <RegistrationCard
                    reservationId={reservationId}
                    onClose={() => setShowRegCard(false)}
                />
            )}

            {showFolioModal && reservationId && (
                <ReservationFolioModal
                    open={showFolioModal}
                    onClose={() => setShowFolioModal(false)}
                    reservationId={reservationId}
                    mode={mode}
                    isReadonly={lockPricingFields}
                    allowPaymentMethodEdit={dayUseAmountOnlyMode && !readonlyClosedReservation}
                    totalPrice={totalPrice || 0}
                    depositAmount={depositAmount || 0}
                    policyFeePayload={policyFeePayload}
                    billingData={{
                        roomTotalSatang: toSatang(totalPrice || 0),
                        extraChargesSatang: extraChargesTotalSatang,
                        totalChargesSatang: checkoutBalanceSatang + checkoutCreditsTotalSatang,
                        totalCreditsSatang: checkoutCreditsTotalSatang,
                        outstandingSatang: checkoutBalanceSatang,
                    }}
                    onInlineRefresh={() => {
                        fetchPaymentsAndCharges();
                        if (mode === "checkout" && reservationId) {
                            void refreshPreCheckoutValidation({ resetPaymentAmount: true, openOutstandingPopup: false });
                        }
                    }}
                    onCheckoutComplete={() => {
                        setShowFolioModal(false);
                        onSuccess();
                    }}
                    onSwitchTab={handleSwitchLinkedTab}
                />
            )}

            {showHistoryModal && reservationId && (
                <ReservationHistoryModal
                    reservationId={reservationId}
                    onClose={() => setShowHistoryModal(false)}
                />
            )}

            {showAssignRoomModal && (mode === "checkin" || mode === "inhouse") && reservationId && roomTypeId && (
                <AssignRoomModal
                    reservationId={reservationId}
                    roomTypeId={roomTypeId}
                    roomTypeName={
                        roomTypes.find((rt: any) => String(rt.id) === String(roomTypeId))?.name_en ||
                        "Selected Room Type"
                    }
                    guestName={guestName || "Guest"}
                    checkinDate={checkinDate}
                    checkoutDate={checkoutDate}
                    onAssigned={(nextRoomId) => {
                        setRoomId(nextRoomId);
                        void refreshNightlyRates(checkinDate, checkoutDate, { roomIdOverride: nextRoomId });
                    }}
                    onClose={() => setShowAssignRoomModal(false)}
                    onSuccess={() => setShowAssignRoomModal(false)}
                />
            )}

            {showPreArrivalPlanMoveModal && canShowPreArrivalPlanMoveAction && reservationId && (
                <RoomMoveModal
                    reservationId={reservationId}
                    currentRoomNumber={selectedRoomNumberForPlanMove}
                    currentRoomTypeId={String(roomTypeId)}
                    checkinDate={checkinDate}
                    checkoutDate={checkoutDate}
                    initialTab="plan_move"
                    planOnly
                    assignedLockActive={assignedRoomLockActive}
                    assignedLockReason={assignedRoomLockReason}
                    assignedLockRoomNumber={assignedRoomLockRoomNumber}
                    onClose={() => setShowPreArrivalPlanMoveModal(false)}
                    onSuccess={() => {
                        setShowPreArrivalPlanMoveModal(false);
                        setSuccessMessage("Planned room move saved.");
                        onSuccess();
                    }}
                />
            )}
        </>
    );
}
