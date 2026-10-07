"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { createPortal } from "react-dom";
import type { RoomDrawerRoom } from "@/components/room-drawer";
import { DayUseCheckinSidebar } from "@/components/dayuse-checkin-sidebar";
import NightAuditPendingPopup from "@/components/night-audit-pending-popup";
import type { DayUseRoomStatus, DayUseSettings, DayUseTimerState } from "@/lib/types";
import { resolveGuestLoyaltyVisual } from "@/lib/guest-loyalty";
import { formatDateDisplay, formatDateRangeDisplay } from "@/lib/date-display";
import { DEFAULT_TRANSPORT_ALERT_LEAD_MINUTES, getTransportAlertLevel } from "@/lib/transport-alert-settings";
import { STRICT_POLLING, canPollVisibleTab, strictPollInterval } from "@/lib/egress-strict-mode";

const RoomDrawer = dynamic(() => import("@/components/room-drawer"), {
    loading: () => null,
});

const ReservationDetailPage = dynamic(() => import("@/components/reservation-detail-page"), {
    loading: () => null,
});

/* ─── Types ───────────────────────────────────── */
type RoomStatus = "available" | "reserved" | "dirty" | "cleaning" | "approved" | "closed" | "ooo" | "oos";
type DiaryState = "available" | "due_in" | "inhouse" | "back_to_back" | "due_out";
type HousekeepingRawStatus = "dirty" | "in_progress" | "paused" | "cleaned" | "approved";
type HkLayerVisual = {
    color: string;
    title: string;
};

type ApiRoom = {
    room_id: string;
    room_number: string;
    room_type: string;
    sellable: boolean;
    closure_reason?: string | null;
    status: RoomStatus;
    reservation_id?: string | null;
    reservation_status?: string | null;
    wing?: string | null;
    guest_name?: string | null;
    booking_code?: string | null;
    specials?: string | null;
    special_request?: string | null;
    booking_group_id?: string | null;
    parent_reservation_id?: string | null;
    linked_root_id?: string | null;
    linked_full_checkin?: string | null;
    linked_full_checkout?: string | null;
    linked_full_nights?: number | null;
    linked_combined_total?: number | null;
    linked_active_segment_id?: string | null;
    group_code?: string | null;
    group_name?: string | null;
    guest_checkin_date?: string | null;
    guest_checkout_date?: string | null;
    source?: string | null;
    due_in_guest_name?: string | null;
    due_in_booking_code?: string | null;
    due_in_checkin_date?: string | null;
    due_in_checkout_date?: string | null;
    due_in_source?: string | null;
    due_in_reservation_id?: string | null;
    diary_state?: DiaryState | null;
    room_move_from?: string | null;
    room_move_reason?: string | null;
    room_move_date?: string | null;
    guest_profile_id?: string | null;
    vip_tier?: string | null;
    stay_count?: number;
    night_count?: number;
    main_stay_count?: number;
    main_night_count?: number;
    accompanying_stay_count?: number;
    accompanying_night_count?: number;
    possible_return_count?: number;
    possible_return_profile_id?: string | null;
    possible_return_name?: string | null;
    hk_status?: HousekeepingRawStatus | null;
    hk_task_seq?: number | null;
    hk_assigned_maid?: string | null;
    hk_started_at?: string | null;
    hk_finished_at?: string | null;
    hk_approved_at?: string | null;
    hk_is_no_service?: boolean;
    hk_no_service_note?: string | null;
    transfer_pickup_at?: string | null;
    transfer_type_icon?: string | null;
    transfer_status?: string | null;
    transfer_id?: string | null;
    transfer_guest_note?: string | null;
    transfer_alert_enabled?: boolean | null;
    transfer_alert_lead_min?: number | null;
    alert_count?: number;
    first_alert_message?: string | null;
    alert_severity?: "info" | "warning" | "critical" | null;
    is_dayuse?: boolean;
    dayuse_reservation_status?: "active" | "checked_out" | null;
    dayuse_expires_at?: string | null;
    dayuse_timer_state?: DayUseTimerState | null;
};

type BoardData = {
    date: string;
    counts: Record<RoomStatus, number>;
    rooms: ApiRoom[];
};

type DateViewOffset = -1 | 0 | 1;

/* ─── Floor structure (same as board-layout.ts) ─ */
const FLOOR_ORDER = [
    { label: "Floor 3", prefix: "3" },
    { label: "Floor 2", prefix: "2" },
    { label: "Floor 1", prefix: "1" }
];

/* ─── Status styling ──────────────────────────── */
const STATUS_STYLE: Record<
    RoomStatus,
    { card: string; badge: string; label: string }
> = {
    available: {
        card: "border-emerald-200 bg-emerald-50 hover:border-emerald-400 dark:border-emerald-800 dark:bg-emerald-950/40 dark:hover:border-emerald-600",
        badge: "status-available",
        label: "Available"
    },
    reserved: {
        card: "border-amber-300 bg-amber-50 hover:border-amber-500 dark:border-amber-800 dark:bg-amber-950/40 dark:hover:border-amber-600",
        badge: "status-reserved",
        label: "Reserved"
    },
    dirty: {
        card: "border-rose-300 bg-rose-50 hover:border-rose-500 dark:border-rose-800 dark:bg-rose-950/40 dark:hover:border-rose-600",
        badge: "status-dirty",
        label: "Dirty"
    },
    cleaning: {
        card: "border-sky-300 bg-sky-50 hover:border-sky-500 dark:border-sky-800 dark:bg-sky-950/40 dark:hover:border-sky-600",
        badge: "status-cleaning",
        label: "Cleaning"
    },
    approved: {
        card: "border-green-300 bg-green-50 hover:border-green-400 dark:border-green-800 dark:bg-green-950/40 dark:hover:border-green-600",
        badge: "status-approved",
        label: "Clean ✓"
    },
    closed: {
        card: "border-[var(--border-default)] bg-[var(--bg-muted)] opacity-60",
        badge: "status-closed",
        label: "Renovation"
    },
    ooo: {
        card: "border-rose-400 bg-rose-100 ring-1 ring-rose-500 dark:border-rose-700 dark:bg-rose-950/50 dark:ring-rose-800",
        badge: "bg-rose-600 text-white",
        label: "OOO (Blocked)"
    },
    oos: {
        card: "border-amber-400 bg-amber-50 ring-1 ring-amber-300 dark:border-amber-700 dark:bg-amber-950/40 dark:ring-amber-800",
        badge: "bg-amber-500 text-white",
        label: "OOS (Service)"
    }
};

const DIARY_STYLE: Record<DiaryState, { symbol: ReactNode; label: string; symbolClass: string; chipClass: string }> = {
    available: {
        symbol: "●",
        label: "Available",
        symbolClass: "text-emerald-500 dark:text-emerald-400",
        chipClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
    },
    due_in: {
        symbol: <ArrowDown className="w-3.5 h-3.5" strokeWidth={5} />,
        label: "Due In",
        symbolClass: "text-sky-600 dark:text-sky-400",
        chipClass: "bg-sky-100 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400"
    },
    inhouse: {
        symbol: "●",
        label: "In-House",
        symbolClass: "text-amber-500 dark:text-amber-400",
        chipClass: "bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
    },
    back_to_back: {
        symbol: <ArrowUpDown className="w-3.5 h-3.5" strokeWidth={5} />,
        label: "Back-to-Back",
        symbolClass: "text-indigo-600 dark:text-indigo-400",
        chipClass: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400"
    },
    due_out: {
        symbol: <ArrowUp className="w-3.5 h-3.5" strokeWidth={5} />,
        label: "Due Out",
        symbolClass: "text-rose-600 dark:text-rose-400",
        chipClass: "bg-rose-100 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400"
    }
};
type FilterKey = RoomStatus | "all" | "available_now" | "due_in" | "due_out" | "inhouse" | "back_to_back";

const FILTERS: { key: FilterKey; label: string }[] = [
    { key: "all", label: "All" },
    { key: "available_now", label: "Available Now" },
    { key: "available", label: "Available" },
    { key: "due_in", label: "Due In 🛬" },
    { key: "inhouse", label: "In-House" },
    { key: "back_to_back", label: "Back-to-Back" },
    { key: "due_out", label: "Due Out 🛫" },
    { key: "dirty", label: "Dirty" },
    { key: "cleaning", label: "Cleaning" },
    { key: "ooo", label: "Blocked" },
];

function isAvailableForToday(room: ApiRoom): boolean {
    return room.sellable && (room.diary_state === "available" || room.diary_state === "due_out");
}

function matchesFilter(room: ApiRoom, f: FilterKey): boolean {
    if (f === "all") return true;
    if (f === "available_now") return room.status === "available";
    if (f === "available") return isAvailableForToday(room);
    if (f === "due_in") return room.diary_state === "due_in";
    if (f === "due_out") return room.diary_state === "due_out";
    if (f === "inhouse") return room.diary_state === "inhouse";
    if (f === "back_to_back") return room.diary_state === "back_to_back";
    if (f === "ooo") return room.status === "ooo" || room.status === "oos";
    return room.status === f;
}

function matchesAnyFilter(room: ApiRoom, selected: FilterKey[]): boolean {
    if (selected.includes("all")) return true;
    return selected.some((f) => matchesFilter(room, f));
}

const SOURCE_LABEL: Record<string, string> = {
    walkin: "Walk-in", ota: "OTA", direct: "Direct", agent: "Agent"
};

function resolveRoomLinkKey(room: ApiRoom): string | null {
    if (room.linked_root_id) return `linked:${room.linked_root_id}`;
    if (room.booking_group_id) return `group:${room.booking_group_id}`;
    return null;
}

