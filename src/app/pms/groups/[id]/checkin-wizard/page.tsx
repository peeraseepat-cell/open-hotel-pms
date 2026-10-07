"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractDepositGeneralNote } from "@/lib/deposit-ledger";
import { formatDateDisplay } from "@/lib/date-display";
import { logUiEvent } from "@/lib/ui-event-log-client";

type PaymentMethod = "cash" | "transfer" | "credit_card";
type HkStatus = "approved" | "cleaned" | "dirty" | "in_progress" | "paused" | string | null;

type SplitPaymentDraft = {
  id: string;
  amount: string;
  method: PaymentMethod;
  note: string;
};

type SplitRoomPlan = {
  deposit_method: PaymentMethod;
  deposit_amount: string;
  deposit_note: string;
  payments: SplitPaymentDraft[];
};

type MasterPaymentLine = {
  id: string;
  amount: string;
  method: PaymentMethod;
  note: string;
};

type MasterDepositPlan = {
  amount: string;
  method: PaymentMethod;
  note: string;
};

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

function traceSmartCardUiEvent(params: {
  requestId?: string | null;
  groupId?: string | null;
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
    entity_type: "booking_group",
    entity_id: params.groupId ?? null,
    request_id: params.requestId ?? null,
    message: params.requestId ? `${params.message} [${params.requestId}]` : params.message,
    metadata: params.metadata,
  });
}

type WizardPartyGuest = {
  guest_profile_id: string;
  display_name: string;
  profile_status: string | null;
  nationality_code: string | null;
  id_number: string | null;
  passport_no: string | null;
  completeness: {
    is_complete: boolean;
    missing_fields: string[];
    is_thai: boolean;
  };
};

type WizardReservation = {
  id: string;
  booking_code: string;
  guest_name: string;
  status: string;
  room_number: string;
  room_type: string;
  room_type_max_guests: number;
  hk_status: HkStatus;
  checkin_date: string;
  is_checked_in: boolean;
  has_assigned_room: boolean;
  selected: boolean;
  total_price: number;
  deposit_amount: number;
  remaining_balance: number;
  profile_completeness: {
    is_complete: boolean;
    missing_fields: string[];
  };
  primary_guest_profile_id: string | null;
  accompanying_guest_profile_ids: string[];
  party: {
    primary: WizardPartyGuest | null;
    accompanying: WizardPartyGuest[];
  };
};

type ConfirmRoomResult = {
  reservation_id: string;
  booking_code: string | null;
  guest_name: string | null;
  status: "ok" | "failed" | "skipped";
  codes: string[];
  error?: string;
  missing_fields?: string[];
  checked_in_at?: string;
};

type GuestSearchResult = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  member_no: string | null;
  profile_status: string | null;
  nationality_code: string | null;
};

type ScanPoolSource = "thai_id" | "passport_ocr" | "search";

type ScannedPoolItem = GuestSearchResult & {
  scan_id?: string | null;
  source: ScanPoolSource;
  scan_order: number;
  display_name: string | null;
};

type ThaiCardImportPayload = {
  citizenId?: string;
  firstNameTH?: string;
  lastNameTH?: string;
  firstNameEN?: string;
  lastNameEN?: string;
  birthday?: string;
  gender?: string;
  address?: string;
  province?: string;
};

type PassportOcrImportPayload = {
  firstName?: string | null;
  familyName?: string | null;
  nationality?: string | null;
  passportNumber?: string | null;
  gender?: "M" | "F" | "X" | null;
  dateOfBirth?: string | null;
  fieldStatus?: {
    passportNumber?: "ok" | "manual_check";
  };
};

type PaymentPreviewData = {
  payment_mode: "split" | "master";
  grand_total: number;
  payment_received: number;
  deposit_received: number;
  remaining_balance: number;
  submitted_payment_total: number;
  projected_remaining_balance: number;
  overpayment_amount: number;
  room_rows: Array<{
    reservation_id: string;
    booking_code: string;
    guest_name: string | null;
    total_price: number;
    payment_received: number;
    deposit_received: number;
    remaining_balance: number;
    planned_payment: number;
    projected_remaining: number;
  }>;
  allocation_preview: Array<{
    line_index: number;
    method: string;
    amount: number;
    allocations: Array<{
      reservation_id: string;
      booking_code: string;
      allocated_amount: number;
    }>;
  }>;
  validation_errors: string[];
};

const HK_BLOCKING = new Set(["dirty", "in_progress", "paused"]);

function paymentDraft(seed = "payment", amount = ""): SplitPaymentDraft {
  return {
    id: `${seed}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    amount,
    method: "cash",
    note: "",
  };
}

function masterLine(seed = "master"): MasterPaymentLine {
  return {
    id: `${seed}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    amount: "",
    method: "cash",
    note: "",
  };
}