const HK_STRIPE_COLOR_BY_STATUS: Partial<Record<HousekeepingRawStatus, string>> = {
    dirty: "rgba(239, 68, 68, 0.95)",
    in_progress: "var(--hk-stripe-in-progress)",
    paused: "var(--hk-stripe-paused)",
    cleaned: "rgba(34, 197, 94, 0.95)",
};

const HK_IN_HOUSE_LAYER_COLORS = {
    noAction: "#b45309",
    noService: "#0891b2",
    dirty: "#dc2626",
    inProgress: "#0284c7",
    paused: "#9333ea",
    complete: "#15803d",
} as const;

function isTrueStayover(room: ApiRoom, boardDate: string | null): boolean {
    if (room.is_dayuse) return false;
    if (room.diary_state !== "inhouse") return false;
    if (room.status !== "reserved") return false;

    if (boardDate) {
        if (room.guest_checkin_date && room.guest_checkin_date >= boardDate) return false;
        if (room.guest_checkout_date && room.guest_checkout_date <= boardDate) return false;
    }

    return true;
}

function resolveHkStripeLayerVisual(room: ApiRoom): HkLayerVisual | null {
    if (!room.hk_status) return null;
    const color = HK_STRIPE_COLOR_BY_STATUS[room.hk_status];
    if (!color) return null;

    if (room.hk_status === "in_progress") {
        return { color, title: "HK in progress" };
    }
    if (room.hk_status === "paused") {
        return { color, title: "HK paused" };
    }
    if (room.hk_status === "cleaned" || room.hk_finished_at || room.hk_status === "approved" || room.hk_approved_at) {
        return { color, title: "HK complete" };
    }
    return { color, title: "Dirty" };
}

function resolveHkInHouseLayerVisual(room: ApiRoom, boardDate: string | null): HkLayerVisual | null {
    if (!isTrueStayover(room, boardDate)) return null;

    if (room.hk_status === "approved" || room.hk_approved_at || room.hk_status === "cleaned" || room.hk_finished_at) {
        return { color: HK_IN_HOUSE_LAYER_COLORS.complete, title: "Stayover complete" };
    }
    if (room.hk_status === "in_progress") {
        return { color: HK_IN_HOUSE_LAYER_COLORS.inProgress, title: "Stayover cleaning" };
    }
    if (room.hk_status === "paused") {
        return { color: HK_IN_HOUSE_LAYER_COLORS.paused, title: "Stayover paused" };
    }
    if (room.hk_is_no_service === true && room.hk_status) {
        return { color: HK_IN_HOUSE_LAYER_COLORS.noService, title: "No Service pending" };
    }
    if (room.hk_status === "dirty") {
        return { color: HK_IN_HOUSE_LAYER_COLORS.dirty, title: "Stayover dirty" };
    }
    if (!room.hk_status) {
        return { color: HK_IN_HOUSE_LAYER_COLORS.noAction, title: "Stayover: HK not selected" };
    }

    return null;
}

function normalizeBookingSource(value: unknown): "walkin" | "ota" | "direct" | "agent" {
    if (value === "walkin" || value === "ota" || value === "direct" || value === "agent") {
        return value;
    }
    return "direct";
}

function mapDayUseToApiRoom(room: DayUseRoomStatus): ApiRoom {
    let status: RoomStatus = "available";
    if (room.current_reservation) status = "reserved";
    else if (room.hk_status === "dirty") status = "dirty";
    else if (room.hk_status === "in_progress" || room.hk_status === "paused") status = "cleaning";
    else if (room.hk_status === "cleaned" || room.hk_status === "approved") status = "approved";

    return {
        room_id: room.room_id,
        room_number: room.room_number,
        room_type: "",
        sellable: true,
        closure_reason: null,
        status,
        reservation_id: room.current_reservation?.id ?? null,
        wing: "R",
        guest_name: room.current_reservation?.guest_name ?? null,
        booking_code: room.current_reservation?.booking_code ?? null,
        source: "walkin",
        diary_state: room.current_reservation ? "inhouse" : "available",
        hk_status: room.hk_status ?? null,
        hk_task_seq: null,
        is_dayuse: true,
        dayuse_reservation_status: room.current_reservation?.status ?? null,
        dayuse_expires_at: room.current_reservation?.dayuse_expires_at ?? null,
        dayuse_timer_state: room.timer_state ?? null,
        transfer_alert_lead_min: DEFAULT_TRANSPORT_ALERT_LEAD_MINUTES,
    };
}

function formatBangkokTime(value: string): string {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Bangkok",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(d);
}

function shiftDateString(baseDate: string, offsetDays: number): string {
    const [y, m, d] = baseDate.split("-").map((x) => Number(x));
    if (!y || !m || !d) return baseDate;
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + offsetDays);
    return dt.toISOString().slice(0, 10);
}

function RoomCard({
    room, selected, viewMode, isMobile, isMatched, groupHighlight, groupPeers, hkLayerEnabled, hkInHouseLayerEnabled, boardDate, nowMs, alertsEnabled, onGroupHoverChange, onClick, clickable = true
}: {
    room: ApiRoom;
    selected: boolean;
    viewMode: "compact" | "detail";
    isMobile: boolean;
    isMatched: boolean;
    groupHighlight: "none" | "focus" | "fade";
    groupPeers: ApiRoom[];
    hkLayerEnabled: boolean;
    hkInHouseLayerEnabled: boolean;
    boardDate: string | null;
    nowMs: number;
    alertsEnabled: boolean;
    onGroupHoverChange: (groupId: string | null) => void;
    onClick: () => void;
    clickable?: boolean;
}) {
    const s = STATUS_STYLE[room.status] ?? STATUS_STYLE.closed;
    const isBlocked = room.status === "ooo" || room.status === "oos";
    const isReserved = room.status === "reserved";
    const hasMoveHistory = Boolean(room.room_move_from);
    const compactCardSize = isMobile
        ? "w-[92px] h-[68px] min-w-[92px] min-h-[68px]"
        : "w-[110px] h-[80px] min-w-[110px] min-h-[80px]";
    const cardSize = viewMode === "detail"
        ? "w-[160px] h-[116px] min-w-[160px] min-h-[116px]"
        : compactCardSize;
    const cardPadding = viewMode === "detail" ? "p-2.5" : "p-1.5";
    const roomNoClass = viewMode === "detail" ? "text-sm" : "text-xs";
    const cardRef = useRef<HTMLButtonElement | null>(null);
    const hoverPanelRef = useRef<HTMLDivElement | null>(null);
    const [hoverAnchor, setHoverAnchor] = useState<{ top: number; left: number; placement: "below" | "above" } | null>(null);

    const diaryState = room.diary_state ?? (
        room.reservation_status === "draft_checkin"
            ? "due_in"
            : room.status === "reserved"
            ? "inhouse"
            : room.status === "available"
                ? "available"
                : null
    );
    const diary = diaryState ? DIARY_STYLE[diaryState] : null;
    const shouldFade = (groupHighlight === "fade" || !isMatched) && room.status !== "closed";
    const isGroupFocused = groupHighlight === "focus";
    const hkInHouseLayerVisual = hkInHouseLayerEnabled
        ? resolveHkInHouseLayerVisual(room, boardDate)
        : null;
    const hkStripeLayerVisual = hkLayerEnabled
        ? resolveHkStripeLayerVisual(room)
        : null;
    const shouldShowHkStripeLayer =
        hkLayerEnabled &&
        room.sellable &&
        !isBlocked &&
        Boolean(hkStripeLayerVisual);
    const shouldShowHkInHouseLayer =
        hkInHouseLayerEnabled &&
        room.sellable &&
        !isBlocked &&
        Boolean(hkInHouseLayerVisual);
    const activeHkLayerTitle = hkInHouseLayerVisual?.title ?? hkStripeLayerVisual?.title ?? undefined;
    const hasDayUseAlertCandidate =
        alertsEnabled &&
        Boolean(room.is_dayuse) &&
        room.dayuse_reservation_status === "active" &&
        Boolean(room.dayuse_expires_at) &&
        Boolean(room.reservation_id);
    const dayUseExpiresMs = room.dayuse_expires_at ? new Date(room.dayuse_expires_at).getTime() : Number.NaN;
    const dayUseSecondsToExpiry = Number.isNaN(dayUseExpiresMs)
        ? null
        : Math.floor((dayUseExpiresMs - nowMs) / 1000);
    let dayUseAlertLevel: "yellow" | "red" | null = null;
    if (hasDayUseAlertCandidate && dayUseSecondsToExpiry !== null) {
        if (dayUseSecondsToExpiry <= 10 * 60) dayUseAlertLevel = "red";
        else if (dayUseSecondsToExpiry <= 30 * 60) dayUseAlertLevel = "yellow";
    }
    const hasTransferAlertCandidate =
        alertsEnabled &&
        Boolean(room.transfer_pickup_at) &&
        room.transfer_alert_enabled !== false &&
        (room.transfer_status === "pending" ||
            room.transfer_status === "confirmed" ||
            room.transfer_status === "driver_assigned");
    const transferPickupMs = room.transfer_pickup_at ? new Date(room.transfer_pickup_at).getTime() : Number.NaN;
    const transferSecondsToPickup = Number.isNaN(transferPickupMs)
        ? null
        : Math.floor((transferPickupMs - nowMs) / 1000);
    let transferAlertLevel: "yellow" | "red" | null = null;
    if (hasTransferAlertCandidate && transferSecondsToPickup !== null) {
        transferAlertLevel = getTransportAlertLevel(
            transferSecondsToPickup,
            room.transfer_alert_lead_min ?? DEFAULT_TRANSPORT_ALERT_LEAD_MINUTES
        );
    }
    const activeAlertLevel: "yellow" | "red" | null = (
        transferAlertLevel === "red" || dayUseAlertLevel === "red"
            ? "red"
            : transferAlertLevel === "yellow" || dayUseAlertLevel === "yellow"
                ? "yellow"
                : null
    );
    const alertIcon =
        transferAlertLevel && dayUseAlertLevel
            ? "⚠️"
            : transferAlertLevel
                ? (room.transfer_type_icon ?? "🚗")
                : "⏱";
    const alertTitle =
        transferAlertLevel && dayUseAlertLevel
            ? "Transfer + Day Use alert"
            : transferAlertLevel
                ? "Transfer alert"
                : "Day Use alert";
    const transferShadowStyle = activeAlertLevel
        ? {
            animationDuration: activeAlertLevel === "red" ? "0.6s" : "1.2s",
            boxShadow:
                activeAlertLevel === "red"
                    ? "0 0 0 10px rgba(239, 68, 68, 0.9), 0 0 100px rgba(239, 68, 68, 0.9), 0 0 40px rgba(239, 68, 68, 1) inset, 0 0 30px #fff"
                    : "0 0 0 8px rgba(245, 158, 11, 0.9), 0 0 80px rgba(245, 158, 11, 0.9), 0 0 30px rgba(245, 158, 11, 1) inset, 0 0 20px #fff",
        }
        : undefined;
    const loyaltyVisual = resolveGuestLoyaltyVisual(room);
    const returnStats = loyaltyVisual.returnStats;
    const possibleReturn = !returnStats && (room.possible_return_count ?? 0) > 0;
    const roomLinkKey = resolveRoomLinkKey(room);
    const linkedStayCheckin = room.linked_full_checkin ?? room.guest_checkin_date ?? null;
    const linkedStayCheckout = room.linked_full_checkout ?? room.guest_checkout_date ?? null;
    const linkedStayNights = room.linked_full_nights ?? null;
    const linkedStayCombinedTotal = room.linked_combined_total ?? null;
    const hasLinkedStaySummary = Boolean(room.linked_full_checkin && room.linked_full_checkout);

    function openHoverPreview() {
        if (isMobile) return;
        onGroupHoverChange(roomLinkKey);
        const rect = cardRef.current?.getBoundingClientRect();
        if (!rect) return;

        const panelWidth = 256;
        const estimatedHeight = 180;
        const gap = 8;

        let left = rect.left;
        let top = rect.bottom + gap;
        let placement: "below" | "above" = "below";

        if (left + panelWidth > window.innerWidth - 8) left = window.innerWidth - panelWidth - 8;
        if (left < 8) left = 8;

        if (top + estimatedHeight > window.innerHeight - 8) {
            top = Math.max(8, rect.top - estimatedHeight - gap);
            placement = "above";
        }
        setHoverAnchor({ top, left, placement });
    }

    function closeHoverPreview() {
        onGroupHoverChange(null);
        setHoverAnchor(null);
    }

    useEffect(() => {
        if (!hoverAnchor) return;
        const close = () => setHoverAnchor(null);
        window.addEventListener("scroll", close, true);
        window.addEventListener("resize", close);
        return () => {
            window.removeEventListener("scroll", close, true);
            window.removeEventListener("resize", close);
        };
    }, [hoverAnchor]);

    useLayoutEffect(() => {
        if (!hoverAnchor) return;
        const rect = cardRef.current?.getBoundingClientRect();
        const panel = hoverPanelRef.current;
        if (!rect || !panel) return;

        const gap = 8;
        const panelRect = panel.getBoundingClientRect();
        const panelWidth = panelRect.width || 256;
        const panelHeight = panelRect.height || 160;

        let left = rect.left;
        if (left + panelWidth > window.innerWidth - 8) left = window.innerWidth - panelWidth - 8;
        if (left < 8) left = 8;

        const belowTop = rect.bottom + gap;
        const aboveTop = rect.top - panelHeight - gap;
        const canFitBelow = belowTop + panelHeight <= window.innerHeight - 8;
        const canFitAbove = aboveTop >= 8;

        const placement =
            hoverAnchor.placement === "below"
                ? (canFitBelow ? "below" : (canFitAbove ? "above" : "below"))
                : (canFitAbove ? "above" : (canFitBelow ? "below" : "above"));

        const top =
            placement === "below"
                ? Math.min(belowTop, window.innerHeight - panelHeight - 8)
                : Math.max(8, aboveTop);

        if (top !== hoverAnchor.top || left !== hoverAnchor.left || placement !== hoverAnchor.placement) {
            setHoverAnchor({ top, left, placement });
        }
    }, [hoverAnchor]);

    return (
        <div className="relative shrink-0">
            {activeAlertLevel && (
                <div
                    className="absolute inset-0 rounded-xl pointer-events-none z-0 transfer-alert-pulse"
                    style={transferShadowStyle}
                />
            )}
            {/* Card Button */}
            <button
                ref={cardRef}
                onClick={() => {
                    if (!clickable) return;
                    onClick();
                }}
                onMouseEnter={openHoverPreview}
                onMouseLeave={closeHoverPreview}
                onFocus={openHoverPreview}
                onBlur={closeHoverPreview}
                className={`${cardSize} relative rounded-xl border ${cardPadding} flex flex-col
          ${s.card} status-${room.status} ${selected ? "ring-2 ring-brand-400" : ""} ${isGroupFocused ? "ring-2 ring-indigo-400 shadow-md" : ""}
          ${clickable ? "cursor-pointer" : "cursor-default"} text-left overflow-hidden transition-all z-10`}
                style={shouldFade ? { filter: "saturate(30%)", opacity: 0.45 } : undefined}
                title={activeHkLayerTitle}
            >
                {shouldShowHkStripeLayer && hkStripeLayerVisual && (
                    <div
                        className="absolute inset-0 pointer-events-none z-0"
                        title={hkStripeLayerVisual.title}
                        style={{
                            opacity:
                                room.hk_status === "in_progress" || room.hk_status === "paused"
                                    ? 1
                                    : room.hk_status === "cleaned" || room.hk_finished_at || room.hk_status === "approved" || room.hk_approved_at
                                        ? 0.18
                                        : 0.13,
                            backgroundImage:
                                `repeating-linear-gradient(45deg, ${hkStripeLayerVisual.color} 0 12px, rgba(255, 255, 255, 0) 12px 24px)`,
                        }}
                    />
                )}

                {shouldShowHkInHouseLayer && hkInHouseLayerVisual && (
                    <div
                        className="absolute bottom-0 left-0 h-[48%] aspect-square pointer-events-none z-0"
                        title={hkInHouseLayerVisual.title}
                        style={{
                            backgroundColor: hkInHouseLayerVisual.color,
                            clipPath: "polygon(0 0, 100% 100%, 0 100%)",
                        }}
                    />
                )}

                <div className="relative z-10 flex h-full flex-col">
                    {activeAlertLevel && (
                        <div className="absolute right-1.5 top-1.5 z-20">
                            <span
                                className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px] leading-none ${activeAlertLevel === "red"
                                    ? "border-red-300 bg-red-50 text-red-700"
                                    : "border-amber-300 bg-amber-50 text-amber-700"
                                    }`}
                                title={alertTitle}
                            >
                                {alertIcon}
                            </span>
                        </div>
                    )}

                    {/* Row 1: room number + status/tier badges */}
                    <div className="flex items-start justify-between gap-1">
                        <div className="flex items-center gap-1">
                            <span className={`${roomNoClass} font-bold text-[var(--text-primary)] leading-none`}>{room.room_number}</span>
                            {diary && (
                                <span
                                    className={`inline-flex items-center text-[11px] font-black leading-none ${diary.symbolClass}`}
                                    title={diary.label}
                                >
                                    {diary.symbol}
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-1">
                            {viewMode === "detail" && (
                                <span className={`badge ${s.badge} text-[9px] leading-none shrink-0`}>
                                    {isBlocked ? "BLOCKED" : s.label}
                                </span>
                            )}
                            {viewMode === "compact" && isBlocked && (
                                <span className="text-[10px] leading-none">⛔</span>
                            )}
                        </div>
                    </div>

                    {/* Detail mode: guest name */}
                    {viewMode === "detail" && isReserved && room.guest_name && (
                        <p className="text-[10px] font-semibold text-[var(--text-primary)] mt-1 truncate leading-tight">
                            {room.guest_name}
                        </p>
                    )}

                    {/* Detail mode: dates */}
                    {viewMode === "detail" && isReserved && linkedStayCheckin && (
                        <p className="text-[9px] text-[var(--text-muted)] leading-tight">
                            {formatDateRangeDisplay(linkedStayCheckin, linkedStayCheckout, { withYear: false })}
                        </p>
                    )}

                    {viewMode === "detail" && isReserved && hasMoveHistory && (
                        <p className="text-[9px] text-indigo-700 leading-tight mt-0.5 truncate">
                            ⇄ From {room.room_move_from}
                            {room.room_move_date ? ` (${formatDateDisplay(room.room_move_date, { withYear: false })})` : ""}
                        </p>
                    )}

                    {/* Bottom row */}
                    {viewMode === "detail" ? (
                        <div className="mt-auto flex items-end justify-between gap-1">
                            <p className="text-[10px] text-[var(--text-secondary)] font-medium truncate leading-tight">
                                {isBlocked
                                    ? (room.closure_reason || "No Reason")
                                    : isReserved && room.source
                                        ? SOURCE_LABEL[room.source] ?? room.source
                                        : room.room_type}
                            </p>
                            <div className="flex items-center gap-1 shrink-0">
                                {returnStats ? (
                                    <span
                                        className="inline-flex items-center rounded-full bg-emerald-600 px-2 py-0.5 text-[9px] font-bold text-white shrink-0"
                                        title={returnStats.source === "main" ? "Main guest history" : "Accompanying guest history"}
                                    >
                                        {returnStats.text}
                                    </span>
                                ) : possibleReturn ? (
                                    <span
                                        className="inline-flex items-center rounded-full bg-emerald-600 px-2 py-0.5 text-[9px] font-bold text-white shrink-0"
                                        title={room.possible_return_name ? `Possible return: ${room.possible_return_name}` : "Possible return"}
                                    >
                                        PR
                                    </span>
                                ) : null}
                            </div>
                        </div>
                    ) : (
                        <div className="mt-auto flex justify-end">
                            <div className="flex items-center gap-1">
                                {returnStats ? (
                                    <span
                                        className="inline-flex items-center rounded-full bg-emerald-600 px-2 py-0.5 text-[9px] font-bold text-white shrink-0"
                                        title={returnStats.source === "main" ? "Main guest history" : "Accompanying guest history"}
                                    >
                                        {returnStats.text}
                                    </span>
                                ) : possibleReturn ? (
                                    <span
                                        className="inline-flex items-center rounded-full bg-emerald-600 px-2 py-0.5 text-[9px] font-bold text-white shrink-0"
                                        title={room.possible_return_name ? `Possible return: ${room.possible_return_name}` : "Possible return"}
                                    >
                                        PR
                                    </span>
                                ) : isReserved && room.booking_code ? (
                                    <span className="text-[8px] text-[var(--text-muted)] font-mono shrink-0">
                                        #{room.booking_code.slice(-4)}
                                    </span>
                                ) : null}
                            </div>
                        </div>
                    )}
                    {(room.alert_count ?? 0) > 0 && (
                        <span className="absolute bottom-0 left-1/2 -translate-x-1/2">
                            <span className="relative flex h-4 w-4">
                                {/* วงขยายออก (ping layer) - เพิ่มความแรง 2 เท่า */}
                                <span
                                    className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-100 ${room.alert_severity === "critical"
                                        ? "bg-red-400"
                                        : room.alert_severity === "warning"
                                            ? "bg-orange-400"
                                            : "bg-sky-400"
                                        }`}
                                    style={{ animationDuration: "1s" }}
                                />
                                {/* จุดหลักพร้อม Glow หนักๆ */}
                                <span
                                    className={`relative inline-flex h-4 w-4 rounded-full border-2 border-[var(--bg-surface)] dark:border-zinc-900 shadow-[0_0_20px_rgba(255,255,255,0.4)] ${room.alert_severity === "critical"
                                        ? "bg-red-500 shadow-red-500/80"
                                        : room.alert_severity === "warning"
                                            ? "bg-orange-500 shadow-orange-500/80"
                                            : "bg-sky-400 shadow-sky-400/80"
                                        }`}
                                    title={room.first_alert_message ?? "Alert"}
                                />
                            </span>
                        </span>
                    )}
                </div>

                {isBlocked && (
                    <div className="absolute inset-0 bg-stripe-pattern opacity-5 pointer-events-none" />
                )}
            </button>

            {/* Hover Preview Panel — render as fixed portal to avoid clipping by scroll containers */}
            {hoverAnchor && !isMobile && createPortal(
                <div
                    ref={hoverPanelRef}
                    className={`fixed z-[80] w-64 rounded-xl border shadow-xl p-3 pointer-events-none select-none ${loyaltyVisual.hoverPanelClass} dark:border-white/10`}
                    style={{ top: hoverAnchor.top, left: hoverAnchor.left }}
                >
                    <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-bold">{room.room_number}</span>
                        <span className={`badge ${s.badge} text-[9px]`}>{s.label}</span>
                    </div>
                    <div className="flex items-center gap-2 mb-1">
                        <p className="text-[10px] text-[var(--text-muted)]">{room.room_type}</p>
                        {loyaltyVisual.tierEmoji && (
                            <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-bold ${loyaltyVisual.tierBadgeClass}`}>
                                {loyaltyVisual.tierEmoji} {loyaltyVisual.tierLabel}
                            </span>
                        )}
                        {diary && (
                            <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${diary.chipClass}`}>
                                <span className={`font-black ${diary.symbolClass}`}>{diary.symbol}</span>
                                {diary.label}
                            </span>
                        )}
                    </div>
                    {isReserved && (
                        <div className="mt-1.5 space-y-0.5">
                            {room.guest_name && <p className="text-xs font-semibold text-[var(--text-primary)]">{room.guest_name}</p>}
                            {room.booking_code && <p className="text-[10px] text-[var(--text-secondary)] font-mono">{room.booking_code}</p>}
                            {linkedStayCheckin && linkedStayCheckout && (
                                <p className="text-[10px] text-[var(--text-muted)]">
                                    {formatDateRangeDisplay(linkedStayCheckin, linkedStayCheckout)}
                                    {linkedStayNights !== null && (
                                        <span className="ml-1">
                                            ({linkedStayNights} night{linkedStayNights !== 1 ? "s" : ""})
                                        </span>
                                    )}
                                </p>
                            )}
                            {hasLinkedStaySummary && linkedStayCombinedTotal !== null && (
                                <div className="inline-flex items-center rounded-full bg-indigo-100 px-1.5 py-0.5 text-[9px] font-semibold text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
                                    Linked Stay · ฿{linkedStayCombinedTotal.toLocaleString("th-TH")}
                                </div>
                            )}
                            {room.source && (
                                <span className="inline-block text-[9px] bg-[var(--bg-muted)] text-[var(--text-secondary)] px-1.5 py-0.5 rounded-full">
                                    {SOURCE_LABEL[room.source] ?? room.source}
                                </span>
                            )}
                            {room.special_request && (
                                <div className="rounded-md border border-fuchsia-200 bg-fuchsia-50 px-2 py-1 mt-1 dark:bg-fuchsia-500/10 dark:border-fuchsia-500/20">
                                    <p className="text-[10px] font-semibold text-fuchsia-700 dark:text-fuchsia-400">
                                        Special Request
                                    </p>
                                    <p className="text-[10px] text-fuchsia-700 dark:text-fuchsia-300/90 whitespace-pre-wrap break-words">
                                        {room.special_request}
                                    </p>
                                </div>
                            )}
                            {room.diary_state === "back_to_back" && room.due_in_guest_name && (
                                <div className="rounded-md border border-sky-200 bg-sky-50 px-2 py-1 mt-1 dark:bg-sky-500/10 dark:border-sky-500/20">
                                    <p className="text-[10px] font-semibold text-sky-700 dark:text-sky-400">
                                        Due In: {room.due_in_guest_name}
                                    </p>
                                    {(room.due_in_checkin_date || room.due_in_checkout_date) && (
                                        <p className="text-[10px] text-sky-600 dark:text-sky-300/80">
                                            {formatDateRangeDisplay(room.due_in_checkin_date, room.due_in_checkout_date)}
                                        </p>
                                    )}
                                </div>
                            )}
                            {hasMoveHistory && (
                                <div className="rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 mt-1 dark:bg-indigo-500/10 dark:border-indigo-500/20">
                                    <p className="text-[10px] font-semibold text-indigo-800 dark:text-indigo-400">
                                        Room Move: {room.room_move_from} → {room.room_number}
                                    </p>
                                    {room.room_move_reason && (
                                        <p className="text-[10px] text-indigo-700 dark:text-indigo-300 truncate">
                                            Reason: {room.room_move_reason}
                                        </p>
                                    )}
                                </div>
                            )}
                            {hasTransferAlertCandidate && room.transfer_pickup_at && (
                                <div className="rounded-md border border-sky-200 bg-sky-50 px-2 py-1 mt-1 dark:bg-sky-500/10 dark:border-sky-500/20">
                                    <p className="text-[10px] font-semibold text-sky-700 dark:text-sky-400">
                                        {room.transfer_type_icon ?? "🚗"} Transfer {formatBangkokTime(room.transfer_pickup_at)}
                                    </p>
                                    <p className="text-[10px] text-sky-600 dark:text-sky-300">
                                        Status: {room.transfer_status}
                                    </p>
                                </div>
                            )}
                            {hasDayUseAlertCandidate && room.dayuse_expires_at && (
                                <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 mt-1 dark:bg-amber-500/10 dark:border-amber-500/20">
                                    <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                                        ⏱ Day Use ends {formatBangkokTime(room.dayuse_expires_at)}
                                    </p>
                                    {room.dayuse_timer_state && (
                                        <p className="text-[10px] text-amber-600 dark:text-amber-300">
                                            State: {room.dayuse_timer_state}
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                    {groupPeers.length > 1 && (
                        <div className="mt-2 border-t border-[var(--border-subtle)] pt-2">
                            <div className="flex items-center justify-between gap-2 mb-1">
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-600">
                                    {room.group_code ?? (room.linked_root_id ? "Linked Stay" : "Group")}
                                </span>
                                <span className="text-[10px] text-[var(--text-muted)]">
                                    {groupPeers.length} room{groupPeers.length !== 1 ? "s" : ""}
                                </span>
                            </div>
                            <div className="max-h-20 overflow-auto space-y-0.5">
                                {groupPeers.map((peer) => (
                                    <div key={`${roomLinkKey ?? "single"}-${peer.room_number}`} className="text-[10px] text-[var(--text-secondary)] flex items-center justify-between gap-2">
                                        <span className="font-semibold text-[var(--text-table-cell)]">Room {peer.room_number}</span>
                                        <span className="truncate text-[var(--text-secondary)]">{peer.guest_name ?? "—"}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {isBlocked && room.closure_reason && (
                        <p className="text-[10px] text-rose-600 mt-1">{room.closure_reason}</p>
                    )}
                </div>,
                document.body
            )}
        </div>
    );
}

/* ─── Main Board Page ─────────────────────────── */
export default function BoardPage() {
    const [data, setData] = useState<BoardData | null>(null);
    const [dayUseData, setDayUseData] = useState<{ rooms: DayUseRoomStatus[]; settings: DayUseSettings } | null>(null);
    const [dayUseCheckinRoom, setDayUseCheckinRoom] = useState<{ room_id: string; room_number: string } | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [dayUseError, setDayUseError] = useState("");
    const [toast, setToast] = useState("");
    const [nowMs, setNowMs] = useState(() => Date.now());
    const [activeFilters, setActiveFilters] = useState<FilterKey[]>(["all"]);
    const [selectedRoom, setSelectedRoom] = useState<ApiRoom | null>(null);
    const [drawerRoom, setDrawerRoom] = useState<RoomDrawerRoom | null>(null);
    const [detailMode, setDetailMode] = useState<"create" | "edit" | "checkin" | null>(null);
    const [detailResId, setDetailResId] = useState<string | undefined>();
    const [detailRoomNumber, setDetailRoomNumber] = useState<string | undefined>();
    const [viewMode, setViewMode] = useState<"compact" | "detail">("compact");
    const [hideFadedRooms, setHideFadedRooms] = useState(false);
    const [showHkDirtyLayer, setShowHkDirtyLayer] = useState(true);
    const [showHkInHouseLayer, setShowHkInHouseLayer] = useState(false);
    const [mobileSheet, setMobileSheet] = useState<ApiRoom | null>(null);
    const [showLegend, setShowLegend] = useState(false);
    const [isMobile, setIsMobile] = useState(false);
    const [hoverGroupId, setHoverGroupId] = useState<string | null>(null);
    const [dateOffset, setDateOffset] = useState<DateViewOffset>(0);
    const [baseBusinessDate, setBaseBusinessDate] = useState<string | null>(null);
    const refreshRef = useRef(0);
    const dayUseSnapshotRef = useRef<{ rooms: DayUseRoomStatus[]; settings: DayUseSettings } | null>(null);
    const isReadOnlyDiaryView = dateOffset !== 0;
    const isHistoricalDiaryView = dateOffset !== 0;
    const requestedBoardDate =
        dateOffset === 0
            ? null
            : (baseBusinessDate ? shiftDateString(baseBusinessDate, dateOffset) : null);

    // Detect touch/mobile device
    useEffect(() => {
        const mq = window.matchMedia("(pointer: coarse)");
        setIsMobile(mq.matches);
        const h = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mq.addEventListener("change", h);
        return () => mq.removeEventListener("change", h);
    }, []);

    // Restore persisted viewMode
    useEffect(() => {
        const saved = localStorage.getItem("board-view-mode") as "compact" | "detail" | null;
        if (saved) setViewMode(saved);
        const savedDirtyLayer = localStorage.getItem("board-hk-dirty-layer");
        if (savedDirtyLayer === "0") setShowHkDirtyLayer(false);
        const savedInHouseLayer = localStorage.getItem("board-hk-inhouse-layer");
        if (savedInHouseLayer === "1") setShowHkInHouseLayer(true);
    }, []);

    // Persist viewMode on change
    useEffect(() => {
        localStorage.setItem("board-view-mode", viewMode);
    }, [viewMode]);

    useEffect(() => {
        if (isHistoricalDiaryView) return;
        const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [isHistoricalDiaryView]);

    useEffect(() => {
        localStorage.setItem("board-hk-dirty-layer", showHkDirtyLayer ? "1" : "0");
    }, [showHkDirtyLayer]);

    useEffect(() => {
        localStorage.setItem("board-hk-inhouse-layer", showHkInHouseLayer ? "1" : "0");
    }, [showHkInHouseLayer]);

    useEffect(() => {
        dayUseSnapshotRef.current = dayUseData;
    }, [dayUseData]);

    const loadBoard = useCallback(async () => {
        try {
            const params = new URLSearchParams();
            if (requestedBoardDate) params.set("date", requestedBoardDate);
            const boardUrl = params.toString() ? `/api/board?${params.toString()}` : "/api/board";
            const res = await fetch(boardUrl);
            const d = await res.json();
            if (d.success) {
                setData(d);
                if (dateOffset === 0 && typeof d.date === "string") {
                    setBaseBusinessDate(d.date);
                }
            }
            else setError("Failed to load board.");
        } catch {
            setError("Network error.");
        } finally {
            setLoading(false);
        }
    }, [dateOffset, requestedBoardDate]);

    const loadDayUse = useCallback(async () => {
        if (dateOffset === 1) {
            setDayUseError("");
            setDayUseData(null);
            return;
        }
        try {
            const dayUseParams = new URLSearchParams();
            if (requestedBoardDate) dayUseParams.set("date", requestedBoardDate);
            const dayUseUrl = dayUseParams.toString() ? `/api/dayuse/status?${dayUseParams.toString()}` : "/api/dayuse/status";
            const res = await fetch(dayUseUrl);
            const d = await res.json();
            if (!res.ok || !d.success) {
                setDayUseError(d.error ?? "Failed to load Day Use rooms.");
                return;
            }
            setDayUseError("");

            const incoming = {
                rooms: (d.rooms ?? []) as DayUseRoomStatus[],
                settings: d.settings as DayUseSettings,
            };
            const previous = dayUseSnapshotRef.current;

            if (isHistoricalDiaryView) {
                setDayUseData(incoming);
                return;
            }

            if (!previous) {
                setDayUseData(incoming);
                return;
            }

            const incomingByRoomId = new Map(incoming.rooms.map((room) => [room.room_id, room]));
            let statusChanged = previous.rooms.length !== incoming.rooms.length;

            if (!statusChanged) {
                for (const prevRoom of previous.rooms) {
                    const nextRoom = incomingByRoomId.get(prevRoom.room_id);
                    if (!nextRoom) {
                        statusChanged = true;
                        break;
                    }
                    const prevResId = prevRoom.current_reservation?.id ?? null;
                    const nextResId = nextRoom.current_reservation?.id ?? null;
                    if (
                        prevRoom.is_available !== nextRoom.is_available ||
                        (prevRoom.hk_status ?? null) !== (nextRoom.hk_status ?? null) ||
                        prevResId !== nextResId
                    ) {
                        statusChanged = true;
                        break;
                    }
                }
            }

            if (statusChanged) {
                setDayUseData(incoming);
                const boardParams = new URLSearchParams();
                if (requestedBoardDate) boardParams.set("date", requestedBoardDate);
                const boardUrl = boardParams.toString() ? `/api/board?${boardParams.toString()}` : "/api/board";
                const boardRes = await fetch(boardUrl);
                const boardData = await boardRes.json();
                if (boardData.success) setData(boardData);
                return;
            }

            const mergedRooms = previous.rooms.map((prevRoom) => {
                const nextRoom = incomingByRoomId.get(prevRoom.room_id);
                if (!nextRoom) return prevRoom;
                const mergedReservation = prevRoom.current_reservation && nextRoom.current_reservation
                    ? {
                        ...prevRoom.current_reservation,
                        checked_in_at: nextRoom.current_reservation.checked_in_at,
                        dayuse_expires_at: nextRoom.current_reservation.dayuse_expires_at,
                    }
                    : prevRoom.current_reservation;

                return {
                    ...prevRoom,
                    timer_state: nextRoom.timer_state,
                    sessions_today: nextRoom.sessions_today,
                    current_reservation: mergedReservation,
                };
            });

            setDayUseData({
                settings: incoming.settings,
                rooms: mergedRooms,
            });
        } catch {
            setDayUseError("Day Use status sync failed.");
        }
    }, [dateOffset, requestedBoardDate, isHistoricalDiaryView]);

    useEffect(() => {
        loadDayUse();
        if (dateOffset !== 0) return;
        const handleVisibilityChange = () => {
            if (document.visibilityState === "visible") {
                loadDayUse();
            }
        };
        const interval = window.setInterval(() => {
            if (canPollVisibleTab()) {
                loadDayUse();
            }
        }, strictPollInterval(60_000, STRICT_POLLING.boardDayUseMs));
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            document.removeEventListener("visibilitychange", handleVisibilityChange);
            window.clearInterval(interval);
        };
    }, [dateOffset, loadDayUse]);

    useEffect(() => { loadBoard(); }, [loadBoard]);

    function showToast(message: string) {
        setToast(message);
        window.setTimeout(() => setToast(""), 3000);
    }

    function refresh() {
        refreshRef.current += 1;
        loadBoard();
        loadDayUse();
    }

    useEffect(() => {
        if (!isReadOnlyDiaryView) return;
        setDrawerRoom(null);
        setSelectedRoom(null);
        setMobileSheet(null);
    }, [isReadOnlyDiaryView]);

    function openDayUseDrawer(dayUseRoom: DayUseRoomStatus) {
        const mappedRoom = mapDayUseToApiRoom(dayUseRoom);
        setSelectedRoom(mappedRoom);
        setDrawerRoom({
            room_id: dayUseRoom.room_id,
            room_number: dayUseRoom.room_number,
            room_type: "",
            sellable: true,
            closure_reason: null,
            status: mappedRoom.status,
            diary_state: mappedRoom.diary_state ?? null,
            hk_status: dayUseRoom.hk_status ?? null,
            hk_task_seq: null,
            hk_assigned_maid: null,
            hk_started_at: null,
            hk_finished_at: null,
            hk_approved_at: null,
            hk_is_no_service: false,
            hk_no_service_note: null,
            transfer_pickup_at: null,
            transfer_type_icon: null,
            transfer_status: null,
            transfer_id: null,
            transfer_guest_note: null,
            transfer_alert_enabled: true,
            transfer_alert_lead_min: DEFAULT_TRANSPORT_ALERT_LEAD_MINUTES,
            is_dayuse: true,
            reservation: dayUseRoom.current_reservation
                ? {
                    id: dayUseRoom.current_reservation.id,
                    booking_code: dayUseRoom.current_reservation.booking_code,
                    guest_name: dayUseRoom.current_reservation.guest_name,
                    phone: dayUseRoom.current_reservation.phone,
                    room_type_id: null,
                    source: "walkin",
                    checkin_date: data?.date ?? "",
                    checkout_date: data?.date ?? "",
                    expected_arrival_time: null,
                    total_price: dayUseRoom.current_reservation.total_price,
                    note: null,
                    deposit_amount: 0,
                    deposit_note: null,
                    deposit_paid_at: null,
                    deposit_paid_date: null,
                    dayuse_status: dayUseRoom.current_reservation.status,
                    checked_in_at: dayUseRoom.current_reservation.checked_in_at,
                    dayuse_expires_at: dayUseRoom.current_reservation.dayuse_expires_at,
                }
                : null,
        });
    }

    async function openDrawer(room: ApiRoom) {
        setSelectedRoom(room);
        if (!room.reservation_id) {
            setDrawerRoom({
                room_id: room.room_id,
                room_number: room.room_number,
                room_type: room.room_type,
                sellable: room.sellable,
                closure_reason: room.closure_reason,
                status: room.status,
                diary_state: room.diary_state ?? null,
                hk_status: room.hk_status ?? null,
                hk_task_seq: room.hk_task_seq ?? null,
                hk_assigned_maid: room.hk_assigned_maid ?? null,
                hk_started_at: room.hk_started_at ?? null,
                hk_finished_at: room.hk_finished_at ?? null,
                hk_approved_at: room.hk_approved_at ?? null,
                hk_is_no_service: room.hk_is_no_service ?? false,
                hk_no_service_note: room.hk_no_service_note ?? null,
                transfer_pickup_at: room.transfer_pickup_at ?? null,
                transfer_type_icon: room.transfer_type_icon ?? null,
                transfer_status: room.transfer_status ?? null,
                transfer_id: room.transfer_id ?? null,
                transfer_guest_note: room.transfer_guest_note ?? null,
                transfer_alert_enabled: room.transfer_alert_enabled ?? true,
                transfer_alert_lead_min: room.transfer_alert_lead_min ?? DEFAULT_TRANSPORT_ALERT_LEAD_MINUTES,
                reservation: null
            });
            return;
        }

        try {
            const res = await fetch(`/api/bookings/${room.reservation_id}`);
            const d = await res.json();
            const reservation = d?.success ? d.reservation : null;
            const linkedStay = d?.success ? (d.linked_stay ?? reservation?.linked_stay ?? null) : null;
            setDrawerRoom({
                room_id: room.room_id,
                room_number: room.room_number,
                room_type: room.room_type,
                sellable: room.sellable,
                closure_reason: room.closure_reason,
                status: room.status,
                diary_state: room.diary_state ?? null,
                hk_status: room.hk_status ?? null,
                hk_task_seq: room.hk_task_seq ?? null,
                hk_assigned_maid: room.hk_assigned_maid ?? null,
                hk_started_at: room.hk_started_at ?? null,
                hk_finished_at: room.hk_finished_at ?? null,
                hk_approved_at: room.hk_approved_at ?? null,
                hk_is_no_service: room.hk_is_no_service ?? false,
                hk_no_service_note: room.hk_no_service_note ?? null,
                transfer_pickup_at: room.transfer_pickup_at ?? null,
                transfer_type_icon: room.transfer_type_icon ?? null,
                transfer_status: room.transfer_status ?? null,
                transfer_id: room.transfer_id ?? null,
                transfer_guest_note: room.transfer_guest_note ?? null,
                transfer_alert_enabled: room.transfer_alert_enabled ?? true,
                transfer_alert_lead_min: room.transfer_alert_lead_min ?? DEFAULT_TRANSPORT_ALERT_LEAD_MINUTES,
                reservation: reservation
                    ? {
                        id: String(reservation.id),
                        booking_code: String(reservation.booking_code ?? ""),
                        guest_name: String(reservation.guest_name ?? ""),
                        phone: reservation.phone ?? null,
                        room_type_id: reservation.room_type_id ? String(reservation.room_type_id) : null,
                        parent_reservation_id: reservation.parent_reservation_id ?? null,
                        source: normalizeBookingSource(reservation.source),
                        checkin_date: String(reservation.checkin_date ?? ""),
                        checkout_date: String(reservation.checkout_date ?? ""),
                        expected_arrival_time: reservation.expected_arrival_time ?? null,
                        checked_in_at: reservation.checked_in_at ?? null,
                        total_price: Number(reservation.total_price ?? 0),
                        discount_type: reservation.discount_type ?? "percent",
                        discount_value: Number(reservation.discount_value ?? reservation.discount_percent ?? 0),
                        discount_percent: Number(reservation.discount_percent ?? 0),
                        note: reservation.note ?? null,
                        deposit_amount: Number(reservation.deposit_amount ?? 0),
                        deposit_note: reservation.deposit_note ?? null,
                        deposit_paid_at: reservation.deposit_paid_at ?? null,
                        deposit_paid_date: reservation.deposit_paid_date ?? null,
                        do_not_move_assigned_room: Boolean(reservation.do_not_move_assigned_room),
                        do_not_move_reason: reservation.do_not_move_reason ?? null,
                        do_not_move_room_id_snapshot: reservation.do_not_move_room_id_snapshot ?? null,
                        do_not_move_room_number_snapshot: reservation.do_not_move_room_number_snapshot ?? null,
                        do_not_move_set_at: reservation.do_not_move_set_at ?? null,
                        do_not_move_set_by: reservation.do_not_move_set_by ?? null,
                        linked_stay: linkedStay,
                    }
                    : null
            });
        } catch {
            setDrawerRoom({
                room_id: room.room_id,
                room_number: room.room_number,
                room_type: room.room_type,
                sellable: room.sellable,
                closure_reason: room.closure_reason,
                status: room.status,
                diary_state: room.diary_state ?? null,
                hk_status: room.hk_status ?? null,
                hk_task_seq: room.hk_task_seq ?? null,
                hk_assigned_maid: room.hk_assigned_maid ?? null,
                hk_started_at: room.hk_started_at ?? null,
                hk_finished_at: room.hk_finished_at ?? null,
                hk_approved_at: room.hk_approved_at ?? null,
                hk_is_no_service: room.hk_is_no_service ?? false,
                hk_no_service_note: room.hk_no_service_note ?? null,
                transfer_pickup_at: room.transfer_pickup_at ?? null,
                transfer_type_icon: room.transfer_type_icon ?? null,
                transfer_status: room.transfer_status ?? null,
                transfer_id: room.transfer_id ?? null,
                transfer_guest_note: room.transfer_guest_note ?? null,
                transfer_alert_enabled: room.transfer_alert_enabled ?? true,
                transfer_alert_lead_min: room.transfer_alert_lead_min ?? DEFAULT_TRANSPORT_ALERT_LEAD_MINUTES,
                reservation: null
            });
        }
    }

    function closeDrawer() {
        setDrawerRoom(null);
        setSelectedRoom(null);
    }

    const groupPeersById = new Map<string, ApiRoom[]>();
    (data?.rooms ?? []).forEach((room) => {
        const groupId = resolveRoomLinkKey(room);
        if (!groupId) return;
        const peers = groupPeersById.get(groupId) ?? [];
        peers.push(room);
        groupPeersById.set(groupId, peers);
    });
    groupPeersById.forEach((peers) => {
        peers.sort((a, b) => a.room_number.localeCompare(b.room_number, undefined, { numeric: true }));
    });

    function resolveGroupHighlight(room: ApiRoom): "none" | "focus" | "fade" {
        if (!hoverGroupId) return "none";
        const groupId = resolveRoomLinkKey(room);
        return groupId === hoverGroupId ? "focus" : "fade";
    }

    // Group rooms by floor → then split by wing
    const roomsByFloor = FLOOR_ORDER.map((floor) => {
        const allFloor = (data?.rooms ?? []).filter(
            (r) => r.room_number.startsWith(floor.prefix)
        );
        const visibleRooms = hideFadedRooms
            ? allFloor.filter((r) => matchesAnyFilter(r, activeFilters))
            : allFloor;
        return {
            ...floor,
            hasRooms: visibleRooms.length > 0 || (floor.prefix === "1" && (dayUseData?.rooms?.length ?? 0) > 0),
            leftWing: visibleRooms.filter(r => !r.wing || r.wing === "L"),
            rightWing: visibleRooms.filter(r => r.wing === "R"),
        };
    });

    function toggleFilter(key: FilterKey) {
        setActiveFilters((prev) => {
            if (key === "all") return ["all"];
            const next = new Set(prev.filter((f) => f !== "all"));
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next.size > 0 ? Array.from(next) : ["all"];
        });
    }

    const counts = data?.counts;

    const renderDayUseRoomCard = (r: DayUseRoomStatus) => {
        const mapped = mapDayUseToApiRoom(r);
        return (
            <RoomCard
                key={`dayuse-${r.room_number}`}
                room={mapped}
                viewMode={viewMode}
                isMobile={isMobile}
                hkLayerEnabled={showHkDirtyLayer}
                hkInHouseLayerEnabled={showHkInHouseLayer}
                boardDate={data?.date ?? null}
                nowMs={nowMs}
                alertsEnabled={!isHistoricalDiaryView}
                isMatched={matchesAnyFilter(mapped, activeFilters)}
                groupHighlight={resolveGroupHighlight(mapped)}
                groupPeers={[]}
                onGroupHoverChange={setHoverGroupId}
                selected={selectedRoom?.room_number === mapped.room_number}
                clickable={!isReadOnlyDiaryView}
                onClick={() => {
                    if (isReadOnlyDiaryView) return;
                    isMobile ? setMobileSheet(mapped) : openDayUseDrawer(r);
                }}
            />
        );
    };

    return (
        <div className="space-y-5 w-full">
            <NightAuditPendingPopup pageName="Room Rack" />
            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-widest text-brand-600">Front Desk</p>
                    <h1 className="text-2xl font-bold text-[var(--text-primary)] mt-0.5">Room Rack</h1>
                    {data && (
                        <p className="text-xs text-[var(--text-muted)] mt-1">
                            {data.date} · {data.rooms.filter((r) => r.sellable).length} sellable rooms
                        </p>
                    )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    {/* Date Quick View (Yesterday / Today / Tomorrow) */}
                    <div className="flex border border-[var(--border-default)] rounded-lg p-0.5 bg-[var(--bg-muted)] text-xs">
                        {([
                            { label: "Yesterday", offset: -1 as DateViewOffset },
                            { label: "Today", offset: 0 as DateViewOffset },
                            { label: "Tomorrow", offset: 1 as DateViewOffset },
                        ]).map((opt) => (
                            <button
                                key={opt.label}
                                onClick={() => setDateOffset(opt.offset)}
                                disabled={!baseBusinessDate && opt.offset !== 0}
                                className={`px-3 py-1.5 rounded-md font-medium transition ${dateOffset === opt.offset
                                    ? opt.offset === 0
                                        ? "bg-[var(--bg-surface)] shadow text-[var(--text-primary)] dark:bg-brand-500/20 dark:text-brand-400"
                                        : "bg-rose-600 text-white shadow dark:bg-rose-500/30 dark:text-rose-400 border-none"
                                    : "text-[var(--text-secondary)] hover:text-[var(--text-table-cell)]"
                                    } ${!baseBusinessDate && opt.offset !== 0 ? "opacity-50 cursor-not-allowed" : ""}`}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>
                    {/* View Mode Toggle */}
                    <div className="flex border border-[var(--border-default)] rounded-lg p-0.5 bg-[var(--bg-muted)] text-xs">
                        {(["compact", "detail"] as const).map(mode => (
                            <button
                                key={mode}
                                onClick={() => setViewMode(mode)}
                                className={`px-3 py-1.5 rounded-md font-medium capitalize transition ${viewMode === mode
                                    ? "bg-[var(--bg-surface)] shadow text-[var(--text-primary)]"
                                    : "text-[var(--text-secondary)] hover:text-[var(--text-table-cell)]"
                                    }`}
                            >
                                {mode === "compact" ? "⊞ Compact" : "☰ Detail"}
                            </button>
                        ))}
                    </div>
                    {/* Legend */}
                    <button
                        onClick={() => setHideFadedRooms((v) => !v)}
                        className={`btn text-xs border border-[var(--border-default)] ${hideFadedRooms ? "btn-secondary" : "btn-ghost"}`}
                    >
                        {hideFadedRooms ? "Show Faded Rooms" : "Hide Faded Rooms"}
                    </button>
                    <button
                        onClick={() => setShowLegend(true)}
                        className="btn btn-ghost text-xs border border-[var(--border-default)]"
                    >
                        ? Legend
                    </button>
                    {/* New Booking */}
                    <button
                        className={`btn btn-primary ${isReadOnlyDiaryView ? "opacity-60 cursor-not-allowed" : ""}`}
                        disabled={isReadOnlyDiaryView}
                        onClick={() => {
                            if (isReadOnlyDiaryView) return;
                            setDetailMode("create");
                            setDetailResId(undefined);
                            setDetailRoomNumber(undefined);
                        }}
                    >
                        + New Booking
                    </button>
                </div>
            </div>

            {/* Count chips */}
            {counts && (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex flex-wrap gap-2">
                        {FILTERS.map((f) => {
                            const count = (data?.rooms ?? []).filter(r => matchesFilter(r, f.key)).length;
                            const isActive = activeFilters.includes(f.key);
                            return (
                                <button
                                    key={f.key}
                                    onClick={() => toggleFilter(f.key)}
                                    className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${isActive
                                        ? f.key === "available_now" || f.key === "available" ? "border-emerald-400 bg-emerald-600 text-white dark:bg-emerald-500/20 dark:text-emerald-400 dark:border-emerald-500/40"
                                            : f.key === "due_in" ? "border-sky-400 bg-sky-600 text-white dark:bg-sky-500/20 dark:text-sky-400 dark:border-sky-500/40"
                                                : f.key === "inhouse" ? "border-amber-400 bg-amber-600 text-white dark:bg-amber-500/20 dark:text-amber-400 dark:border-amber-500/40"
                                                    : f.key === "back_to_back" ? "border-indigo-400 bg-indigo-600 text-white dark:bg-indigo-500/20 dark:text-indigo-400 dark:border-indigo-500/40"
                                                        : f.key === "due_out" || f.key === "dirty" ? "border-rose-400 bg-rose-600 text-white dark:bg-rose-500/20 dark:text-rose-400 dark:border-rose-500/40"
                                                            : "border-brand-400 bg-brand-600 text-white dark:bg-brand-500/20 dark:text-brand-400 dark:border-brand-500/40"
                                        : "border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]"
                                        }`}
                                >
                                    {f.label} {count > 0 && `(${count})`}
                                </button>
                            );
                        })}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            onClick={() => setShowHkDirtyLayer((v) => !v)}
                            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${showHkDirtyLayer
                                ? "border-rose-300 bg-rose-50 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400 dark:border-rose-500/30"
                                : "border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]"
                                }`}
                            title="Toggle housekeeping stripe layer on room cards"
                        >
                            HK Layer {showHkDirtyLayer ? "ON" : "OFF"}
                        </button>
                        <button
                            onClick={() => setShowHkInHouseLayer((v) => !v)}
                            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${showHkInHouseLayer
                                ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-400/40 dark:bg-amber-400/15 dark:text-amber-300"
                                : "border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]"
                                }`}
                            title="Toggle stayover housekeeping decision layer on room cards"
                        >
                            HK In-house {showHkInHouseLayer ? "ON" : "OFF"}
                        </button>
                    </div>
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                    {error}
                </div>
            )}
            {dayUseError && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    Day Use unavailable: {dayUseError}
                </div>
            )}
            {isHistoricalDiaryView && requestedBoardDate && (
                <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-800 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-300">
                    Historical mode for <span className="font-semibold">{requestedBoardDate}</span>. This view is read-only and hides live alerts, countdowns, and real-time status changes.
                </div>
            )}
            {!dayUseError && dayUseData && dayUseData.rooms.length === 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    Day Use configured but no mapped rooms found. Check `rooms.is_dayuse = true` for your Day Use rooms.
                </div>
            )}

            {/* Loading skeleton */}
            {loading && (
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
                    {Array.from({ length: 24 }).map((_, i) => (
                        <div key={i} className="h-[100px] animate-pulse rounded-xl bg-[var(--bg-muted)]" />
                    ))}
                </div>
            )}

            {/* Floor sections */}
            {!loading &&
                roomsByFloor.map((floor, fi) => {
                    if (!floor.hasRooms) return null;
                    const floorDayUseRooms = floor.prefix === "1" ? (dayUseData?.rooms ?? []) : [];
                    const attachDayUseToLeftRow =
                        floor.prefix === "1" && floorDayUseRooms.length > 0 && floor.rightWing.length === 0;
                    const rightRowDayUseRooms = attachDayUseToLeftRow ? [] : floorDayUseRooms;
                    return (
                        <div key={floor.label} className={fi > 0 ? "floor-gap" : ""}>
                            <p className="text-xs font-bold uppercase tracking-widest text-[var(--text-muted)] mb-3">
                                {floor.label}
                            </p>
                            {/* Scrollable container — holds both wings, never wraps */}
                            <div className="overflow-x-auto pt-2 pb-1">
                                <div className="flex flex-col gap-1.5 min-w-max">
                                    {/* L wing row */}
                                    {floor.leftWing.length > 0 && (
                                        <div className={`flex flex-nowrap ${viewMode === "compact" ? "gap-1" : "gap-1.5"}`}>
                                            {floor.leftWing.map((room) => {
                                                const roomLinkKey = resolveRoomLinkKey(room);
                                                return (
                                                <RoomCard
                                                    key={room.room_number}
                                                    room={room}
                                                    viewMode={viewMode}
                                                    isMobile={isMobile}
                                                    hkLayerEnabled={showHkDirtyLayer}
                                                    hkInHouseLayerEnabled={showHkInHouseLayer}
                                                    boardDate={data?.date ?? null}
                                                    nowMs={nowMs}
                                                    alertsEnabled={!isHistoricalDiaryView}
                                                    isMatched={matchesAnyFilter(room, activeFilters)}
                                                    groupHighlight={resolveGroupHighlight(room)}
                                                    groupPeers={
                                                        roomLinkKey
                                                            ? (groupPeersById.get(roomLinkKey) ?? [])
                                                            : []
                                                    }
                                                    onGroupHoverChange={setHoverGroupId}
                                                    selected={selectedRoom?.room_number === room.room_number}
                                                    clickable={!isReadOnlyDiaryView}
                                                    onClick={() => {
                                                        if (isReadOnlyDiaryView) return;
                                                        isMobile ? setMobileSheet(room) : openDrawer(room);
                                                    }}
                                                />
                                                );
                                            })}
                                            {attachDayUseToLeftRow && (
                                                <>
                                                    <div className="mx-1 flex items-stretch">
                                                        <div className="h-full border-l-2 border-dashed border-rose-300" />
                                                    </div>
                                                    {floorDayUseRooms.map(renderDayUseRoomCard)}
                                                </>
                                            )}
                                        </div>
                                    )}
                                    {/* Corridor divider */}
                                    {floor.leftWing.length > 0 && floor.rightWing.length > 0 && (
                                        <div className="flex items-center gap-1 px-1">
                                            <div className="flex-1 border-t border-dashed border-[var(--border-default)]" />
                                            <span className="text-[9px] text-[var(--text-muted)] font-semibold tracking-widest">CORRIDOR</span>
                                            <div className="flex-1 border-t border-dashed border-[var(--border-default)]" />
                                        </div>
                                    )}
                                    {/* R wing row */}
                                    {(floor.rightWing.length > 0 || rightRowDayUseRooms.length > 0) && (
                                        <div className={`flex flex-nowrap ${viewMode === "compact" ? "gap-1" : "gap-1.5"}`}>
                                            {floor.rightWing.map((room) => {
                                                const roomLinkKey = resolveRoomLinkKey(room);
                                                return (
                                                <RoomCard
                                                    key={room.room_number}
                                                    room={room}
                                                    viewMode={viewMode}
                                                    isMobile={isMobile}
                                                    hkLayerEnabled={showHkDirtyLayer}
                                                    hkInHouseLayerEnabled={showHkInHouseLayer}
                                                    boardDate={data?.date ?? null}
                                                    nowMs={nowMs}
                                                    alertsEnabled={!isHistoricalDiaryView}
                                                    isMatched={matchesAnyFilter(room, activeFilters)}
                                                    groupHighlight={resolveGroupHighlight(room)}
                                                    groupPeers={
                                                        roomLinkKey
                                                            ? (groupPeersById.get(roomLinkKey) ?? [])
                                                            : []
                                                    }
                                                    onGroupHoverChange={setHoverGroupId}
                                                    selected={selectedRoom?.room_number === room.room_number}
                                                    clickable={!isReadOnlyDiaryView}
                                                    onClick={() => {
                                                        if (isReadOnlyDiaryView) return;
                                                        isMobile ? setMobileSheet(room) : openDrawer(room);
                                                    }}
                                                />
                                                );
                                            })}

                                            {rightRowDayUseRooms.length > 0 && (
                                                <>
                                                    <div className="mx-1 flex items-stretch">
                                                        <div className="h-full border-l-2 border-dashed border-rose-300" />
                                                    </div>
                                                    {rightRowDayUseRooms.map(renderDayUseRoomCard)}
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}

            {/* Room Drawer */}
            {drawerRoom && (
                <RoomDrawer
                    room={drawerRoom}
                    onClose={closeDrawer}
                    onRefresh={refresh}
                    onDayUseCheckin={(payload) => {
                        setDayUseCheckinRoom(payload);
                        closeDrawer();
                    }}
                />
            )}

            {/* Reservation Detail Page */}
            {detailMode && (
                <ReservationDetailPage
                    key={`${detailMode}:${detailResId ?? "new"}:${detailRoomNumber ?? "noroom"}`}
                    mode={detailMode}
                    reservationId={detailResId}
                    roomNumber={detailRoomNumber}
                    onOpenCheckin={(newReservationId) => {
                        setDetailMode("checkin");
                        setDetailResId(newReservationId);
                        setDetailRoomNumber(undefined);
                        refresh();
                    }}
                    onClose={() => { setDetailMode(null); setDetailResId(undefined); setDetailRoomNumber(undefined); }}
                    onSuccess={() => { setDetailMode(null); setDetailResId(undefined); setDetailRoomNumber(undefined); refresh(); }}
                />
            )}

            {dayUseCheckinRoom && (
                <DayUseCheckinSidebar
                    roomId={dayUseCheckinRoom.room_id}
                    roomNumber={dayUseCheckinRoom.room_number}
                    onClose={() => setDayUseCheckinRoom(null)}
                    onSuccess={() => { setDayUseCheckinRoom(null); refresh(); }}
                />
            )}

            {/* Mobile Bottom Sheet */}
            {mobileSheet && (
                <div
                    className="fixed inset-0 z-50 bg-black/40 flex items-end"
                    onClick={() => setMobileSheet(null)}
                >
                    <div
                        className="w-full bg-[var(--bg-surface)] rounded-t-2xl p-5 pb-8 shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="w-8 h-1 bg-[var(--bg-muted)] rounded-full mx-auto mb-4" />
                        {(() => {
                            const r = mobileSheet;
                            const s = STATUS_STYLE[r.status] ?? STATUS_STYLE.closed;
                            const diaryState = r.diary_state ?? (
                                r.status === "reserved"
                                    ? "inhouse"
                                    : r.status === "available"
                                    ? "available"
                                        : null
                            );
                            const diary = diaryState ? DIARY_STYLE[diaryState] : null;
                            const linkedStayCheckin = r.linked_full_checkin ?? r.guest_checkin_date ?? null;
                            const linkedStayCheckout = r.linked_full_checkout ?? r.guest_checkout_date ?? null;
                            return (
                                <>
                                    <div className="flex items-center gap-2 mb-3">
                                        <span className="text-xl font-bold text-[var(--text-primary)]">{r.room_number}</span>
                                        <span className={`badge ${s.badge} text-xs`}>{s.label}</span>
                                        {diary && (
                                            <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${diary.chipClass}`}>
                                                <span className={`font-black ${diary.symbolClass}`}>{diary.symbol}</span>
                                                {diary.label}
                                            </span>
                                        )}
                                        <span className="text-sm text-[var(--text-muted)]">{r.room_type}</span>
                                    </div>
                                    {r.status === "reserved" && (
                                        <div className="space-y-1 mb-4">
                                            {r.guest_name && <p className="text-sm font-semibold text-[var(--text-primary)]">{r.guest_name}</p>}
                                            {r.booking_code && <p className="text-xs font-mono text-[var(--text-secondary)]">{r.booking_code}</p>}
                                            {linkedStayCheckin && linkedStayCheckout && (
                                                <p className="text-xs text-[var(--text-muted)]">
                                                    {formatDateRangeDisplay(linkedStayCheckin, linkedStayCheckout)}
                                                </p>
                                            )}
                                            {r.source && <p className="text-xs text-[var(--text-secondary)]">{SOURCE_LABEL[r.source] ?? r.source}</p>}
                                        </div>
                                    )}
                                    <div className="flex gap-2">
                                        <button
                                            className={`btn btn-primary flex-1 ${isReadOnlyDiaryView ? "opacity-60 cursor-not-allowed" : ""}`}
                                            disabled={isReadOnlyDiaryView}
                                            onClick={() => {
                                                if (isReadOnlyDiaryView) return;
                                                openDrawer(r);
                                                setMobileSheet(null);
                                            }}
                                        >
                                            Open Details
                                        </button>
                                        <button className="btn btn-ghost" onClick={() => setMobileSheet(null)}>
                                            Close
                                        </button>
                                    </div>
                                </>
                            );
                        })()}
                    </div>
                </div>
            )}

            {/* Legend Modal */}
            {showLegend && (
                <div
                    className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
                    onClick={() => setShowLegend(false)}
                >
                    <div
                        className="bg-[var(--bg-surface)] rounded-2xl p-6 w-full max-w-sm shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 className="text-base font-bold text-[var(--text-primary)] mb-4">Status Legend</h3>
                        <div className="mb-4 space-y-2.5">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Diary Symbols</p>
                            {(Object.entries(DIARY_STYLE) as [DiaryState, typeof DIARY_STYLE[DiaryState]][]).map(([key, val]) => (
                                <div key={key} className="flex items-center gap-3">
                                    <span className={`inline-flex items-center justify-center w-24 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${val.chipClass}`}>
                                        <span className={`mr-1 font-black ${val.symbolClass}`}>{val.symbol}</span>
                                        {val.label}
                                    </span>
                                    <span className="text-xs text-[var(--text-secondary)]">
                                        {key === "available" ? "Room is empty, no assigned booking" :
                                            key === "due_in" ? "Assigned arrival expected today" :
                                                key === "inhouse" ? "Checked-in guest staying in room" :
                                                    key === "back_to_back" ? "Departure and arrival on same room today" :
                                                        "Departure expected today with no incoming guest"}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <div className="space-y-2.5">
                            {(Object.entries(STATUS_STYLE) as [RoomStatus, typeof STATUS_STYLE[RoomStatus]][]).map(([key, val]) => (
                                <div key={key} className="flex items-center gap-3">
                                    <span className={`badge ${val.badge} text-[10px] w-24 text-center shrink-0`}>
                                        {val.label}
                                    </span>
                                    <span className="text-xs text-[var(--text-secondary)]">
                                        {key === "available" ? "Empty and ready for guests" :
                                            key === "reserved" ? "Guest checked in / arriving today" :
                                                key === "dirty" ? "Needs housekeeping after checkout" :
                                                    key === "cleaning" ? "Housekeeping in progress" :
                                                        key === "approved" ? "Cleaned and inspector-approved" :
                                                            key === "closed" ? "Renovation — not sellable" :
                                                                key === "ooo" ? "Out of Order — blocked for maintenance" :
                                                                    "Out of Service — temporary block"}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <button className="btn btn-primary w-full mt-5" onClick={() => setShowLegend(false)}>
                            Close
                        </button>
                    </div>
                </div>
            )}

            {toast && (
                <div className="toast-bar toast-success fixed bottom-6 right-6 z-50">
                    {toast}
                </div>
            )}
        </div>
    );
}