function toMoney(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function defaultDepositAmount(existingDepositAmount = 0): number {
  const normalized = toMoney(existingDepositAmount);
  return normalized > 0 ? normalized : 200;
}

function defaultSplitPlanByDeposit(row: Pick<WizardReservation, "id" | "deposit_amount" | "remaining_balance">): SplitRoomPlan {
  const normalizedDeposit = defaultDepositAmount(row.deposit_amount);
  return {
    deposit_method: "cash",
    deposit_amount: String(normalizedDeposit),
    deposit_note: "",
    payments: [paymentDraft(row.id, String(toMoney(row.remaining_balance)))],
  };
}

function splitPlanMatchesDefault(
  plan: SplitRoomPlan | undefined,
  row: Pick<WizardReservation, "deposit_amount" | "remaining_balance">
): boolean {
  if (!plan) return true;
  if (plan.deposit_method !== "cash") return false;
  if (String(plan.deposit_note ?? "").trim()) return false;
  if (toMoney(plan.deposit_amount) !== toMoney(defaultDepositAmount(row.deposit_amount))) return false;
  if (!Array.isArray(plan.payments) || plan.payments.length !== 1) return false;
  const [payment] = plan.payments;
  if (!payment || payment.method !== "cash") return false;
  if (String(payment.note ?? "").trim()) return false;
  return toMoney(payment.amount) === toMoney(row.remaining_balance);
}

function computeSplitCardTotals(row: WizardReservation, plan: SplitRoomPlan) {
  const roomRemaining = toMoney(row.remaining_balance);
  const depositTarget = Math.max(0, toMoney(plan.deposit_amount));
  const roomPlanned = plan.payments.reduce((sum, payment) => sum + Math.max(0, toMoney(payment.amount)), 0);
  const submittedTotal = roomPlanned + depositTarget;
  const currentDue = toMoney(roomRemaining + depositTarget);
  const projectedRemaining = toMoney(Math.max(0, currentDue - submittedTotal));
  const projectedRoomRemaining = toMoney(Math.max(0, roomRemaining - roomPlanned));

  return {
    roomRemaining,
    depositTarget,
    roomPlanned,
    submittedTotal,
    currentDue,
    projectedRemaining,
    projectedRoomRemaining,
  };
}

function distributeEvenly(totalAmount: number, reservationIds: string[]) {
  const ids = reservationIds.filter(Boolean);
  const allocation = new Map<string, number>();
  if (ids.length === 0) return allocation;

  const totalSatang = Math.max(0, Math.round(totalAmount * 100));
  const base = Math.floor(totalSatang / ids.length);
  let remainder = totalSatang - base * ids.length;

  ids.forEach((id) => {
    const satang = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    allocation.set(id, satang / 100);
  });

  return allocation;
}

function mapHkBadge(status: HkStatus) {
  const normalized = String(status ?? "").toLowerCase();
  if (normalized === "approved" || normalized === "cleaned") {
    return { label: "Ready", className: "bg-emerald-100 text-emerald-700" };
  }
  if (normalized === "dirty") {
    return { label: "Dirty", className: "bg-amber-100 text-amber-700" };
  }
  if (normalized === "in_progress") {
    return { label: "In Progress", className: "bg-sky-100 text-sky-700" };
  }
  if (normalized === "paused") {
    return { label: "Paused", className: "bg-rose-100 text-rose-700" };
  }
  if (!normalized) {
    return { label: "—", className: "bg-[var(--bg-surface-hover)] text-[var(--text-muted)]" };
  }
  return { label: normalized, className: "bg-[var(--bg-surface-hover)] text-[var(--text-secondary)]" };
}

function paymentMethodTone(method: PaymentMethod, active: boolean) {
  if (!active) {
    return "border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--border-input)] hover:bg-[var(--bg-surface-hover)]";
  }
  if (method === "cash") {
    return "border-emerald-500 bg-emerald-600 text-white shadow-md shadow-emerald-500/20";
  }
  if (method === "transfer") {
    return "border-sky-500 bg-sky-600 text-white shadow-md shadow-sky-500/20";
  }
  return "border-violet-500 bg-violet-600 text-white shadow-md shadow-violet-500/20";
}

function paymentStatusTone(value: number) {
  if (value < 0) return "refund";
  if (Math.abs(value) < 0.01) return "paid";
  return "due";
}

function PaymentMethodButtons({
  value,
  onChange,
}: {
  value: PaymentMethod;
  onChange: (value: PaymentMethod) => void;
}) {
  const options: Array<{ value: PaymentMethod; label: string }> = [
    { value: "cash", label: "Cash" },
    { value: "transfer", label: "Transfer" },
    { value: "credit_card", label: "Card" },
  ];

  return (
    <div className="grid grid-cols-3 gap-2">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`h-10 rounded-xl border text-sm font-black tracking-wide transition ${paymentMethodTone(option.value, active)}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function guestDisplayName(guest: GuestSearchResult): string {
  const explicit = "display_name" in guest ? String((guest as any).display_name ?? "").trim() : "";
  if (explicit) return explicit;
  const first = String(guest.first_name ?? "").trim();
  const last = String(guest.last_name ?? "").trim();
  const full = `${first} ${last}`.trim();
  if (full) return full;
  return guest.member_no ? `Member ${guest.member_no}` : guest.id;
}

function scanSourceLabel(source: ScanPoolSource): string {
  if (source === "thai_id") return "Thai ID";
  if (source === "passport_ocr") return "Passport OCR";
  return "Search";
}

function scanSourceBadgeClass(source: ScanPoolSource): string {
  if (source === "thai_id") return "bg-sky-100 text-sky-700";
  if (source === "passport_ocr") return "bg-purple-100 text-purple-700";
  return "bg-[var(--bg-muted)] text-[var(--text-table-cell)]";
}

function upsertScannedPoolItem(pool: ScannedPoolItem[], item: ScannedPoolItem): ScannedPoolItem[] {
  const existingIndex = pool.findIndex((entry) => entry.id === item.id);
  if (existingIndex >= 0) {
    const next = [...pool];
    next[existingIndex] = {
      ...next[existingIndex],
      ...item,
      source: item.source === "search" ? next[existingIndex].source : item.source,
      scan_order: next[existingIndex].scan_order || item.scan_order,
    };
    return next.sort((a, b) => a.scan_order - b.scan_order);
  }
  return [...pool, item].sort((a, b) => a.scan_order - b.scan_order);
}

function formatWizardReason(reason: string, businessDate: string, checkinDate: string): string {
  if (reason === "room_not_assigned") return "Assign room first";
  if (reason === "hk_not_ready") return "Housekeeping not ready";
  if (reason === "profile_incomplete") return "Guest profile incomplete";
  if (reason === "not_due_in_today") {
    return `Separate check-in on ${formatDateDisplay(checkinDate || businessDate)}`;
  }
  return reason;
}

export default function GroupCheckinWizardPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const groupId = params.id;

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const [groupData, setGroupData] = useState<any>(null);
  const [businessDate, setBusinessDate] = useState("");
  const [currentStep, setCurrentStep] = useState(1);
  const [reservations, setReservations] = useState<WizardReservation[]>([]);
  const [splitPlans, setSplitPlans] = useState<Record<string, SplitRoomPlan>>({});
  const [paymentMode, setPaymentMode] = useState<"split" | "master">("split");
  const [masterPayments, setMasterPayments] = useState<MasterPaymentLine[]>([masterLine("master")]);
  const [masterPaymentsEdited, setMasterPaymentsEdited] = useState(false);
  const [masterDeposit, setMasterDeposit] = useState<MasterDepositPlan>({
    amount: "",
    method: "cash",
    note: "",
  });
  const [masterDepositEdited, setMasterDepositEdited] = useState(false);
  const [confirmResults, setConfirmResults] = useState<ConfirmRoomResult[] | null>(null);
  const [wizardDraftJson, setWizardDraftJson] = useState<Record<string, any>>({});
  const [wizardDraftRevision, setWizardDraftRevision] = useState("");

  const [guestQuery, setGuestQuery] = useState("");
  const [searchingGuests, setSearchingGuests] = useState(false);
  const [searchResults, setSearchResults] = useState<GuestSearchResult[]>([]);
  const [searchError, setSearchError] = useState("");
  const [scannedGuestPool, setScannedGuestPool] = useState<ScannedPoolItem[]>([]);
  const [step2Busy, setStep2Busy] = useState(false);
  const [targetReservationId, setTargetReservationId] = useState("");
  const [targetRole, setTargetRole] = useState<"primary" | "accompanying">("primary");

  const [mobileScans, setMobileScans] = useState<any[]>([]);
  const [isImportingAll, setIsImportingAll] = useState(false);
  const [showFailedModal, setShowFailedModal] = useState<{ scanId: string; imagePath: string } | null>(null);
  const thaiCardPopupRef = useRef<Window | null>(null);
  const thaiCardRequestIdRef = useRef<string | null>(null);
  const processedSmartCardRequestIdsRef = useRef<Set<string>>(new Set());

  const [loadingPaymentPreview, setLoadingPaymentPreview] = useState(false);
  const [paymentPreview, setPaymentPreview] = useState<PaymentPreviewData | null>(null);

  const backHref = `/pms/groups?group_id=${groupId}`;

  const selectedReservations = useMemo(
    () => reservations.filter((row) => row.selected),
    [reservations]
  );

  const selectedReservationIds = useMemo(
    () => selectedReservations.map((row) => row.id),
    [selectedReservations]
  );

  const selectedAssignedGuestIds = useMemo(() => {
    const ids = new Set<string>();
    selectedReservations.forEach((reservation) => {
      if (reservation.primary_guest_profile_id) ids.add(reservation.primary_guest_profile_id);
      reservation.accompanying_guest_profile_ids.forEach((id) => ids.add(id));
    });
    return ids;
  }, [selectedReservations]);

  function mapPartyGuest(raw: any): WizardPartyGuest {
    return {
      guest_profile_id: String(raw?.guest_profile_id ?? ""),
      display_name: String(raw?.display_name ?? "Unknown Guest"),
      profile_status: raw?.profile_status ? String(raw.profile_status) : null,
      nationality_code: raw?.nationality_code ? String(raw.nationality_code) : null,
      id_number: raw?.id_number ? String(raw.id_number) : null,
      passport_no: raw?.passport_no ? String(raw.passport_no) : null,
      completeness: {
        is_complete: Boolean(raw?.completeness?.is_complete),
        missing_fields: Array.isArray(raw?.completeness?.missing_fields)
          ? raw.completeness.missing_fields.map((value: unknown) => String(value))
          : [],
        is_thai: Boolean(raw?.completeness?.is_thai),
      },
    };
  }

  function mapReservationLine(line: any, selectedIds: Set<string>): WizardReservation {
    const primary = line?.party?.primary ? mapPartyGuest(line.party.primary) : null;
    const accompanying = Array.isArray(line?.party?.accompanying)
      ? line.party.accompanying.map((guest: any) => mapPartyGuest(guest))
      : [];

    return {
      id: String(line.reservation_id),
      booking_code: String(line.booking_code ?? ""),
      guest_name: String(line.guest_name ?? ""),
      status: String(line.status ?? ""),
      room_number: line.room_number ? String(line.room_number) : "—",
      room_type: line.room_type ? String(line.room_type) : "—",
      room_type_max_guests: Math.max(1, Number(line.room_type_max_guests ?? 2) || 2),
      hk_status: (line.hk_status ?? null) as HkStatus,
      checkin_date: String(line.checkin_date ?? ""),
      is_checked_in: Boolean(line.is_checked_in),
      has_assigned_room: Boolean(line.has_assigned_room),
      selected: selectedIds.has(String(line.reservation_id)),
      total_price: toMoney(line.total_price),
      deposit_amount: toMoney(line.deposit_amount),
      remaining_balance: toMoney(line.remaining_balance),
      profile_completeness: {
        is_complete: Boolean(line?.profile_completeness?.is_complete),
        missing_fields: Array.isArray(line?.profile_completeness?.missing_fields)
          ? line.profile_completeness.missing_fields.map((value: unknown) => String(value))
          : [],
      },
      primary_guest_profile_id: line?.primary_guest_profile_id
        ? String(line.primary_guest_profile_id)
        : primary?.guest_profile_id ?? null,
      accompanying_guest_profile_ids: Array.isArray(line?.accompanying_guest_profile_ids)
        ? line.accompanying_guest_profile_ids.map((value: unknown) => String(value))
        : accompanying.map((guest: WizardPartyGuest) => guest.guest_profile_id),
      party: {
        primary,
        accompanying,
      },
    };
  }

  function buildReservationRows(data: any): WizardReservation[] {
    const currentBusinessDate = String(data?.business_date ?? "");
    const selectedIds = new Set<string>(
      Array.isArray(data?.selection?.selected_reservation_ids)
        ? data.selection.selected_reservation_ids.map((value: unknown) => String(value))
        : []
    );

    return Array.isArray(data?.reservation_lines)
      ? data.reservation_lines.map((line: any) => {
        const row = mapReservationLine(line, selectedIds);
        const canRemainSelected =
          !row.is_checked_in &&
          row.has_assigned_room &&
          row.status === "active" &&
          (!currentBusinessDate || row.checkin_date === currentBusinessDate);
        return canRemainSelected ? row : { ...row, selected: false };
      })
      : [];
  }

  function buildPlanFromDraftRow(raw: any, row: Pick<WizardReservation, "id" | "deposit_amount" | "remaining_balance">): SplitRoomPlan {
    const payments = Array.isArray(raw?.payments) ? raw.payments : [];
    const draftDepositAmount = toMoney(raw?.deposit_amount ?? defaultDepositAmount(row.deposit_amount));

    return {
      deposit_method: raw?.deposit_method === "transfer"
        || raw?.deposit_method === "credit_card"
        ? raw.deposit_method
        : "cash",
      deposit_amount: String(draftDepositAmount > 0 ? draftDepositAmount : defaultDepositAmount(row.deposit_amount)),
      deposit_note: extractDepositGeneralNote(raw?.deposit_note) ?? "",
      payments: payments.length > 0
        ? payments.map((payment: any, idx: number) => ({
          id: `${row.id}-${idx}-${Math.random().toString(16).slice(2)}`,
          amount:
            idx === 0 && String(payment?.amount ?? "").trim() === ""
              ? String(toMoney(row.remaining_balance))
              : String(payment?.amount ?? ""),
          method: payment?.method === "transfer"
            || payment?.method === "credit_card"
            ? payment.method
            : "cash",
          note: String(payment?.note ?? ""),
        }))
        : [paymentDraft(row.id, String(toMoney(row.remaining_balance)))],
    };
  }

  function hydrateScannedPoolFromDraft(
    rows: WizardReservation[],
    draftJson: Record<string, any>,
    preservedPool: ScannedPoolItem[] = []
  ) {
    const draftStep2Pool = Array.isArray((draftJson as any)?.step2?.scanned_pool)
      ? (draftJson as any).step2.scanned_pool
      : [];
    const draftStep2Ids = draftStep2Pool.length > 0
      ? draftStep2Pool
        .map((item: any) => String(item?.guest_profile_id ?? "").trim())
        .filter(Boolean)
      : Array.isArray((draftJson as any)?.step2?.scanned_guest_profile_ids)
        ? (draftJson as any).step2.scanned_guest_profile_ids.map((value: unknown) => String(value))
        : [];
    const knownGuestMap = new Map<string, GuestSearchResult>();
    preservedPool.forEach((guest) => {
      knownGuestMap.set(guest.id, guest);
    });
    rows.forEach((row) => {
      if (row.party.primary) {
        knownGuestMap.set(row.party.primary.guest_profile_id, {
          id: row.party.primary.guest_profile_id,
          first_name: row.party.primary.display_name,
          last_name: null,
          phone: null,
          member_no: null,
          profile_status: row.party.primary.profile_status,
          nationality_code: row.party.primary.nationality_code,
        });
      }
      row.party.accompanying.forEach((guest) => {
        knownGuestMap.set(guest.guest_profile_id, {
          id: guest.guest_profile_id,
          first_name: guest.display_name,
          last_name: null,
          phone: null,
          member_no: null,
          profile_status: guest.profile_status,
          nationality_code: guest.nationality_code,
        });
      });
    });

    const scanById = new Map<string, string>();
    const sourceById = new Map<string, ScanPoolSource>();
    const orderById = new Map<string, number>();
    const displayById = new Map<string, string>();
    draftStep2Pool.forEach((item: any, idx: number) => {
      const profileId = String(item?.guest_profile_id ?? "").trim();
      if (!profileId) return;
      if (item?.scan_id) scanById.set(profileId, String(item.scan_id));
      const sourceRaw = String(item?.source ?? "search").trim() as ScanPoolSource;
      sourceById.set(
        profileId,
        sourceRaw === "thai_id" || sourceRaw === "passport_ocr" || sourceRaw === "search"
          ? sourceRaw
          : "search"
      );
      orderById.set(profileId, Number.isFinite(Number(item?.scan_order)) ? Number(item.scan_order) : idx + 1);
      const snapshotName = String(item?.display_name ?? "").trim();
      if (snapshotName) displayById.set(profileId, snapshotName);
    });
    preservedPool.forEach((item, idx) => {
      if (item.scan_id) scanById.set(item.id, item.scan_id);
      sourceById.set(item.id, item.source);
      orderById.set(item.id, Number.isFinite(Number(item.scan_order)) ? Number(item.scan_order) : idx + 1);
      const displayName = String(item.display_name ?? guestDisplayName(item)).trim();
      if (displayName) displayById.set(item.id, displayName);
    });

    const mergedIds = Array.from(new Set([
      ...draftStep2Ids,
      ...preservedPool.map((guest) => guest.id),
    ].filter(Boolean)));

    const hydratedPool: ScannedPoolItem[] = mergedIds
      .map((id: string, idx: number) => {
        const known = knownGuestMap.get(id);
        return {
          ...(known ?? {
            id,
            first_name: null,
            last_name: null,
            phone: null,
            member_no: null,
            profile_status: null,
            nationality_code: null,
          }),
          scan_id: scanById.get(id) ?? null,
          source: sourceById.get(id) ?? "search",
          scan_order: orderById.get(id) ?? idx + 1,
          display_name: displayById.get(id) ?? known?.first_name ?? id,
        } as ScannedPoolItem;
      })
      .sort((a: ScannedPoolItem, b: ScannedPoolItem) => a.scan_order - b.scan_order);

    setScannedGuestPool(hydratedPool);
  }

  async function reloadReservationSnapshot(options?: { preserveScannedPool?: ScannedPoolItem[] }) {
    const response = await fetch(
      `/api/booking-groups/${groupId}/checkin-wizard?business_date=${encodeURIComponent(businessDate || "")}`,
      { cache: "no-store" }
    );
    const data = await response.json();
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || "Failed to reload wizard.");
    }
    setBusinessDate(String(data.business_date ?? ""));
    setGroupData(data.group ?? null);
    const draftJson =
      data?.draft?.draft_json && typeof data.draft.draft_json === "object"
        ? data.draft.draft_json
        : {};
    setWizardDraftJson(draftJson);
    setWizardDraftRevision(String(data?.draft?.updated_at ?? ""));
    const rows = buildReservationRows(data);
    setReservations(rows);
    hydrateScannedPoolFromDraft(rows, draftJson, options?.preserveScannedPool ?? scannedGuestPool);
  }

  async function refreshPricingSnapshot(options?: { syncDefaultPlans?: boolean }) {
    const response = await fetch(
      `/api/booking-groups/${groupId}/checkin-wizard?business_date=${encodeURIComponent(businessDate || "")}`,
      { cache: "no-store" }
    );
    const data = await response.json();
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || "Failed to refresh current booking prices.");
    }

    const rows = buildReservationRows(data);
    const currentById = new Map(reservations.map((row) => [row.id, row] as const));
    const selectedIds = new Set(selectedReservationIds);
    const pricingChanged = rows.some((row) => {
      if (!selectedIds.has(row.id)) return false;
      const current = currentById.get(row.id);
      if (!current) return false;
      return (
        Math.abs(toMoney(current.total_price) - toMoney(row.total_price)) >= 0.01
        || Math.abs(toMoney(current.remaining_balance) - toMoney(row.remaining_balance)) >= 0.01
      );
    });

    setBusinessDate(String(data.business_date ?? ""));
    setGroupData(data.group ?? null);
    const draftJson =
      data?.draft?.draft_json && typeof data.draft.draft_json === "object"
        ? data.draft.draft_json
        : {};
    setWizardDraftJson(draftJson);
    setWizardDraftRevision(String(data?.draft?.updated_at ?? ""));
    setReservations(rows);
    hydrateScannedPoolFromDraft(rows, draftJson);

    if (options?.syncDefaultPlans) {
      setSplitPlans((prev) => {
        const next: Record<string, SplitRoomPlan> = { ...prev };
        rows.forEach((row) => {
          const existing = prev[row.id];
          const previousRow = currentById.get(row.id);
          if (!existing) {
            next[row.id] = defaultSplitPlanByDeposit(row);
            return;
          }
          if (previousRow && splitPlanMatchesDefault(existing, previousRow)) {
            next[row.id] = defaultSplitPlanByDeposit(row);
            return;
          }
          next[row.id] = existing;
        });
        return next;
      });
    }

    if (pricingChanged) {
      setPaymentPreview(null);
    }

    return { pricingChanged };
  }

  const step4Buckets = useMemo(() => {
    const ready: WizardReservation[] = [];
    const notReady: Array<{ row: WizardReservation; reasons: string[] }> = [];
    const done: WizardReservation[] = [];

    for (const row of selectedReservations) {
      if (row.is_checked_in) {
        done.push(row);
        continue;
      }

      const reasons: string[] = [];
      if (!row.has_assigned_room) reasons.push("room_not_assigned");
      if (HK_BLOCKING.has(String(row.hk_status ?? ""))) reasons.push("hk_not_ready");
      if (!row.profile_completeness.is_complete) reasons.push("profile_incomplete");
      if (businessDate && row.checkin_date && row.checkin_date !== businessDate) reasons.push("not_due_in_today");

      if (reasons.length > 0) notReady.push({ row, reasons });
      else ready.push(row);
    }

    return { ready, notReady, done };
  }, [selectedReservations, businessDate]);

  const step1Eligibility = useMemo(() => {
    return reservations.map((row) => {
      const reasons: string[] = [];
      if (row.is_checked_in) reasons.push("already_checked_in");
      if (row.status !== "active") reasons.push("inactive");
      if (!row.has_assigned_room) reasons.push("room_not_assigned");
      if (businessDate && row.checkin_date && row.checkin_date !== businessDate) reasons.push("not_due_in_today");

      return {
        row,
        reasons,
        isDueToday: Boolean(businessDate && row.checkin_date === businessDate),
        selectable: reasons.length === 0,
      };
    });
  }, [businessDate, reservations]);

  const eligibleStep1Rows = useMemo(
    () => step1Eligibility.filter((item) => item.selectable),
    [step1Eligibility]
  );

  const selectedRemainingTotal = useMemo(
    () =>
      selectedReservations.reduce((sum, row) => {
        if (paymentMode !== "split") return sum + toMoney(row.remaining_balance);
        const plan = splitPlans[row.id] ?? defaultSplitPlanByDeposit(row);
        return sum + computeSplitCardTotals(row, plan).currentDue;
      }, 0) + (paymentMode === "master" ? Math.max(0, toMoney(masterDeposit.amount)) : 0),
    [masterDeposit.amount, paymentMode, selectedReservations, splitPlans]
  );

  const plannedPaymentTotal = useMemo(() => {
    if (paymentMode === "master") {
      return toMoney(
        masterPayments.reduce((sum, line) => sum + Math.max(0, toMoney(line.amount)), 0)
        + Math.max(0, toMoney(masterDeposit.amount))
      );
    }
    return selectedReservations.reduce((sum, row) => {
      const plan = splitPlans[row.id] ?? defaultSplitPlanByDeposit(row);
      return sum + computeSplitCardTotals(row, plan).submittedTotal;
    }, 0);
  }, [paymentMode, masterDeposit.amount, masterPayments, selectedReservations, splitPlans]);

  const projectedRemainingTotal = useMemo(
    () => Math.max(0, toMoney(selectedRemainingTotal - plannedPaymentTotal)),
    [selectedRemainingTotal, plannedPaymentTotal]
  );

  useEffect(() => {
    setTargetReservationId((prev) => {
      if (prev && selectedReservations.some((row) => row.id === prev)) return prev;
      return selectedReservations[0]?.id ?? "";
    });
  }, [selectedReservations]);

  useEffect(() => {
    setPaymentPreview(null);
  }, [paymentMode, selectedReservationIds.join(","), masterDeposit.amount, masterDeposit.method, masterDeposit.note, masterPayments, splitPlans]);

  useEffect(() => {
    if (masterDepositEdited) return;
    const defaultTotal = selectedReservations.reduce(
      (sum, row) => sum + defaultDepositAmount(row.deposit_amount),
      0
    );
    setMasterDeposit((prev) => ({ ...prev, amount: defaultTotal > 0 ? String(toMoney(defaultTotal)) : "" }));
  }, [masterDepositEdited, selectedReservations]);

  useEffect(() => {
    if (masterPaymentsEdited) return;
    const defaultRoomTotal = toMoney(
      selectedReservations.reduce((sum, row) => sum + toMoney(row.remaining_balance), 0)
    );
    setMasterPayments((prev) => {
      if (prev.length === 0) {
        return [
          {
            ...masterLine("master-default"),
            amount: defaultRoomTotal > 0 ? String(defaultRoomTotal) : "",
          },
        ];
      }
      return prev.map((line, idx) =>
        idx === 0
          ? { ...line, amount: defaultRoomTotal > 0 ? String(defaultRoomTotal) : "" }
          : line
      );
    });
  }, [masterPaymentsEdited, selectedReservations]);

  const refreshMobileScans = useCallback(async () => {
    try {
      const res = await fetch(`/api/checkin/group-ocr-pool/${groupId}`, { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.pool) {
          setMobileScans(json.pool);
          return;
        }
      }
      const mock = (await import("@/lib/mock/group-ocr")).mockGroupOcrPool(groupId);
      setMobileScans(mock.pool);
    } catch {
      const mock = (await import("@/lib/mock/group-ocr")).mockGroupOcrPool(groupId);
      setMobileScans(mock.pool);
    }
  }, [groupId]);

  // --- Phase 50 Mobile Scans Polling ---
  useEffect(() => {
    if (currentStep !== 2 || !groupId) return;

    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      await refreshMobileScans();
    };

    void poll();
    const interval = setInterval(() => { void poll(); }, 3000);
    return () => clearInterval(interval);
  }, [currentStep, groupId, refreshMobileScans]);

  const filteredMobileScans = useMemo(() => {
    const seenScanIds = new Set<string>();
    return mobileScans.filter((scan) => {
      const scanId = String(scan?.scan_id ?? "").trim();
      const status = String(scan?.pool_status ?? "").trim();
      if (!scanId || seenScanIds.has(scanId)) return false;
      seenScanIds.add(scanId);
      return status !== "assigned";
    });
  }, [mobileScans]);

  async function importSingleScan(scan: any) {
    setStep2Busy(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch(`/api/checkin/group-ocr-pool/${groupId}/import-to-wizard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scan_ids: [scan.scan_id],
          business_date: businessDate,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Failed to import scan.");
      }
      await reloadReservationSnapshot();
      await refreshMobileScans();
      if (Number(data?.imported_count ?? 0) > 0) {
        setInfo(`Imported ${scan.display_name} from mobile scan.`);
      } else {
        const reason = Array.isArray(data?.skipped_reasons) && data.skipped_reasons.length > 0
          ? String(data.skipped_reasons[0])
          : "Scan was skipped.";
        setInfo(reason);
      }
    } catch (err: any) {
      setError(err?.message || "Failed to import scan.");
    } finally {
      setStep2Busy(false);
    }
  }

  async function importAllReadyScans() {
    const readyScans = filteredMobileScans.filter((s: any) => s.pool_status === "ready" && s.guest_profile_id);
    if (readyScans.length === 0) return;

    setIsImportingAll(true);
    setStep2Busy(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch(`/api/checkin/group-ocr-pool/${groupId}/import-to-wizard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scan_ids: readyScans.map((s: any) => s.scan_id),
          business_date: businessDate,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Failed to import all scans.");
      }
      await reloadReservationSnapshot();
      await refreshMobileScans();
      const imported = Number(data?.imported_count ?? 0);
      const skipped = Number(data?.skipped_count ?? 0);
      setInfo(`Imported ${imported} profile(s) from mobile scans.${skipped > 0 ? ` Skipped ${skipped}.` : ""}`);
    } catch (err: any) {
      setError(err?.message || "Failed to import all scans.");
    } finally {
      setIsImportingAll(false);
      setStep2Busy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      setInfo("");
      setConfirmResults(null);
      try {
        const response = await fetch(`/api/booking-groups/${groupId}/checkin-wizard`, {
          cache: "no-store",
        });
        const data = await response.json();

        if (!response.ok || !data?.success) {
          throw new Error(data?.error || "Failed to load check-in wizard.");
        }

        if (cancelled) return;

        setBusinessDate(String(data.business_date ?? ""));
        setGroupData(data.group ?? null);
        const draftJson =
          data?.draft?.draft_json && typeof data.draft.draft_json === "object"
            ? data.draft.draft_json
            : {};
        setWizardDraftJson(draftJson);
    setWizardDraftRevision(String(data?.draft?.updated_at ?? ""));

        const rows = buildReservationRows(data);
        setReservations(rows);
        setTargetReservationId((prev) => {
          if (prev && rows.some((row) => row.id === prev && row.selected)) return prev;
          return rows.find((row) => row.selected)?.id ?? rows[0]?.id ?? "";
        });

        hydrateScannedPoolFromDraft(rows, draftJson);

        const plan: Record<string, SplitRoomPlan> = {};
        const draftSplitMap = new Map<string, any>();
        const draftSplitRows = Array.isArray((draftJson as any)?.step3?.split_payment_plan)
          ? (draftJson as any).step3.split_payment_plan
          : [];
        draftSplitRows.forEach((row: any) => {
          const reservationId = String(row?.reservation_id ?? "").trim();
          if (reservationId) draftSplitMap.set(reservationId, row);
        });
        rows.forEach((row) => {
          const fromDraft = draftSplitMap.get(row.id);
          plan[row.id] = fromDraft
            ? buildPlanFromDraftRow(fromDraft, row)
            : defaultSplitPlanByDeposit(row);
        });
        setSplitPlans(plan);

        const resumeStep = Number(data?.resume_hint?.start_step ?? 1);
        setCurrentStep(Number.isFinite(resumeStep) ? Math.max(1, Math.min(4, Math.trunc(resumeStep))) : 1);

        const draftMode = (data?.draft?.draft_json as any)?.step3?.payment_mode;
        if (draftMode === "master" || draftMode === "split") {
          setPaymentMode(draftMode);
        }

        const draftMasterPlan = Array.isArray((draftJson as any)?.step3?.master_payment_plan)
          ? (draftJson as any).step3.master_payment_plan
          : [];
        if (draftMasterPlan.length > 0) {
          setMasterPayments(
            draftMasterPlan.map((line: any, idx: number) => ({
              id: `draft-master-${idx}-${Math.random().toString(16).slice(2)}`,
              amount:
                idx === 0 && toMoney(line?.amount ?? 0) <= 0
                  ? String(toMoney(rows.reduce((sum, row) => sum + toMoney(row.remaining_balance), 0)))
                  : String(line?.amount ?? ""),
              method: line?.method === "transfer"
                || line?.method === "credit_card"
                ? line.method
                : "cash",
              note: String(line?.note ?? ""),
            }))
          );
        } else {
          setMasterPayments([
            {
              ...masterLine("master"),
              amount: String(toMoney(rows.reduce((sum, row) => sum + toMoney(row.remaining_balance), 0))),
            },
          ]);
        }
        setMasterPaymentsEdited(
          draftMasterPlan.some((line: any) => toMoney(line?.amount ?? 0) > 0)
        );

        const draftMasterDeposit = (draftJson as any)?.step3?.master_deposit;
        setMasterDeposit({
          amount:
            draftMasterDeposit?.amount != null && String(draftMasterDeposit.amount).trim() !== ""
              ? String(draftMasterDeposit.amount)
              : "",
          method:
            draftMasterDeposit?.method === "transfer" || draftMasterDeposit?.method === "credit_card"
              ? draftMasterDeposit.method
              : "cash",
          note: String(draftMasterDeposit?.note ?? ""),
        });
        setMasterDepositEdited(
          draftMasterDeposit?.amount != null && String(draftMasterDeposit.amount).trim() !== ""
        );
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load wizard.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [groupId]);

  async function saveDraft(current: number, redirect: boolean) {
    const payload = {
      draft_revision: wizardDraftRevision,
      business_date: businessDate,
      current_step: current,
      draft_json: {
        step1: {
          selected_reservation_ids: reservations.filter((row) => row.selected).map((row) => row.id),
          selection_mode: "manual",
        },
        step2: {
          scanned_pool: scannedGuestPool.map((guest) => ({
            guest_profile_id: guest.id,
            scan_id: guest.scan_id ?? null,
            source: guest.source,
            scan_order: guest.scan_order,
            display_name: guestDisplayName(guest),
            profile_status: guest.profile_status ?? null,
            nationality_code: guest.nationality_code ?? null,
          })),
          scanned_guest_profile_ids: scannedGuestPool.map((guest) => guest.id),
        },
        step3: {
          payment_mode: paymentMode,
          split_payment_plan: reservations.map((row) => ({
            reservation_id: row.id,
            ...(splitPlans[row.id] ?? {
              ...defaultSplitPlanByDeposit(row),
              payments: [],
            }),
          })),
          master_payment_plan: masterPayments.map((line) => ({
            amount: toMoney(line.amount),
            method: line.method,
            note: line.note || null,
          })),
          master_deposit: {
            amount: toMoney(masterDeposit.amount),
            method: masterDeposit.method,
            note: masterDeposit.note || null,
          },
        },
        step4: {
          selected_reservation_ids: reservations.filter((row) => row.selected).map((row) => row.id),
        },
      },
    };

    const response = await fetch(
      `/api/booking-groups/${groupId}/checkin-wizard/${redirect ? "save-draft-and-exit" : "draft"}`,
      {
        method: redirect ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    const data = await response.json();
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || "Failed to save draft.");
    }
    setWizardDraftRevision(String(data?.draft?.updated_at ?? ""));
  }

  async function handleSaveAndExit() {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      await saveDraft(currentStep, true);
      router.push(backHref);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save draft failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelDraft() {
    if (!businessDate) return;
    setBusy(true);
    setError("");
    setInfo("");
    try {
      const response = await fetch(`/api/booking-groups/${groupId}/checkin-wizard/cancel-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business_date: businessDate }),
      });
      const data = await response.json();
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || "Cancel draft failed.");
      }
      router.push(backHref);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel draft failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleNext() {
    setError("");
    setInfo("");

    if (currentStep === 1 && selectedReservations.length === 0) {
      setError("Please select at least one room before continuing.");
      return;
    }

    try {
      await saveDraft(currentStep, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save current step.");
      return;
    }

    setCurrentStep((prev) => Math.min(4, prev + 1));
  }

  function handleBack() {
    setError("");
    setInfo("");
    setCurrentStep((prev) => Math.max(1, prev - 1));
  }

  function toggleSelection(id: string) {
    const target = reservations.find((row) => row.id === id);
    if (target?.selected) {
      setInfo(`Room ${target.room_number} will not be included in check-in. Guest assignments remain.`);
    }
    setReservations((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row;
        if (row.is_checked_in || !row.has_assigned_room || row.status !== "active") return row;
        if (businessDate && row.checkin_date !== businessDate) return row;
        return { ...row, selected: !row.selected };
      })
    );
  }

  function toggleAll(select: boolean) {
    setReservations((prev) =>
      prev.map((row) => {
        const canSelect =
          !row.is_checked_in &&
          row.has_assigned_room &&
          row.status === "active" &&
          (!businessDate || row.checkin_date === businessDate);
        return canSelect ? { ...row, selected: select } : row;
      })
    );
  }

  function updateSplitPlan(reservationId: string, patch: Partial<SplitRoomPlan>) {
    const reservation = reservations.find((row) => row.id === reservationId);
    setSplitPlans((prev) => ({
      ...prev,
      [reservationId]: {
        ...(prev[reservationId] ?? defaultSplitPlanByDeposit({
          id: reservationId,
          deposit_amount: reservation?.deposit_amount ?? 0,
          remaining_balance: reservation?.remaining_balance ?? 0,
        })),
        ...patch,
      },
    }));
  }

  function updateSplitPayment(reservationId: string, paymentId: string, patch: Partial<SplitPaymentDraft>) {
    const reservation = reservations.find((row) => row.id === reservationId);
    setSplitPlans((prev) => {
      const base = prev[reservationId] ?? defaultSplitPlanByDeposit({
        id: reservationId,
        deposit_amount: reservation?.deposit_amount ?? 0,
        remaining_balance: reservation?.remaining_balance ?? 0,
      });
      return {
        ...prev,
        [reservationId]: {
          ...base,
          payments: base.payments.map((payment) =>
            payment.id === paymentId ? { ...payment, ...patch } : payment
          ),
        },
      };
    });
  }

  function addSplitPayment(reservationId: string) {
    const reservation = reservations.find((row) => row.id === reservationId);
    setSplitPlans((prev) => {
      const base = prev[reservationId] ?? defaultSplitPlanByDeposit({
        id: reservationId,
        deposit_amount: reservation?.deposit_amount ?? 0,
        remaining_balance: reservation?.remaining_balance ?? 0,
      });
      return {
        ...prev,
        [reservationId]: {
          ...base,
          payments: [...base.payments, paymentDraft(reservationId)],
        },
      };
    });
  }

  function removeSplitPayment(reservationId: string, paymentId: string) {
    const reservation = reservations.find((row) => row.id === reservationId);
    setSplitPlans((prev) => {
      const base = prev[reservationId];
      if (!base) return prev;
      const payments = base.payments.filter((payment) => payment.id !== paymentId);
      return {
        ...prev,
        [reservationId]: {
          ...base,
          payments: payments.length > 0
            ? payments
            : [paymentDraft(reservationId, String(toMoney(reservation?.remaining_balance ?? 0)))],
        },
      };
    });
  }

  function updateMasterLine(lineId: string, patch: Partial<MasterPaymentLine>) {
    setMasterPaymentsEdited(true);
    setMasterPayments((prev) => prev.map((line) => (line.id === lineId ? { ...line, ...patch } : line)));
  }

  function addMasterLine() {
    setMasterPaymentsEdited(true);
    setMasterPayments((prev) => [...prev, masterLine("master")]);
  }

  function removeMasterLine(lineId: string) {
    setMasterPaymentsEdited(true);
    setMasterPayments((prev) => {
      const remaining = prev.filter((line) => line.id !== lineId);
      return remaining.length > 0 ? remaining : [masterLine("master")];
    });
  }

  async function ingestIdentityToPool(params: {
    source: ScanPoolSource;
    guestProfileId?: string;
    payload?: Record<string, unknown>;
  }) {
    const response = await fetch(`/api/booking-groups/${groupId}/checkin-wizard/step2/ingest-identity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: params.source,
        guest_profile_id: params.guestProfileId,
        payload: params.payload ?? {},
        scan_order: Date.now(),
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success || !data?.entry) {
      throw new Error(data?.error || "Failed to ingest identity into scan pool.");
    }

    const entry = data.entry;
    const poolItem: ScannedPoolItem = {
      id: String(entry.guest_profile_id),
      first_name: entry.first_name ? String(entry.first_name) : null,
      last_name: entry.last_name ? String(entry.last_name) : null,
      phone: entry.phone ? String(entry.phone) : null,
      member_no: entry.member_no ? String(entry.member_no) : null,
      profile_status: entry.profile_status ? String(entry.profile_status) : null,
      nationality_code: entry.nationality_code ? String(entry.nationality_code) : null,
      source: entry.source === "thai_id" || entry.source === "passport_ocr" || entry.source === "search"
        ? entry.source
        : params.source,
      scan_order: Number.isFinite(Number(entry.scan_order)) ? Number(entry.scan_order) : Date.now(),
      display_name: entry.display_name ? String(entry.display_name) : null,
    };

    setScannedGuestPool((prev) => upsertScannedPoolItem(prev, poolItem));
    return poolItem;
  }

  function openThaiCardReader() {
    if (typeof window === "undefined") return;
    const savedWs = window.localStorage.getItem("pms.smartcard.wsEndpoint");
    const requestId = `thai-card-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const params = new URLSearchParams({ popup: "1", target: "main", t: String(Date.now()), request_id: requestId });
    if (savedWs) params.set("ws", savedWs);
    let popupUrl = `${window.location.origin}/smart-card?${params.toString()}`;
    if (window.location.protocol === "https:") {
      let helperOrigin = "http://127.0.0.1:3001";
      if (savedWs) {
        try {
          const wsUrl = new URL(savedWs);
          helperOrigin = `${wsUrl.protocol === "wss:" ? "https:" : "http:"}//${wsUrl.host}`;
        } catch {
          helperOrigin = "http://127.0.0.1:3001";
        }
      }
      params.set("parentOrigin", window.location.origin);
      popupUrl = `${helperOrigin}/smart-card-helper?${params.toString()}`;
    }
    const popup = window.open(
      popupUrl,
      "pms-group-thai-card-reader",
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
      groupId,
      eventName: "parent_popup_opened",
      message: "Opened smart card popup for group wizard",
      metadata: {
        flow: window.location.protocol === "https:" ? "helper" : "local_popup",
        popup_url: popupUrl,
      },
    });
    popup.focus();
  }

  function openPassportOcr() {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams({ popup: "1", target: "main", t: String(Date.now()) });
    const popup = window.open(
      `${window.location.origin}/passport-ocr?${params.toString()}`,
      "pms-group-passport-ocr",
      "popup=yes,width=1180,height=860,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes"
    );
    if (!popup) {
      setError("Popup blocked. Please allow popups and try again.");
      return;
    }
    popup.focus();
  }

  useEffect(() => {
    const handleSmartCardResult = (data: {
      type?: string;
      payload?: ThaiCardImportPayload | PassportOcrImportPayload;
      endpoint?: string;
      requestId?: string;
    } | null, eventSource?: MessageEventSource | null, eventOrigin?: string) => {
      if (!data?.type) return;
      if (data.type === "PMS_THAI_CARD_WS_ENDPOINT" && data.endpoint) {
        traceSmartCardUiEvent({
          requestId: data.requestId ?? thaiCardRequestIdRef.current,
          groupId,
          eventName: "parent_ws_endpoint_received",
          message: "Group wizard received smart card websocket endpoint",
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
          groupId,
          eventName: "parent_confirm_ignored_duplicate",
          message: `Ignored duplicate ${data.type}`,
          metadata: {
            source: eventOrigin ? "postMessage" : "broadcast_channel",
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
        groupId,
        eventName: "parent_confirm_received",
        message: `Group wizard received ${data.type}`,
        metadata: {
          source: eventOrigin ? "postMessage" : "broadcast_channel",
        },
      });

      setStep2Busy(true);
      setError("");
      setInfo("");
      void (async () => {
        try {
          if (data.type === "PMS_THAI_CARD_CONFIRMED") {
            if (eventOrigin) {
              notifyPopupToClose(eventSource ?? null, eventOrigin);
            }
            traceSmartCardUiEvent({
              requestId: data.requestId ?? thaiCardRequestIdRef.current,
              groupId,
              eventName: "parent_force_close_sent",
              message: "Group wizard requested popup close",
            });
            forceClosePopup(thaiCardPopupRef.current, data.requestId || thaiCardRequestIdRef.current);
            thaiCardPopupRef.current = null;
            thaiCardRequestIdRef.current = null;
            traceSmartCardUiEvent({
              requestId: data.requestId ?? null,
              groupId,
              eventName: "parent_ingest_started",
              message: "Group wizard starting Thai card ingest",
            });
            const item = await ingestIdentityToPool({
              source: "thai_id",
              payload: data.payload as Record<string, unknown>,
            });
            setInfo(`Added ${guestDisplayName(item)} to scan pool from Thai ID.`);
          } else {
            const item = await ingestIdentityToPool({
              source: "passport_ocr",
              payload: data.payload as Record<string, unknown>,
            });
            setInfo(`Added ${guestDisplayName(item)} to scan pool from Passport OCR.`);
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to ingest scanned identity.");
        } finally {
          setStep2Busy(false);
        }
      })();
    };

    const onMessage = (event: MessageEvent) => {
      const savedWs = typeof window !== "undefined" ? window.localStorage.getItem("pms.smartcard.wsEndpoint") : "";
      const allowedOrigins = new Set([window.location.origin, "http://127.0.0.1:3001", "http://localhost:3001"]);
      if (savedWs) {
        try {
          const wsUrl = new URL(savedWs);
          allowedOrigins.add(`${wsUrl.protocol === "wss:" ? "https:" : "http:"}//${wsUrl.host}`);
        } catch {
          // ignore invalid saved endpoint
        }
      }
      if (!allowedOrigins.has(event.origin)) return;
      handleSmartCardResult(event.data as {
        type?: string;
        payload?: ThaiCardImportPayload | PassportOcrImportPayload;
        endpoint?: string;
        requestId?: string;
      } | null, event.source, event.origin);
    };

    let smartCardChannel: BroadcastChannel | null = null;
    if (typeof window !== "undefined" && typeof window.BroadcastChannel !== "undefined") {
      smartCardChannel = new window.BroadcastChannel("pms-smart-card");
      smartCardChannel.onmessage = (event) => {
        handleSmartCardResult(event.data as {
          type?: string;
          payload?: ThaiCardImportPayload | PassportOcrImportPayload;
          endpoint?: string;
          requestId?: string;
        } | null);
      };
    }

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      smartCardChannel?.close();
    };
  }, [groupId]);

  async function searchGuestProfiles() {
    const query = guestQuery.trim();
    if (query.length < 3) {
      setSearchError("Enter at least 3 characters to search guests.");
      setSearchResults([]);
      return;
    }

    setSearchingGuests(true);
    setSearchError("");
    try {
      const response = await fetch(`/api/guests?q=${encodeURIComponent(query)}&limit=20`, {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || "Guest search failed.");
      }
      const profiles: GuestSearchResult[] = Array.isArray(data?.profiles)
        ? data.profiles.map((row: any) => ({
          id: String(row.id),
          first_name: row.first_name ? String(row.first_name) : null,
          last_name: row.last_name ? String(row.last_name) : null,
          phone: row.phone ? String(row.phone) : null,
          member_no: row.member_no ? String(row.member_no) : null,
          profile_status: row.profile_status ? String(row.profile_status) : null,
          nationality_code: row.nationality_code ? String(row.nationality_code) : null,
        }))
        : [];
      setSearchResults(profiles);
      if (profiles.length === 0) {
        setSearchError("No guest profiles found.");
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Guest search failed.");
      setSearchResults([]);
    } finally {
      setSearchingGuests(false);
    }
  }

  async function addGuestToPool(guest: GuestSearchResult) {
    setStep2Busy(true);
    setError("");
    setInfo("");
    try {
      const item = await ingestIdentityToPool({
        source: "search",
        guestProfileId: guest.id,
      });
      setInfo(`Added ${guestDisplayName(item)} to scan pool.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add guest to pool.");
    } finally {
      setStep2Busy(false);
    }
  }

  function removeGuestFromPool(guestProfileId: string) {
    setScannedGuestPool((prev) => prev.filter((guest) => guest.id !== guestProfileId));
  }

  async function postStep2(path: string, payload: Record<string, unknown>) {
    const response = await fetch(`/api/booking-groups/${groupId}/checkin-wizard/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || "Step 2 action failed.");
    }
    return data;
  }

  async function handleAssignGuest(guest: GuestSearchResult) {
    await handleAssignGuestWithRole(guest, targetRole);
  }

  async function handleAssignGuestWithRole(
    guest: Pick<GuestSearchResult, "id">,
    role: "primary" | "accompanying"
  ) {
    if (!targetReservationId) {
      setError("Select a room before assigning guest.");
      return;
    }
    if (!selectedReservationIds.includes(targetReservationId)) {
      setError("Selected room is outside Step 1 scope.");
      return;
    }

    setStep2Busy(true);
    setError("");
    setInfo("");
    try {
      if (role === "primary") {
        await postStep2("step2/link-primary", {
          reservation_id: targetReservationId,
          guest_profile_id: guest.id,
        });
      } else {
        await postStep2("step2/add-accompanying", {
          reservation_id: targetReservationId,
          guest_profile_id: guest.id,
        });
      }
      let preservedPool = scannedGuestPool;
      if (!preservedPool.some((item) => item.id === guest.id)) {
        const item = await ingestIdentityToPool({
          source: "search",
          guestProfileId: guest.id,
        });
        preservedPool = upsertScannedPoolItem(preservedPool, item);
      }
      await reloadReservationSnapshot({ preserveScannedPool: preservedPool });
      setInfo(
        `${role === "primary" ? "Primary linked" : "Accompanying added"} for room ${selectedReservations.find((row) => row.id === targetReservationId)?.room_number ?? targetReservationId
        }.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Guest assignment failed.");
    } finally {
      setStep2Busy(false);
    }
  }

  async function handleRemoveAccompanying(reservationId: string, guestProfileId: string) {
    setStep2Busy(true);
    setError("");
    setInfo("");
    try {
      await postStep2("step2/remove-accompanying", {
        reservation_id: reservationId,
        guest_profile_id: guestProfileId,
      });
      await reloadReservationSnapshot();
      setInfo("Accompanying guest removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove accompanying failed.");
    } finally {
      setStep2Busy(false);
    }
  }

  async function returnPrimaryToPool(reservationId: string, guestProfileId: string) {
    setStep2Busy(true);
    setError("");
    setInfo("");
    try {
      const unlinkRes = await fetch(`/api/bookings/${reservationId}/guest-profile`, {
        method: "DELETE",
      });
      const unlinkData = await unlinkRes.json().catch(() => null);
      if (!unlinkRes.ok || !unlinkData?.success) {
        throw new Error(unlinkData?.error || "Failed to remove primary guest.");
      }

      const restoredItem = await ingestIdentityToPool({
        source: "search",
        guestProfileId,
      });
      await reloadReservationSnapshot({
        preserveScannedPool: upsertScannedPoolItem(scannedGuestPool, restoredItem),
      });
      setInfo("Primary guest moved back to pool.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move primary guest back to pool.");
    } finally {
      setStep2Busy(false);
    }
  }

  async function returnAccompanyingToPool(reservationId: string, guestProfileId: string) {
    setStep2Busy(true);
    setError("");
    setInfo("");
    try {
      await postStep2("step2/remove-accompanying", {
        reservation_id: reservationId,
        guest_profile_id: guestProfileId,
      });
      const restoredItem = await ingestIdentityToPool({
        source: "search",
        guestProfileId,
      });
      await reloadReservationSnapshot({
        preserveScannedPool: upsertScannedPoolItem(scannedGuestPool, restoredItem),
      });
      setInfo("Accompanying guest moved back to pool.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move accompanying guest back to pool.");
    } finally {
      setStep2Busy(false);
    }
  }

  async function handleAutoDistribute() {
    if (scannedGuestPool.length === 0) {
      setError("Add at least one guest to scanned pool before auto-distribute.");
      return;
    }
    if (selectedReservationIds.length === 0) {
      setError("No selected rooms for distribution.");
      return;
    }

    setStep2Busy(true);
    setError("");
    setInfo("");
    try {
      const response = await fetch(`/api/booking-groups/${groupId}/checkin-wizard/auto-distribute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_date: businessDate,
          strategy: "match_main_then_equal_split",
          selected_reservation_ids: selectedReservationIds,
          guest_profile_ids: scannedGuestPool.map((guest) => guest.id),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || "Auto-distribute failed.");
      }

      const previewRows = Array.isArray(data?.distribution_preview) ? data.distribution_preview : [];
      const state = new Map<
        string,
        { primary_guest_profile_id: string | null; accompanying_guest_profile_ids: string[] }
      >();
      selectedReservations.forEach((row) => {
        state.set(row.id, {
          primary_guest_profile_id: row.primary_guest_profile_id,
          accompanying_guest_profile_ids: [...row.accompanying_guest_profile_ids],
        });
      });

      let changed = 0;
      for (const preview of previewRows) {
        const reservationId = String(preview?.reservation_id ?? "");
        if (!reservationId || !state.has(reservationId)) continue;

        const current = state.get(reservationId)!;
        const targetPrimary = preview?.primary_guest_profile_id
          ? String(preview.primary_guest_profile_id)
          : null;
        const targetAccompanying = Array.isArray(preview?.accompanying_guest_profile_ids)
          ? preview.accompanying_guest_profile_ids.map((value: unknown) => String(value))
          : [];

        if (targetPrimary && targetPrimary !== current.primary_guest_profile_id) {
          const noteLine =
            typeof preview?.suggested_note_line === "string" && preview.suggested_note_line.trim()
              ? preview.suggested_note_line.trim()
              : null;
          await postStep2("step2/link-primary", {
            reservation_id: reservationId,
            guest_profile_id: targetPrimary,
            note_line: noteLine,
          });
          current.primary_guest_profile_id = targetPrimary;
          changed += 1;
        } else if (!targetPrimary && current.primary_guest_profile_id) {
          const unlinkRes = await fetch(`/api/bookings/${reservationId}/guest-profile`, {
            method: "DELETE",
          });
          const unlinkData = await unlinkRes.json().catch(() => null);
          if (!unlinkRes.ok || !unlinkData?.success) {
            throw new Error(unlinkData?.error || "Failed to rebuild primary guest assignment.");
          }
          current.primary_guest_profile_id = null;
          changed += 1;
        }

        const toRemove = current.accompanying_guest_profile_ids.filter(
          (guestId) => !targetAccompanying.includes(guestId)
        );
        for (const guestId of toRemove) {
          await postStep2("step2/remove-accompanying", {
            reservation_id: reservationId,
            guest_profile_id: guestId,
          });
          current.accompanying_guest_profile_ids = current.accompanying_guest_profile_ids.filter(
            (value) => value !== guestId
          );
          changed += 1;
        }

        for (let i = 0; i < targetAccompanying.length; i += 1) {
          const guestId = targetAccompanying[i];
          if (current.accompanying_guest_profile_ids.includes(guestId)) continue;
          await postStep2("step2/add-accompanying", {
            reservation_id: reservationId,
            guest_profile_id: guestId,
            display_order: i + 2,
          });
          current.accompanying_guest_profile_ids.push(guestId);
          changed += 1;
        }
      }

      await reloadReservationSnapshot();

      const warnings = Array.isArray(data?.warnings) ? data.warnings : [];
      const stats = data?.distribution_stats && typeof data.distribution_stats === "object"
        ? data.distribution_stats
        : null;
      const unassignedCount = Array.isArray(data?.unassigned_pool) ? data.unassigned_pool.length : 0;
      const summary = [
        `Auto-distribute applied ${changed} change(s).`,
        stats && Number.isFinite(Number(stats?.matched_main_count))
          ? `Matched main: ${Number(stats.matched_main_count)}.`
          : "",
        unassignedCount > 0 ? `${unassignedCount} guest(s) remain unassigned.` : "All scanned guests allocated.",
        warnings.length > 0 ? `${warnings.length} warning(s).` : "",
      ]
        .filter(Boolean)
        .join(" ");
      setInfo(summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auto-distribute failed.");
    } finally {
      setStep2Busy(false);
    }
  }

  async function handlePreviewPayments() {
    setLoadingPaymentPreview(true);
    setError("");
    try {
      const { pricingChanged } = await refreshPricingSnapshot({ syncDefaultPlans: true });
      if (pricingChanged) {
        throw new Error("Booking price changed while Group Check-in was open. Step 3 has been refreshed. Please review payment amounts and preview again.");
      }

      const response = await fetch(`/api/booking-groups/${groupId}/checkin-wizard/preview-payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_date: businessDate,
          selected_reservation_ids: selectedReservationIds,
          payment_mode: paymentMode,
          split_payment_plan: selectedReservations.map((row) => {
            const plan = splitPlans[row.id] ?? {
              ...defaultSplitPlanByDeposit(row),
              payments: [] as SplitPaymentDraft[],
            };
            return {
              reservation_id: row.id,
              deposit_method: plan.deposit_method,
              deposit_amount: toMoney(plan.deposit_amount),
              deposit_note: plan.deposit_note.trim() || null,
              payments: plan.payments
                .map((payment) => ({
                  amount: toMoney(payment.amount),
                  method: payment.method,
                  note: payment.note.trim() || null,
                }))
                .filter((payment) => payment.amount > 0),
            };
          }),
          master_payment_plan: masterPayments
            .map((line) => ({
              amount: toMoney(line.amount),
              method: line.method,
              note: line.note.trim() || null,
            }))
            .filter((line) => line.amount > 0),
          master_deposit: {
            amount: toMoney(masterDeposit.amount),
            method: masterDeposit.method,
            note: masterDeposit.note.trim() || null,
          },
        }),
      });

      const data = await response.json();
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || "Preview payments failed.");
      }
      setPaymentPreview({
        payment_mode: data.payment_mode === "master" ? "master" : "split",
        grand_total: toMoney(data.grand_total),
        payment_received: toMoney(data.payment_received),
        deposit_received: toMoney(data.deposit_received),
        remaining_balance: toMoney(data.remaining_balance),
        submitted_payment_total: toMoney(data.submitted_payment_total),
        projected_remaining_balance: toMoney(data.projected_remaining_balance),
        overpayment_amount: toMoney(data.overpayment_amount),
        room_rows: Array.isArray(data.room_rows)
          ? data.room_rows.map((row: any) => ({
            reservation_id: String(row.reservation_id),
            booking_code: String(row.booking_code ?? ""),
            guest_name: row.guest_name ? String(row.guest_name) : null,
            total_price: toMoney(row.total_price),
            payment_received: toMoney(row.payment_received),
            deposit_received: toMoney(row.deposit_received),
            remaining_balance: toMoney(row.remaining_balance),
            planned_payment: toMoney(row.planned_payment),
            projected_remaining: toMoney(row.projected_remaining),
          }))
          : [],
        allocation_preview: Array.isArray(data.allocation_preview)
          ? data.allocation_preview.map((line: any) => ({
            line_index: Number(line?.line_index ?? 0),
            method: String(line?.method ?? ""),
            amount: toMoney(line?.amount),
            allocations: Array.isArray(line?.allocations)
              ? line.allocations.map((row: any) => ({
                reservation_id: String(row?.reservation_id ?? ""),
                booking_code: String(row?.booking_code ?? ""),
                allocated_amount: toMoney(row?.allocated_amount),
              }))
              : [],
          }))
          : [],
        validation_errors: Array.isArray(data.validation_errors)
          ? data.validation_errors.map((value: unknown) => String(value))
          : [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview payments failed.");
    } finally {
      setLoadingPaymentPreview(false);
    }
  }

  async function handleConfirm() {
    setBusy(true);
    setError("");
    setInfo("");
    setConfirmResults(null);

    try {
      const { pricingChanged } = await refreshPricingSnapshot({ syncDefaultPlans: true });
      if (pricingChanged) {
        throw new Error("Booking price changed while Group Check-in was open. Step 3 has been refreshed. Please review all payment lines before confirming.");
      }

      const splitPaymentPlan = selectedReservations.map((row) => {
        const plan = splitPlans[row.id] ?? {
          ...defaultSplitPlanByDeposit(row),
          payments: [] as SplitPaymentDraft[],
        };

        return {
          reservation_id: row.id,
          deposit_method: plan.deposit_method,
          deposit_amount: toMoney(plan.deposit_amount),
          deposit_note: plan.deposit_note.trim() || null,
          payments: plan.payments
            .map((payment) => ({
              amount: toMoney(payment.amount),
              method: payment.method,
              note: payment.note.trim() || null,
            }))
            .filter((payment) => payment.amount > 0),
        };
      });

      const masterPaymentPlan = masterPayments
        .map((line) => ({
          amount: toMoney(line.amount),
          method: line.method,
          note: line.note.trim() || null,
        }))
        .filter((line) => line.amount > 0);

      const masterDepositPlan = {
        amount: toMoney(masterDeposit.amount),
        method: masterDeposit.method,
        note: masterDeposit.note.trim() || null,
      };

      const response = await fetch(`/api/booking-groups/${groupId}/checkin-wizard/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_date: businessDate,
          strict_due_in: true,
          selected_reservation_ids: selectedReservations.map((row) => row.id),
          payment_mode: paymentMode,
          split_payment_plan: splitPaymentPlan,
          master_payment_plan: paymentMode === "master" ? masterPaymentPlan : undefined,
          master_deposit: paymentMode === "master" ? masterDepositPlan : undefined,
        }),
      });

      const data = await response.json();
      if (!response.ok || !data?.results) {
        throw new Error(data?.error || "Confirm check-in failed.");
      }

      const results: ConfirmRoomResult[] = Array.isArray(data.results)
        ? data.results.map((row: any) => ({
          reservation_id: String(row.reservation_id),
          booking_code: row.booking_code ? String(row.booking_code) : null,
          guest_name: row.guest_name ? String(row.guest_name) : null,
          status: row.status,
          codes: Array.isArray(row.codes) ? row.codes.map((code: unknown) => String(code)) : [],
          error: row.error ? String(row.error) : undefined,
          missing_fields: Array.isArray(row.missing_fields)
            ? row.missing_fields.map((field: unknown) => String(field))
            : undefined,
          checked_in_at: row.checked_in_at ? String(row.checked_in_at) : undefined,
        }))
        : [];

      setConfirmResults(results);
      const okCount = results.filter((row) => row.status === "ok").length;
      const failedCount = results.filter((row) => row.status === "failed").length;
      const skippedCount = results.filter((row) => row.status === "skipped").length;
      setInfo(`Check-in completed: ${okCount} success, ${failedCount} failed, ${skippedCount} skipped.`);

      if (failedCount === 0) {
        router.push(backHref);
        return;
      }

      await reloadReservationSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Confirm check-in failed.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--bg-body)] flex items-center justify-center text-[var(--text-secondary)]">
        Loading group check-in wizard...
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg-body)] dark:bg-[#0B0E14]">
      <header className="bg-[var(--bg-surface)] dark:bg-[#0B0E14] border-b border-[var(--border-default)] dark:border-[#1E2530] px-6 py-4 flex items-center justify-between sticky top-0 z-20 shadow-sm">
        <div>
          <div className="flex items-center gap-3">
            <Link href={backHref} className="text-[var(--text-secondary)] hover:text-indigo-700 text-sm font-semibold">
              Back to Group Detail
            </Link>
            <span className="text-[var(--text-muted)]">|</span>
            <h1 className="text-xl font-bold text-[var(--text-primary)]">Group Check-in Wizard</h1>
          </div>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            <span className="font-semibold text-indigo-700">{groupData?.group_code || "—"}</span>
            <span className="mx-2">·</span>
            <span>{groupData?.group_name || "Group"}</span>
            {businessDate ? <span className="ml-2">({businessDate})</span> : null}
            {Object.keys(wizardDraftJson).length > 0 ? (
              <span className="ml-2 text-emerald-700 font-semibold">Draft loaded</span>
            ) : null}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {[1, 2, 3, 4].map((step) => (
            <div key={step} className="flex items-center gap-2">
              <div className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-bold ${currentStep === step ? "bg-indigo-600 text-white" : currentStep > step ? "bg-emerald-500 text-white" : "bg-[var(--bg-muted)] text-[var(--text-secondary)]"}`}>
                {currentStep > step ? "✓" : step}
              </div>
              {step < 4 ? <div className={`h-0.5 w-6 ${currentStep > step ? "bg-emerald-500" : "bg-[var(--bg-muted)]"}`} /> : null}
            </div>
          ))}
        </div>
      </header>

      <main className="flex-1 p-6 overflow-y-auto">
        <div className="mx-auto max-w-[1760px] bg-[var(--bg-surface)] dark:bg-[#151921] rounded-xl border border-[var(--border-default)] dark:border-[#2D333D] shadow-sm p-6">
          {error ? <div className="mb-4 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div> : null}
          {info ? <div className="mb-4 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{info}</div> : null}

          {currentStep === 1 ? (
            <div className="space-y-4">
              <div className="flex items-end justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-[var(--text-primary)]">Step 1 — Select Rooms</h2>
                  <p className="text-sm text-[var(--text-secondary)]">Choose rooms to include in this check-in run.</p>
                  <p className="text-xs text-[var(--text-secondary)] mt-1">
                    Linked reservations with a different due-in date stay linked, but must be checked in separately on their own due-in day.
                  </p>
                </div>
                <div className="text-sm text-[var(--text-secondary)] font-semibold">
                  {selectedReservations.length} selected / {eligibleStep1Rows.length} eligible
                </div>
              </div>

              <div className="overflow-auto border border-[var(--border-default)] dark:border-[#2D333D] rounded-xl">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--bg-body)] dark:bg-[#0B0E14] border-b border-[var(--border-default)] dark:border-[#2D333D]">
                    <tr>
                      <th className="p-3 w-10 text-left">
                        <input
                          type="checkbox"
                          checked={selectedReservations.length > 0 && selectedReservations.length === eligibleStep1Rows.length}
                          onChange={(e) => toggleAll(e.target.checked)}
                        />
                      </th>
                      <th className="p-3 text-left">Booking</th>
                      <th className="p-3 text-left">Room</th>
                      <th className="p-3 text-left">Guest</th>
                      <th className="p-3 text-left">HK</th>
                      <th className="p-3 text-left">Profile</th>
                    </tr>
                  </thead>
                  <tbody>
                    {step1Eligibility.map(({ row, reasons, isDueToday, selectable }) => {
                      const disabled = !selectable;
                      const hk = mapHkBadge(row.hk_status);
                      const showDueDateWarning = reasons.includes("not_due_in_today");
                      const rowWarning = showDueDateWarning
                        ? `Separate check-in on ${formatDateDisplay(row.checkin_date)}`
                        : null;
                      return (
                        <tr
                          key={row.id}
                          className={`border-t border-[var(--border-subtle)] dark:border-[#1E2530] ${
                            showDueDateWarning
                              ? "bg-rose-50/80 dark:bg-rose-900/10"
                              : row.selected
                                ? "bg-indigo-50/50 dark:bg-slate-700/40"
                                : ""
                          } ${disabled ? "opacity-80" : "hover:bg-[var(--bg-body)] dark:hover:bg-slate-800/30 transition-colors"}`}
                          onClick={() => {
                            if (!disabled) toggleSelection(row.id);
                          }}
                        >
                          <td className="p-3">
                            <input
                              type="checkbox"
                              checked={row.selected}
                              disabled={disabled}
                              onChange={() => undefined}
                            />
                          </td>
                          <td className="p-3 font-semibold text-[var(--text-table-cell)]">{row.booking_code}</td>
                          <td className="p-3">
                            <div className="font-semibold text-[var(--text-primary)]">{row.room_number}</div>
                            <div className="text-xs text-[var(--text-secondary)]">{row.room_type}</div>
                            {showDueDateWarning ? (
                              <div className="mt-1 text-[11px] font-semibold text-rose-700">
                                Due-in {formatDateDisplay(row.checkin_date)}
                              </div>
                            ) : null}
                          </td>
                          <td className="p-3 text-[var(--text-table-cell)]">{row.guest_name || "—"}</td>
                          <td className="p-3">
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${hk.className}`}>{hk.label}</span>
                          </td>
                          <td className="p-3">
                            {row.profile_completeness.is_complete ? (
                              <span className="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">Complete</span>
                            ) : (
                              <span className="text-xs font-semibold px-2 py-0.5 rounded bg-amber-100 text-amber-700">Incomplete</span>
                            )}
                            {rowWarning ? (
                              <div className="mt-2">
                                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-rose-100 text-rose-700">
                                  {rowWarning}
                                </span>
                              </div>
                            ) : null}
                            {!rowWarning && !isDueToday && row.checkin_date ? (
                              <div className="mt-2 text-xs text-[var(--text-secondary)]">
                                Due-in {formatDateDisplay(row.checkin_date)}
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {currentStep === 2 ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">Step 2 — Guest Assignment</h2>
                <p className="text-sm text-[var(--text-secondary)]">Search/scan guest pool, assign primary or accompanying immediately, then auto-distribute by booking order.</p>
                <p className="text-xs text-[var(--text-secondary)] mt-1">
                  Manual profile entry is currently per booking. Use <span className="font-semibold">Manual (per booking)</span> to open reservation editor.
                </p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-7 border border-[var(--border-default)] rounded-xl p-4 bg-[var(--bg-surface)] space-y-3">

                  {/* --- Phase 50 Mobile Scans Panel --- */}
                  <div className="bg-violet-50/50 dark:bg-violet-900/10 border border-violet-200 dark:border-violet-800 rounded-xl p-3 mb-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-violet-900 dark:text-violet-100 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-violet-500 animate-pulse"></span>
                        Mobile Scans (Auto)
                      </h3>
                      {filteredMobileScans.some(s => s.pool_status === "ready") && (
                        <button
                          className="text-xs font-bold bg-violet-600 text-white px-3 py-1.5 rounded-lg active:scale-95 transition-all"
                          onClick={importAllReadyScans}
                          disabled={isImportingAll || step2Busy}
                        >
                          {isImportingAll ? "Importing..." : "Import All Ready"}
                        </button>
                      )}
                    </div>
                    {filteredMobileScans.length === 0 ? (
                      <p className="text-xs text-violet-700/60 dark:text-violet-300/60 font-medium">รอการสแกนจากโทรศัพท์...</p>
                    ) : (
                      <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                        {filteredMobileScans.map((scan, i) => (
                          <div key={scan.scan_id + i} className="flex items-center justify-between bg-white dark:bg-[#1a1c23] border border-violet-100 dark:border-violet-900/50 p-2 rounded-lg text-sm shadow-sm">
                            <div>
                              {scan.pool_status === "ocr_failed" ? (
                                <div className="font-bold text-rose-600 dark:text-rose-400">Failed Scan</div>
                              ) : (
                                <div className="font-semibold text-violet-900 dark:text-violet-100">{scan.display_name}</div>
                              )}
                              <div className="text-xs text-violet-600/70 dark:text-violet-400/70 mt-0.5">
                                {scan.pool_status === "ocr_failed" ? "รอการแก้ข้อมูลรูปถ่าย" : `${scan.passport_no || "—"} · ${scan.nationality_code || "—"}`}
                              </div>
                            </div>
                            <div>
                              {scan.pool_status === "ready" ? (
                                <button
                                  onClick={() => importSingleScan(scan)}
                                  disabled={step2Busy || isImportingAll}
                                  className="text-xs font-bold bg-violet-100 dark:bg-violet-900/40 hover:bg-violet-200 text-violet-700 dark:text-violet-300 px-3 py-1.5 rounded"
                                >
                                  Import
                                </button>
                              ) : scan.pool_status === "ocr_failed" ? (
                                <button
                                  onClick={() => setShowFailedModal({ scanId: scan.scan_id, imagePath: scan.image_path })}
                                  className="text-xs font-bold bg-rose-100 dark:bg-rose-900/40 hover:bg-rose-200 text-rose-700 dark:text-rose-300 px-3 py-1.5 rounded"
                                >
                                  View Photo
                                </button>
                              ) : (
                                <span className="text-xs font-bold text-amber-600 bg-amber-100 px-2 py-1 rounded">Processing</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* --------------------------------- */}

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-[var(--text-primary)]">Scan Pool</h3>
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                        {scannedGuestPool.length} guest{scannedGuestPool.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={handleAutoDistribute}
                      disabled={step2Busy || scannedGuestPool.length === 0 || selectedReservations.length === 0}
                    >
                      {step2Busy ? "Applying..." : "Auto-assign"}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button type="button" className="btn btn-secondary" onClick={openThaiCardReader} disabled={step2Busy}>
                      Read Thai ID
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={openPassportOcr} disabled={step2Busy}>
                      Passport OCR
                    </button>
                  </div>

                  <p className="text-xs text-[var(--text-secondary)]">
                    Strategy: rebuild all assignments in selected scope, match main by profile id first, then equal split by room.
                  </p>

                  <div className="border border-[var(--border-default)] rounded-lg max-h-80 overflow-auto bg-[var(--bg-body)]">
                    {scannedGuestPool.length === 0 ? (
                      <div className="px-3 py-4 text-sm text-[var(--text-secondary)]">No identities in pool yet.</div>
                    ) : (
                      <div className="divide-y divide-[var(--border-subtle)]">
                        {scannedGuestPool.map((guest) => (
                          <div key={guest.id} className="px-3 py-2 flex items-center justify-between gap-2 bg-[var(--bg-surface)]">
                            <div>
                              <div className="text-sm font-medium text-[var(--text-primary)]">{guestDisplayName(guest)}</div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                                <span className={`inline-flex rounded px-1.5 py-0.5 font-semibold ${scanSourceBadgeClass(guest.source)}`}>
                                  {scanSourceLabel(guest.source)}
                                </span>
                                <span>{guest.profile_status || "draft"}</span>
                                {selectedAssignedGuestIds.has(guest.id) ? <span>· assigned</span> : null}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                className="btn btn-secondary text-xs"
                                type="button"
                                onClick={() => { void handleAssignGuestWithRole(guest, "primary"); }}
                                disabled={step2Busy || !targetReservationId}
                              >
                                Add Main
                              </button>
                              <button
                                className="btn btn-secondary text-xs"
                                type="button"
                                onClick={() => { void handleAssignGuestWithRole(guest, "accompanying"); }}
                                disabled={step2Busy || !targetReservationId}
                              >
                                Add Acc.
                              </button>
                              <button
                                className="btn btn-ghost"
                                type="button"
                                onClick={() => removeGuestFromPool(guest.id)}
                                disabled={step2Busy}
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="lg:col-span-5 border border-[var(--border-default)] rounded-xl p-4 bg-[var(--bg-body)] space-y-3">
                  <h3 className="font-semibold text-[var(--text-primary)]">Manual Assign</h3>
                  <div className="flex flex-col gap-2">
                    <input
                      className="form-input"
                      placeholder="Search name / phone / passport / ID..."
                      value={guestQuery}
                      onChange={(event) => setGuestQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") searchGuestProfiles();
                      }}
                    />
                    <button className="btn btn-secondary" onClick={searchGuestProfiles} disabled={searchingGuests || step2Busy}>
                      {searchingGuests ? "Searching..." : "Search"}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-2">
                    <div>
                      <label className="form-label text-xs">Target Room</label>
                      <select
                        className="form-select"
                        value={targetReservationId}
                        onChange={(event) => setTargetReservationId(event.target.value)}
                      >
                        {selectedReservations.map((row) => (
                          <option key={row.id} value={row.id}>
                            {row.booking_code} · Room {row.room_number}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="form-label text-xs">Assign As</label>
                      <select
                        className="form-select"
                        value={targetRole}
                        onChange={(event) => setTargetRole(event.target.value as "primary" | "accompanying")}
                      >
                        <option value="primary">Primary Guest</option>
                        <option value="accompanying">Accompanying Guest</option>
                      </select>
                    </div>
                  </div>

                  {searchError ? (
                    <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">{searchError}</div>
                  ) : null}

                  <div className="border border-[var(--border-default)] dark:border-[#2D333D] rounded-lg bg-[var(--bg-surface)] dark:bg-[#0B0E14] max-h-80 overflow-auto">
                    {searchResults.length === 0 ? (
                      <div className="px-3 py-4 text-sm text-[var(--text-secondary)]">No search result yet.</div>
                    ) : (
                      <div className="divide-y divide-[var(--border-subtle)]">
                        {searchResults.map((guest) => {
                          const assigned = selectedAssignedGuestIds.has(guest.id);
                          const inPool = scannedGuestPool.some((item) => item.id === guest.id);
                          return (
                            <div key={guest.id} className="px-3 py-2 flex items-center justify-between gap-3">
                              <div>
                                <div className="text-sm font-semibold text-[var(--text-primary)]">{guestDisplayName(guest)}</div>
                                <div className="text-xs text-[var(--text-secondary)]">
                                  {guest.phone ? `Phone: ${guest.phone}` : "No phone"}
                                  {guest.profile_status ? ` · ${guest.profile_status}` : ""}
                                  {guest.member_no ? ` · #${guest.member_no}` : ""}
                                </div>
                                {assigned ? (
                                  <div className="text-[11px] text-indigo-700 font-semibold">Already assigned in selected scope</div>
                                ) : null}
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  className="btn btn-ghost"
                                  type="button"
                                  onClick={() => { void addGuestToPool(guest); }}
                                  disabled={inPool || step2Busy}
                                >
                                  {inPool ? "In Pool" : "Send to Pool"}
                                </button>
                                <button
                                  className="btn btn-primary"
                                  type="button"
                                  onClick={() => handleAssignGuest(guest)}
                                  disabled={step2Busy || !targetReservationId}
                                >
                                  Assign
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                {selectedReservations.map((row) => (
                  <div
                    key={row.id}
                    className={`border rounded-lg p-4 transition-colors ${targetReservationId === row.id
                        ? "border-indigo-300 bg-indigo-50/40 dark:bg-slate-700/40 dark:border-indigo-500/50"
                        : "border-[var(--border-default)] bg-[var(--bg-body)] dark:bg-[#151921] dark:border-[#2D333D]"
                      }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-semibold text-[var(--text-primary)]">
                          Room {row.room_number} · {row.booking_code}
                        </div>
                        <div className="text-xs text-[var(--text-secondary)]">
                          {row.party.primary ? "Primary linked" : "Primary not linked"}
                          {" · "}
                          {row.party.accompanying.length} accompanying
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          className="btn btn-ghost"
                          type="button"
                          onClick={() => setTargetReservationId(row.id)}
                        >
                          Set Target
                        </button>
                        <Link
                          className="btn btn-secondary"
                          href={`/pms/reservations?open=${encodeURIComponent(row.id)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Manual (per booking)
                        </Link>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="rounded border border-[var(--border-default)] dark:border-[#1E2530] bg-[var(--bg-surface)] dark:bg-[#0B0E14] p-3">
                        <div className="text-xs font-semibold text-[var(--text-secondary)] uppercase">Primary</div>
                        {row.party.primary ? (
                          <div className="mt-1">
                            <div className="font-medium text-[var(--text-primary)]">{row.party.primary.display_name}</div>
                            <div className="text-xs text-[var(--text-secondary)]">
                              {row.party.primary.profile_status || "draft"}
                              {row.party.primary.nationality_code ? ` · ${row.party.primary.nationality_code}` : ""}
                            </div>
                            {row.party.primary.completeness.is_complete ? (
                              <span className="inline-flex mt-1 text-xs font-semibold px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">
                                Profile Ready
                              </span>
                            ) : (
                              <div className="mt-1">
                                <span className="inline-flex text-xs font-semibold px-2 py-0.5 rounded bg-amber-100 text-amber-700">
                                  Missing {row.party.primary.completeness.missing_fields.length} field(s)
                                </span>
                                <div className="text-[11px] text-amber-700 mt-1">
                                  {row.party.primary.completeness.missing_fields.join(", ")}
                                </div>
                              </div>
                            )}
                            <div className="mt-2 flex items-center gap-2">
                              <button
                                type="button"
                                className="btn btn-ghost text-xs"
                                onClick={() => setTargetReservationId(row.id)}
                              >
                                Reassign
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost text-xs text-amber-700"
                                onClick={() => row.party.primary && void returnPrimaryToPool(row.id, row.party.primary.guest_profile_id)}
                                disabled={step2Busy}
                              >
                                Return to Pool
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-1 text-sm text-amber-700">No primary guest profile</div>
                        )}
                      </div>

                      <div className="rounded border border-[var(--border-default)] dark:border-[#1E2530] bg-[var(--bg-surface)] dark:bg-[#0B0E14] p-3">
                        <div className="text-xs font-semibold text-[var(--text-secondary)] uppercase mb-2">Accompanying</div>
                        {row.party.accompanying.length === 0 ? (
                          <div className="text-sm text-[var(--text-secondary)]">No accompanying guest</div>
                        ) : (
                          <div className="space-y-2">
                            {row.party.accompanying.map((guest) => (
                              <div key={guest.guest_profile_id} className="flex items-start justify-between gap-2">
                                <div>
                                  <div className="text-sm font-medium text-[var(--text-primary)]">{guest.display_name}</div>
                                  <div className="text-xs text-[var(--text-secondary)]">
                                    {guest.profile_status || "draft"}
                                    {guest.nationality_code ? ` · ${guest.nationality_code}` : ""}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className="btn btn-ghost text-amber-700"
                                  onClick={() => void returnAccompanyingToPool(row.id, guest.guest_profile_id)}
                                  disabled={step2Busy}
                                >
                                  Return to Pool
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-ghost text-rose-600"
                                  onClick={() => handleRemoveAccompanying(row.id, guest.guest_profile_id)}
                                  disabled={step2Busy}
                                >
                                  Remove
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {selectedReservations.length === 0 ? (
                  <div className="text-sm text-[var(--text-secondary)]">No selected rooms. Go back to Step 1.</div>
                ) : null}
              </div>
            </div>
          ) : null}

          {currentStep === 3 ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-[var(--text-primary)]">Step 3 — Payment Plan</h2>
                  <p className="text-sm text-[var(--text-secondary)]">Configure split-by-room or master payment.</p>
                </div>
                <div className="flex items-center bg-[var(--bg-muted)] p-1 rounded-lg border border-[var(--border-default)]">
                  <button
                    className={`px-4 py-1.5 text-sm rounded ${paymentMode === "split" ? "bg-[var(--bg-surface)] text-indigo-700 font-semibold" : "text-[var(--text-secondary)]"}`}
                    onClick={() => setPaymentMode("split")}
                  >
                    Split
                  </button>
                  <button
                    className={`px-4 py-1.5 text-sm rounded ${paymentMode === "master" ? "bg-[var(--bg-surface)] text-indigo-700 font-semibold" : "text-[var(--text-secondary)]"}`}
                    onClick={() => setPaymentMode("master")}
                  >
                    Master
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <div className="rounded-xl border border-[var(--border-default)] dark:border-[#1E2530] bg-[var(--bg-body)] dark:bg-[#0B0E14] px-4 py-3 text-sm text-[var(--text-table-cell)]">
                  <div className="text-xs uppercase tracking-wide text-[var(--text-secondary)]">Current Remaining</div>
                  <div className="font-bold text-lg mt-1 text-[var(--text-primary)]">
                    ฿ {selectedRemainingTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </div>
                </div>
                <div className="rounded-xl border border-indigo-200 dark:border-indigo-500/20 bg-indigo-50 dark:bg-indigo-500/10 px-4 py-3 text-sm text-indigo-800 dark:text-indigo-300">
                  <div className="text-xs uppercase tracking-wide text-indigo-600 dark:text-indigo-400">Planned Payment</div>
                  <div className="font-bold text-lg mt-1">฿ {plannedPaymentTotal.toFixed(2)}</div>
                </div>
                <div className="rounded-xl border border-emerald-200 dark:border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-300">
                  <div className="text-xs uppercase tracking-wide text-emerald-600">Projected Remaining</div>
                  <div className="font-bold text-lg mt-1">฿ {projectedRemainingTotal.toFixed(2)}</div>
                </div>
              </div>

              <div className="flex items-center justify-end">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handlePreviewPayments}
                  disabled={loadingPaymentPreview || busy || selectedReservations.length === 0}
                >
                  {loadingPaymentPreview ? "Previewing..." : "Preview Payments"}
                </button>
              </div>

              {paymentMode === "split" ? (
                <div className="grid grid-cols-1 gap-4 2xl:grid-cols-3 xl:grid-cols-2">
                  {selectedReservations.map((row) => {
                    const plan = splitPlans[row.id] ?? {
                      ...defaultSplitPlanByDeposit(row),
                    };
                    const cardTotals = computeSplitCardTotals(row, plan);
                    const statusTone = paymentStatusTone(cardTotals.projectedRemaining);
                    const cardClass =
                      statusTone === "paid"
                        ? "border-emerald-300 bg-emerald-50/70 dark:border-emerald-500/20 dark:bg-emerald-500/10"
                        : statusTone === "refund"
                          ? "border-amber-300 bg-amber-50/70 dark:border-amber-500/20 dark:bg-amber-500/10"
                          : "border-rose-300 bg-rose-50/70 dark:border-rose-500/20 dark:bg-rose-500/10";
                    return (
                      <div key={row.id} className={`rounded-xl border px-3 py-3 space-y-3 ${cardClass}`}>
                        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-default)] pb-3">
                          <div className="min-w-0">
                            <div className="text-[2rem] font-black tracking-tight text-[var(--text-primary)]">Room {row.room_number}</div>
                            <div className="truncate text-[15px] font-black text-[var(--text-primary)]">{row.guest_name || "—"}</div>
                            <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">{row.booking_code}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--text-secondary)]">Total Due</div>
                            <div className="mt-1 text-[1.35rem] font-black tracking-tight text-[var(--text-primary)]">
                              ฿ {cardTotals.currentDue.toFixed(2)}
                            </div>
                          </div>
                        </div>

                        <div className="space-y-3">
                          <div className="rounded-xl border border-sky-300 bg-sky-100/90 p-3 dark:border-sky-500/30 dark:bg-sky-500/10">
                            <div className="flex items-center justify-between gap-4">
                          <div>
                            <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-300">Room Charge</div>
                            <div className="mt-1 text-[1.35rem] font-black tracking-tight text-sky-950 dark:text-sky-100">
                                  ฿ {toMoney(row.total_price).toFixed(2)}
                            </div>
                          </div>
                              <div className="text-right">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-sky-700 dark:text-sky-300">After Save</div>
                                <div className={`mt-1 text-lg font-black ${cardTotals.projectedRoomRemaining <= 0.009 ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>
                                  ฿ {cardTotals.projectedRoomRemaining.toFixed(2)}
                                </div>
                            </div>
                          </div>

                            <div className="mt-2 grid grid-cols-2 gap-2">
                              <div className="rounded-xl border border-sky-200/80 bg-white/70 px-3 py-2 dark:border-sky-500/20 dark:bg-slate-950/30">
                                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-sky-700 dark:text-sky-300">Prepayment</div>
                                <div className="mt-1 text-base font-black tracking-tight text-[var(--text-primary)]">
                                  ฿ {toMoney(row.total_price - row.remaining_balance).toFixed(2)}
                                </div>
                              </div>
                              <div className="rounded-xl border border-sky-200/80 bg-white/70 px-3 py-2 dark:border-sky-500/20 dark:bg-slate-950/30">
                                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-sky-700 dark:text-sky-300">Due Now</div>
                                <div className="mt-1 text-base font-black tracking-tight text-[var(--text-primary)]">
                                  ฿ {cardTotals.roomRemaining.toFixed(2)}
                                </div>
                              </div>
                            </div>

                            <div className="mt-3 space-y-3">
                              {plan.payments.map((payment, idx) => (
                                <div key={payment.id} className="space-y-2 rounded-xl border border-sky-200/80 bg-white/70 p-2.5 dark:border-sky-500/20 dark:bg-slate-950/30">
                                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                                    <input
                                      type="number"
                                      className="h-10 rounded-xl border border-sky-300 bg-white px-3.5 text-base font-black text-[var(--text-primary)] outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 dark:border-sky-500/30 dark:bg-slate-950"
                                      value={payment.amount}
                                      onChange={(e) => updateSplitPayment(row.id, payment.id, { amount: e.target.value })}
                                      placeholder="Amount"
                                    />
                                    <div className="flex items-center gap-2">
                                      <button
                                        type="button"
                                        className="h-10 min-w-[116px] rounded-xl bg-brand-600 px-3.5 text-[10px] font-black uppercase tracking-[0.14em] text-white shadow-lg shadow-brand-500/20 transition hover:bg-brand-700"
                                      >
                                        Add Payment
                                      </button>
                                      {plan.payments.length > 1 ? (
                                        <button
                                          type="button"
                                          className="h-10 min-w-[40px] rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] text-lg font-black text-rose-600"
                                          onClick={() => removeSplitPayment(row.id, payment.id)}
                                        >
                                          ×
                                        </button>
                                      ) : null}
                                    </div>
                                  </div>
                                  <PaymentMethodButtons
                                    value={payment.method}
                                    onChange={(value) => updateSplitPayment(row.id, payment.id, { method: value })}
                                  />
                                  <input
                                    className="h-10 w-full rounded-xl border border-sky-300 bg-white px-3.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 dark:border-sky-500/30 dark:bg-slate-950"
                                    value={payment.note}
                                    onChange={(e) => updateSplitPayment(row.id, payment.id, { note: e.target.value })}
                                    placeholder={idx === 0 ? "Payment note / Ref ID (optional)" : "Additional payment note"}
                                  />
                                </div>
                              ))}
                              <button
                                type="button"
                                className="w-full rounded-xl border border-dashed border-sky-300 px-3 py-2 text-xs font-black uppercase tracking-[0.16em] text-sky-700 transition hover:bg-sky-50 dark:border-sky-500/30 dark:text-sky-300 dark:hover:bg-sky-500/10"
                                onClick={() => addSplitPayment(row.id)}
                              >
                                Add Another Room Line
                              </button>
                            </div>
                          </div>

                          <div className="rounded-xl border border-amber-300 bg-amber-100/90 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
                            <div className="flex items-center justify-between gap-4">
                              <div>
                                <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-300">Deposit</div>
                                <div className="mt-1 text-[1.35rem] font-black tracking-tight text-amber-950 dark:text-amber-100">
                                  ฿ {cardTotals.depositTarget.toFixed(2)}
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">Separate</div>
                                <div className="mt-1 text-sm font-bold text-amber-800 dark:text-amber-200">Does not reduce room due</div>
                              </div>
                            </div>

                            <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                              <input
                                className="h-10 rounded-xl border border-amber-300 bg-white px-3.5 text-base font-black text-[var(--text-primary)] outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 dark:border-amber-500/30 dark:bg-slate-950"
                                type="number"
                                value={plan.deposit_amount}
                                onChange={(e) => updateSplitPlan(row.id, { deposit_amount: e.target.value })}
                                placeholder="Amount"
                              />
                              <button
                                type="button"
                                className="h-10 min-w-[116px] rounded-xl bg-brand-600 px-3.5 text-[10px] font-black uppercase tracking-[0.14em] text-white shadow-lg shadow-brand-500/20 transition hover:bg-brand-700"
                              >
                                Add Deposit
                              </button>
                            </div>
                            <div className="mt-2">
                              <PaymentMethodButtons
                                value={plan.deposit_method}
                                onChange={(value) => updateSplitPlan(row.id, { deposit_method: value })}
                              />
                            </div>
                            <input
                              className="mt-2 h-10 w-full rounded-xl border border-amber-300 bg-white px-3.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 dark:border-amber-500/30 dark:bg-slate-950"
                              value={plan.deposit_note}
                              onChange={(e) => updateSplitPlan(row.id, { deposit_note: e.target.value })}
                              placeholder="Deposit note / reason if no deposit"
                            />
                          </div>
                        </div>

                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--border-default)] pb-3">
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-[0.24em] text-[var(--text-secondary)]">Master Payment</div>
                      <div className="mt-1 text-2xl font-black tracking-tight text-[var(--text-primary)]">One payment workspace for the whole group</div>
                      <div className="mt-1 text-sm text-[var(--text-secondary)]">
                        Room charges allocate by outstanding balance. Deposit splits evenly across selected rooms.
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-right">
                      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-body)] px-3 py-2">
                        <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--text-secondary)]">Room Due</div>
                        <div className="mt-1 text-lg font-black tracking-tight text-[var(--text-primary)]">฿ {selectedReservations.reduce((sum, row) => sum + toMoney(row.remaining_balance), 0).toFixed(2)}</div>
                      </div>
                      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-body)] px-3 py-2">
                        <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--text-secondary)]">Deposit</div>
                        <div className="mt-1 text-lg font-black tracking-tight text-[var(--text-primary)]">฿ {Math.max(0, toMoney(masterDeposit.amount)).toFixed(2)}</div>
                      </div>
                      <div className={`rounded-xl border px-3 py-2 ${projectedRemainingTotal <= 0.009 ? "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/15 dark:text-emerald-300" : "border-rose-300 bg-rose-100 text-rose-800 dark:border-rose-500/20 dark:bg-rose-500/15 dark:text-rose-300"}`}>
                        <div className="text-[11px] font-bold uppercase tracking-[0.18em]">Result</div>
                        <div className="mt-1 text-lg font-black tracking-tight">
                          {projectedRemainingTotal <= 0.009 ? "Paid" : `Remain ฿ ${projectedRemainingTotal.toFixed(2)}`}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-sky-300 bg-sky-100/90 p-3 dark:border-sky-500/30 dark:bg-sky-500/10">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-sky-700 dark:text-sky-300">Master Room Payment</div>
                        <div className="mt-1 text-[1.35rem] font-black tracking-tight text-sky-950 dark:text-sky-100">
                          ฿ {selectedReservations.reduce((sum, row) => sum + toMoney(row.remaining_balance), 0).toFixed(2)}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="h-10 rounded-xl border border-dashed border-sky-300 px-3.5 text-[10px] font-black uppercase tracking-[0.14em] text-sky-700 transition hover:bg-sky-50 dark:border-sky-500/30 dark:text-sky-300 dark:hover:bg-sky-500/10"
                        onClick={addMasterLine}
                      >
                        Add Line
                      </button>
                    </div>

                    <div className="mt-3 space-y-3">
                      {masterPayments.map((line, idx) => (
                        <div key={line.id} className="space-y-2 rounded-xl border border-sky-200/80 bg-white/70 p-2.5 dark:border-sky-500/20 dark:bg-slate-950/30">
                          <div className="flex items-center justify-between">
                            <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-sky-700 dark:text-sky-300">
                              Line {idx + 1}
                            </div>
                            {masterPayments.length > 1 ? (
                              <button
                                type="button"
                                className="h-8 min-w-[34px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] text-base font-black text-rose-600"
                                onClick={() => removeMasterLine(line.id)}
                              >
                                ×
                              </button>
                            ) : null}
                          </div>
                          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                            <input
                              type="number"
                              className="h-10 rounded-xl border border-sky-300 bg-white px-3.5 text-base font-black text-[var(--text-primary)] outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 dark:border-sky-500/30 dark:bg-slate-950"
                              value={line.amount}
                              onChange={(e) => updateMasterLine(line.id, { amount: e.target.value })}
                              placeholder="Amount"
                            />
                            <button
                              type="button"
                              className="h-10 min-w-[116px] rounded-xl bg-brand-600 px-3.5 text-[10px] font-black uppercase tracking-[0.14em] text-white shadow-lg shadow-brand-500/20 transition hover:bg-brand-700"
                            >
                              Add Payment
                            </button>
                          </div>
                          <PaymentMethodButtons
                            value={line.method}
                            onChange={(value) => updateMasterLine(line.id, { method: value })}
                          />
                          <input
                            className="h-10 w-full rounded-xl border border-sky-300 bg-white px-3.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 dark:border-sky-500/30 dark:bg-slate-950"
                            value={line.note}
                            onChange={(e) => updateMasterLine(line.id, { note: e.target.value })}
                            placeholder="Payment note / Ref ID (optional)"
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-amber-300 bg-amber-100/90 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-amber-700 dark:text-amber-300">Master Deposit</div>
                        <div className="mt-1 text-[1.35rem] font-black tracking-tight text-amber-950 dark:text-amber-100">
                          ฿ {Math.max(0, toMoney(masterDeposit.amount)).toFixed(2)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">Split Evenly</div>
                        <div className="mt-1 text-sm font-bold text-amber-800 dark:text-amber-200">
                          {selectedReservations.length || 0} room(s)
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                      <input
                        type="number"
                        className="h-10 rounded-xl border border-amber-300 bg-white px-3.5 text-base font-black text-[var(--text-primary)] outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 dark:border-amber-500/30 dark:bg-slate-950"
                        value={masterDeposit.amount}
                        onChange={(e) => {
                          setMasterDepositEdited(true);
                          setMasterDeposit((prev) => ({ ...prev, amount: e.target.value }));
                        }}
                        placeholder="Amount"
                      />
                      <button
                        type="button"
                        className="h-10 min-w-[116px] rounded-xl bg-brand-600 px-3.5 text-[10px] font-black uppercase tracking-[0.14em] text-white shadow-lg shadow-brand-500/20 transition hover:bg-brand-700"
                      >
                        Add Deposit
                      </button>
                    </div>
                    <div className="mt-2">
                      <PaymentMethodButtons
                        value={masterDeposit.method}
                        onChange={(value) => {
                          setMasterDepositEdited(true);
                          setMasterDeposit((prev) => ({ ...prev, method: value }));
                        }}
                      />
                    </div>
                    <input
                      className="mt-2 h-10 w-full rounded-xl border border-amber-300 bg-white px-3.5 text-sm text-[var(--text-primary)] outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 dark:border-amber-500/30 dark:bg-slate-950"
                      value={masterDeposit.note}
                      onChange={(e) => {
                        setMasterDepositEdited(true);
                        setMasterDeposit((prev) => ({ ...prev, note: e.target.value }));
                      }}
                      placeholder="Deposit note / reason if no deposit"
                    />
                  </div>
                </div>
              )}

              {paymentPreview ? (
                <div className="border border-[var(--border-default)] rounded-xl p-4 bg-[var(--bg-surface)] space-y-3">
                  <div className="text-sm font-semibold text-[var(--text-primary)]">
                    Preview ({paymentPreview.payment_mode})
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-6 gap-2 text-xs">
                    <div className="rounded border border-[var(--border-default)] bg-[var(--bg-body)] px-2 py-1">
                      Grand Total: ฿ {paymentPreview.grand_total.toFixed(2)}
                    </div>
                    <div className="rounded border border-[var(--border-default)] bg-[var(--bg-body)] px-2 py-1">
                      Payment Received: ฿ {paymentPreview.payment_received.toFixed(2)}
                    </div>
                    <div className="rounded border border-[var(--border-default)] bg-[var(--bg-body)] px-2 py-1">
                      Deposit Received: ฿ {paymentPreview.deposit_received.toFixed(2)}
                    </div>
                    <div className="rounded border border-[var(--border-default)] bg-[var(--bg-body)] px-2 py-1">
                      Current Remaining: ฿ {paymentPreview.remaining_balance.toFixed(2)}
                    </div>
                    <div className="rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-indigo-700">
                      Submitted: ฿ {paymentPreview.submitted_payment_total.toFixed(2)}
                    </div>
                    <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700">
                      Projected Remaining: ฿ {paymentPreview.projected_remaining_balance.toFixed(2)}
                    </div>
                  </div>

                  {paymentPreview.overpayment_amount > 0 ? (
                    <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                      Overpayment: ฿ {paymentPreview.overpayment_amount.toFixed(2)}
                    </div>
                  ) : null}

                  {paymentPreview.validation_errors.length > 0 ? (
                    <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                      {paymentPreview.validation_errors.join(" ")}
                    </div>
                  ) : null}

                  <div className="space-y-1">
                    {paymentPreview.room_rows.map((row) => (
                      <div
                        key={row.reservation_id}
                        className="text-xs rounded border border-[var(--border-default)] bg-[var(--bg-body)] px-2 py-1 flex items-center justify-between"
                      >
                        <span>{row.booking_code}</span>
                        <span>
                          Planned ฿ {row.planned_payment.toFixed(2)} · Projected ฿ {row.projected_remaining.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>

                  {paymentPreview.payment_mode === "master" && paymentPreview.allocation_preview.length > 0 ? (
                    <div className="space-y-2">
                      {paymentPreview.allocation_preview.map((line) => (
                        <div key={`${line.line_index}-${line.method}`} className="border border-[var(--border-default)] rounded-lg p-2">
                          <div className="text-xs font-semibold text-[var(--text-table-cell)]">
                            Line #{line.line_index + 1} · {line.method} · ฿ {line.amount.toFixed(2)}
                          </div>
                          <div className="mt-1 grid grid-cols-1 md:grid-cols-2 gap-1 text-xs">
                            {line.allocations.map((row) => (
                              <div key={`${line.line_index}-${row.reservation_id}`} className="rounded border border-[var(--border-subtle)] bg-[var(--bg-body)] px-2 py-1">
                                {row.booking_code}: ฿ {row.allocated_amount.toFixed(2)}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {currentStep === 4 ? (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">Step 4 — Confirm Check-in</h2>
                <p className="text-sm text-[var(--text-secondary)]">Review ready/not-ready rooms and submit partial check-in.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                <div className="rounded border border-emerald-200 dark:border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/15 px-3 py-2 text-emerald-700 dark:text-emerald-400">Ready: {step4Buckets.ready.length}</div>
                <div className="rounded border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/15 px-3 py-2 text-amber-700 dark:text-amber-400">Not Ready: {step4Buckets.notReady.length}</div>
                <div className="rounded border border-[var(--border-default)] dark:border-[#2D333D] bg-[var(--bg-body)] dark:bg-[#0B0E14] px-3 py-2 text-[var(--text-secondary)]">Already Done: {step4Buckets.done.length}</div>
              </div>

              <div className="space-y-3">
                {step4Buckets.ready.map((row) => (
                  <div key={row.id} className="rounded border border-emerald-200 dark:border-emerald-500/10 bg-emerald-50 dark:bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300">
                    {row.booking_code} · Room {row.room_number} · {row.guest_name || "—"}
                  </div>
                ))}
                {step4Buckets.notReady.map(({ row, reasons }) => (
                  <div key={row.id} className="rounded border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                    <div>{row.booking_code} · Room {row.room_number} · {row.guest_name || "—"}</div>
                    <div className="text-amber-700 dark:text-amber-400 text-xs mt-1">{reasons.join(", ")}</div>
                    {!row.profile_completeness.is_complete ? (
                      <div className="text-amber-700 text-xs">Missing: {row.profile_completeness.missing_fields.join(", ")}</div>
                    ) : null}
                  </div>
                ))}
                {step4Buckets.done.map((row) => (
                  <div key={row.id} className="rounded border border-[var(--border-default)] dark:border-[#1E2530] bg-[var(--bg-body)] dark:bg-[#0B0E14] px-3 py-2 text-sm text-[var(--text-secondary)]">
                    {row.booking_code} · Room {row.room_number} already checked in
                  </div>
                ))}
              </div>

              {confirmResults ? (
                <div className="rounded border border-[var(--border-default)] dark:border-[#2D333D] p-3 bg-[var(--bg-surface)] dark:bg-[#151921]">
                  <h3 className="font-semibold text-[var(--text-primary)] mb-2">Confirm Results</h3>
                  <div className="space-y-2 text-sm">
                    {confirmResults.map((row) => (
                      <div key={row.reservation_id} className="border border-[var(--border-subtle)] rounded p-2">
                        <div className="font-medium text-[var(--text-primary)]">
                          {row.booking_code || row.reservation_id} · {row.guest_name || "—"}
                        </div>
                        <div className="text-xs text-[var(--text-secondary)]">status: {row.status}</div>
                        {row.codes.length > 0 ? <div className="text-xs text-[var(--text-secondary)]">codes: {row.codes.join(", ")}</div> : null}
                        {row.missing_fields?.length ? <div className="text-xs text-amber-700">missing: {row.missing_fields.join(", ")}</div> : null}
                        {row.error ? <div className="text-xs text-rose-700">error: {row.error}</div> : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </main>

      <footer className="bg-[var(--bg-surface)] dark:bg-[#0B0E14] border-t border-[var(--border-default)] dark:border-[#1E2530] px-6 py-4 flex items-center justify-between sticky bottom-0 z-20">
        <div className="flex items-center gap-2">
          <button className="btn btn-ghost" onClick={handleSaveAndExit} disabled={busy || step2Busy}>
            Save Draft & Exit
          </button>
          <button className="btn btn-ghost text-rose-600" onClick={handleCancelDraft} disabled={busy || step2Busy || !businessDate}>
            Cancel Wizard
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-secondary" onClick={handleBack} disabled={currentStep === 1 || busy || step2Busy}>
            Back
          </button>
          {currentStep < 4 ? (
            <button className="btn btn-primary" onClick={handleNext} disabled={busy || step2Busy}>
              Next
            </button>
          ) : (
            <button className="btn btn-primary" onClick={handleConfirm} disabled={busy || step2Busy || selectedReservations.length === 0}>
              {busy ? "Checking in..." : `Confirm Check-in (${selectedReservations.length})`}
            </button>
          )}
        </div>
      </footer>

      {/* Failed OCR Modal */}
      {showFailedModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-[var(--bg-surface)] dark:bg-[#151921] border border-[var(--border-default)] dark:border-[#2D333D] rounded-2xl w-full max-w-2xl shadow-xl overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-[var(--border-default)] dark:border-[#1E2530] flex items-center justify-between bg-[var(--bg-body)] dark:bg-[#0B0E14]">
              <div>
                <h3 className="font-bold text-lg text-[var(--text-primary)]">OCR Failed - Manual Entry</h3>
                <p className="text-xs font-medium text-[var(--text-secondary)]">Please use Manual Assign to look up or create the profile using this photo.</p>
              </div>
              <button
                onClick={() => setShowFailedModal(null)}
                className="text-[var(--text-muted)] hover:text-rose-500 bg-[var(--bg-surface-hover)] p-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full transition"
              >
                ✕
              </button>
            </div>
            <div className="p-4 bg-[var(--bg-body)] flex justify-center">
              {/* Provide placeholder UI since we don't have real S3 buckets setup right now */}
              <div className="w-full aspect-[4/3] bg-slate-900 rounded-xl overflow-hidden shadow-inner flex items-center justify-center border-4 border-[var(--border-subtle)] relative">
                <img
                  src="/placeholder-passport.jpg"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  className="w-full h-full object-cover opacity-80"
                />
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-slate-300 gap-2">
                  <span className="bg-black/50 px-3 py-1 rounded text-sm font-code backdrop-blur-sm">
                    Path: {showFailedModal.imagePath || "groups/null/failed.jpg"}
                  </span>
                </div>
              </div>
            </div>
            <div className="p-5 border-t border-[var(--border-default)] bg-[var(--bg-surface)] flex justify-end gap-3">
              <button className="btn btn-secondary" onClick={() => setShowFailedModal(null)}>
                Close
              </button>
              <button
                className="btn btn-primary"
                onClick={() => setShowFailedModal(null)}
              >
                Acknowledged
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
