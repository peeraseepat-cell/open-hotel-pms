"use client";

import { useCallback, useState, useEffect } from "react";
import { Search, AlertTriangle, RefreshCw, XCircle, ArrowRightLeft, FileWarning, Undo2, Ban, FolderOpen, FolderClosed, Banknote } from "lucide-react";
import type { ReservationFolioResponse, ReservationFolioLedgerRow, AdminCorrectionRecord } from "@/lib/types";
import { formatMoney } from "@/lib/money";
import { formatDateRangeDisplay } from "@/lib/date-display";

type ResStatus = "active" | "cancelled" | "checked_out" | "no_show";

/** Extract a human-readable financial summary from correction snapshots */
function correctionSummary(record: AdminCorrectionRecord): string | null {
  const before = record.before_snapshot ?? {};
  const after = record.after_snapshot ?? {};

  switch (record.action) {
    case "void": {
      const amt = before.amount as number | undefined;
      const method = before.method as string | undefined;
      const txType = before.tx_type as string | undefined;
      if (amt != null) return `Voided ${txType ?? "payment"} ฿${formatMoney(amt)} (${method ?? "—"})`;
      return null;
    }
    case "adjustment": {
      const amt = after.amount as number | undefined;
      const method = after.method as string | undefined;
      const txType = after.tx_type as string | undefined;
      if (amt != null) {
        const dir = txType === "refund" ? "Reduce charge" : "Add charge";
        return `${dir} ฿${formatMoney(amt)} (${method ?? "—"})`;
      }
      return null;
    }
    case "reinstate": {
      const nights = after.nights_restored as number | undefined;
      const voided = after.settlement_rows_voided as number | undefined;
      const parts: string[] = ["Reinstated to Active"];
      if (nights != null) parts.push(`${nights} nights restored`);
      if (voided) parts.push(`${voided} settlements voided`);
      return parts.join(" · ");
    }
    case "reopen_folio":
      return "Folio reopened for post-checkout edits";
    case "close_folio": {
      const outstanding = before.outstanding as number | undefined;
      return outstanding != null
        ? `Folio closed (outstanding was ฿${formatMoney(outstanding)})`
        : "Folio closed";
    }
    case "transfer_payment": {
      const amt = after.amount as number | undefined;
      const method = after.method as string | undefined;
      const destGuest = after.destination_guest as string | undefined;
      const srcGuest = before.source_guest as string | undefined;
      const direction = before.transfer_direction as string | undefined;
      if (amt != null) {
        if (direction === "incoming") {
          return `Received ฿${formatMoney(amt)} from ${srcGuest ?? "—"} (${method ?? "—"})`;
        }
        return `Transferred ฿${formatMoney(amt)} → ${destGuest ?? "—"} (${method ?? "—"})`;
      }
      return null;
    }
    default:
      return null;
  }
}

// Lightweight reservation type for search results
interface SearchResult {
  id: string;
  guest_name: string;
  booking_code: string;
  room_number: string;
  status: ResStatus;
  checkin_date: string;
  checkout_date: string;
  total_price: number;
}

interface ReinstatePreview {
  can_reinstate: boolean;
  room_assignment_mode: "pending" | "specific_room";
  room_type_id: number | null;
  room_type_name: string | null;
  target_room_id: string | null;
  target_room_number: string | null;
  stay_dates: string[];
  message: string;
}

type ActionType = "void_payment" | "adjustment" | "reinstate" | "reopen_folio" | "close_folio" | "transfer_payment" | null;

function padZero(num: number) {
  return num.toString().padStart(2, "0");
}

function formatSimpleDate(isoString: string) {
  if (!isoString) return "—";
  const d = new Date(isoString);
  return `${d.getFullYear()}-${padZero(d.getMonth() + 1)}-${padZero(d.getDate())} ${padZero(d.getHours())}:${padZero(d.getMinutes())}`;
}

function getBangkokDateInput(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
}

export default function AdminCorrectionsPage() {
  const [q, setQ] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchError, setSearchError] = useState("");
  const [dateFrom, setDateFrom] = useState(() => getBangkokDateInput(-7));
  const [dateTo, setDateTo] = useState(() => getBangkokDateInput(7));
  const [hasFinancialActivity, setHasFinancialActivity] = useState(true);

  const [reservationId, setReservationId] = useState<string | null>(null);
  const [selectedRes, setSelectedRes] = useState<SearchResult | null>(null);
  const [folio, setFolio] = useState<ReservationFolioResponse | null>(null);
  const [history, setHistory] = useState<AdminCorrectionRecord[]>([]);

  const [isLoadingFolio, setIsLoadingFolio] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const [selectedAction, setSelectedAction] = useState<ActionType>(null);
  const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form states
  const [reason, setReason] = useState("");
  const [selectedPaymentId, setSelectedPaymentId] = useState(""); // For void
  const [adjType, setAdjType] = useState<"add" | "reduce">("reduce");
  const [adjAmount, setAdjAmount] = useState("");
  const [adjMethod, setAdjMethod] = useState("cash");
  const [adjRevenueCategory, setAdjRevenueCategory] = useState("extra_charge");
  const [adjOriginalPaymentId, setAdjOriginalPaymentId] = useState("");
  const [transferDestCode, setTransferDestCode] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferMethod, setTransferMethod] = useState("cash");
  const [reinstateRoomId, setReinstateRoomId] = useState("");
  const [reinstatePreview, setReinstatePreview] = useState<ReinstatePreview | null>(null);
  const [isLoadingReinstatePreview, setIsLoadingReinstatePreview] = useState(false);
  const [reinstatePreviewError, setReinstatePreviewError] = useState("");

  const runReservationSearch = useCallback(async (autoSelectSingle: boolean) => {
    setIsSearching(true);
    setSearchError("");
    setSearchResults([]);
    setSelectedRes(null);
    setReservationId(null);
    
    try {
      const params = new URLSearchParams();
      const trimmedQuery = q.trim();

      if (trimmedQuery) {
        params.set("q", trimmedQuery);
        params.set("status", "all");
      } else {
        params.set("status", "active");
      }
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      if (hasFinancialActivity) params.set("has_financial_activity", "1");
      params.set("page_size", "100");

      const res = await fetch(`/api/reservations?${params.toString()}`);
      const data = await res.json();
      if (data.success) {
        setSearchResults(data.reservations || []);
        if (autoSelectSingle && data.reservations?.length === 1) {
          handleSelectReservation(data.reservations[0]);
        }
      } else {
        setSearchError(data.error || "Search failed");
      }
    } catch {
      setSearchError("Network error during search");
    } finally {
      setIsSearching(false);
    }
  }, [dateFrom, dateTo, hasFinancialActivity, q]);

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    await runReservationSearch(q.trim().length > 0);
  };

  const loadFolio = useCallback(async (id: string) => {
    setIsLoadingFolio(true);
    try {
      const res = await fetch(`/api/bookings/${id}/folio`);
      const data = await res.json();
      if (data.success) {
        setFolio(data);
      } else {
        console.warn("[AdminCorrections] Folio load failed:", data.error);
      }
    } catch (err) {
      console.error("[AdminCorrections] Folio fetch error:", err);
    } finally {
      setIsLoadingFolio(false);
    }
  }, []);

  const loadHistory = useCallback(async (id: string) => {
    setIsLoadingHistory(true);
    try {
      const res = await fetch(`/api/admin/corrections/history?reservation_id=${id}`);
      const data = await res.json();
      if (data.success) {
        setHistory(data.corrections || []);
      } else {
        console.warn("[AdminCorrections] History load failed:", data.error);
        setHistory([]);
      }
    } catch (err) {
      console.error("[AdminCorrections] History fetch error:", err);
      setHistory([]);
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  const handleSelectReservation = (res: SearchResult) => {
    setSelectedRes(res);
    setReservationId(res.id);
    setSelectedAction(null);
    clearForm();
    void loadFolio(res.id);
    void loadHistory(res.id);
  };

  const clearForm = () => {
    setReason("");
    setSelectedPaymentId("");
    setAdjType("reduce");
    setAdjAmount("");
    setAdjMethod("cash");
    setAdjRevenueCategory("extra_charge");
    setAdjOriginalPaymentId("");
    setTransferDestCode("");
    setTransferAmount("");
    setTransferMethod("cash");
    setReinstateRoomId("");
    setReinstatePreview(null);
    setReinstatePreviewError("");
    setActionError("");
    setActionSuccess("");
  };

  const handleActionSelect = (action: ActionType) => {
    setSelectedAction(action);
    clearForm();
  };

  useEffect(() => {
    if (q.trim()) return;
    void runReservationSearch(false);
  }, [q, dateFrom, dateTo, hasFinancialActivity, runReservationSearch]);

  useEffect(() => {
    if (selectedAction !== "reinstate" || !reservationId) {
      setReinstatePreview(null);
      setReinstatePreviewError("");
      setIsLoadingReinstatePreview(false);
      return;
    }

    let cancelled = false;
    const loadPreview = async () => {
      setIsLoadingReinstatePreview(true);
      setReinstatePreviewError("");
      try {
        const params = new URLSearchParams({ reservation_id: reservationId });
        if (reinstateRoomId) params.set("target_room_id", reinstateRoomId);

        const res = await fetch(`/api/admin/corrections/reinstate/preview?${params.toString()}`);
        const data = await res.json();
        if (cancelled) return;

        if (data.success) {
          setReinstatePreview(data.preview ?? null);
        } else {
          setReinstatePreview(null);
          setReinstatePreviewError(data.error || "Failed to check reinstatement availability.");
        }
      } catch (err: any) {
        if (cancelled) return;
        setReinstatePreview(null);
        setReinstatePreviewError(err?.message || "Failed to check reinstatement availability.");
      } finally {
        if (!cancelled) setIsLoadingReinstatePreview(false);
      }
    };

    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [selectedAction, reservationId, reinstateRoomId]);

  const submitAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reservationId || !selectedAction) return;
    if (!reason.trim()) {
      setActionError("Reason is strongly required for admin corrections.");
      return;
    }

    setIsSubmitting(true);
    setActionError("");
    setActionSuccess("");

    try {
      let endpoint = `/api/admin/corrections`;
      let payload: any = { reason: reason.trim() };

      if (selectedAction === "void_payment") {
        if (!selectedPaymentId) throw new Error("Please select a payment to void");
        endpoint = `/api/admin/corrections/void`;
        payload.payment_id = selectedPaymentId;
      } else if (selectedAction === "adjustment") {
        const amt = Number(adjAmount);
        if (!amt || amt <= 0) throw new Error("Invalid amount");
        if (adjType === "reduce" && !adjOriginalPaymentId) {
          throw new Error("Please select the charge being reduced");
        }
        endpoint = `/api/admin/corrections/adjustment`;
        payload.reservation_id = reservationId;
        payload.direction = adjType === "add" ? "add_charge" : "reduce_charge";
        payload.amount = amt;
        payload.method = adjMethod;
        if (adjOriginalPaymentId) payload.original_payment_id = adjOriginalPaymentId;
      } else if (selectedAction === "reinstate") {
        endpoint = `/api/admin/corrections/reinstate`;
        payload.reservation_id = reservationId;
        if (reinstateRoomId) payload.target_room_id = reinstateRoomId;
      } else if (selectedAction === "reopen_folio") {
        endpoint = `/api/admin/corrections/reopen-folio`;
        payload.reservation_id = reservationId;
      } else if (selectedAction === "close_folio") {
        if ((folio?.summary.outstanding_balance ?? 0) !== 0) {
          throw new Error("Balance must be zero to close folio");
        }
        endpoint = `/api/admin/corrections/close-folio`;
        payload.reservation_id = reservationId;
      } else if (selectedAction === "transfer_payment") {
        const amt = Number(transferAmount);
        if (!amt || amt <= 0) throw new Error("Invalid amount");
        if (!transferDestCode.trim()) throw new Error("Destination booking code required");
        endpoint = `/api/admin/corrections/transfer`;
        payload.source_reservation_id = reservationId;
        payload.destination_reservation_id = transferDestCode.trim();
        payload.amount = amt;
        payload.method = transferMethod;
      }

      if (selectedAction === "transfer_payment" && payload.destination_reservation_id === transferDestCode.trim()) {
        const findRes = await fetch(`/api/reservations?q=${encodeURIComponent(transferDestCode.trim())}&status=all`);
        const findData = await findRes.json();
        const found = findData.reservations?.find((r: any) => r.booking_code?.toUpperCase() === transferDestCode.trim().toUpperCase());
        if (!found) throw new Error("Destination booking code not found.");
        payload.destination_reservation_id = found.id;
      }
      
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      
      if (data.success) {
        clearForm();
        setActionSuccess("Correction applied successfully."); // set AFTER clearForm so it isn't wiped
        setSelectedAction(null);
        void loadFolio(reservationId);
        void loadHistory(reservationId);
      } else {
        setActionError(data.error || "Action failed");
      }
    } catch (err: any) {
      setActionError(err.message || "Network error");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Conditions
  const isFolioReopened = folio?.reservation.folio_reopened === true;
  const status = folio?.reservation.status || selectedRes?.status;

  const validPayments = folio?.ledger.filter(r => {
    const txType = String(r.tx_type ?? "").toLowerCase();
    if (!(txType === "payment" || txType === "deposit" || txType === "refund")) return false;
    if (!["payment", "deposit", "extra_charge", "refund"].includes(r.type)) return false;
    if (r.is_void_reversal || r.void_of) return false;
    if (r.type === "extra_charge") return true;
    const occurredDateStr = new Date(r.occurred_at).toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
    return occurredDateStr === todayStr;
  }) || [];

  const canVoid = (status === "active" || status === "checked_out") && validPayments.length > 0;
  const canReinstate = status === "cancelled";
  const canReopen = status === "checked_out" && !isFolioReopened;
  const canClose = isFolioReopened;
  const canAdj = true;
  const canTransfer = true;

  return (
    <div className="mx-auto max-w-[85rem] space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Admin Corrections</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">Direct ledger modifications, status overrides, and corrections with forced audit trails.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* LEFT COLUMN: Search & Summary & Action Bar */}
        <div className="lg:col-span-1 space-y-6">
          <div className="card p-5 border-l-4 border-l-brand-600">
            <h2 className="text-sm font-bold uppercase tracking-widest text-[var(--text-secondary)] mb-4">Target Reservation</h2>
            <form onSubmit={handleSearch} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="form-label">From</label>
                  <input
                    type="date"
                    className="form-input w-full"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                  />
                </div>
                <div>
                  <label className="form-label">To</label>
                  <input
                    type="date"
                    className="form-input w-full"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-[var(--border-default)]"
                  checked={hasFinancialActivity}
                  onChange={(e) => setHasFinancialActivity(e.target.checked)}
                />
                Show only bookings with financial activity
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  className="form-input flex-1"
                  placeholder="Name, Booking Code, Phone, or Room No..."
                  value={q}
                  onChange={e => setQ(e.target.value)}
                />
                <button disabled={isSearching} type="submit" className="btn btn-primary">
                  {isSearching ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                </button>
              </div>
            </form>
            {searchError && <div className="mt-2 text-xs text-rose-600 font-medium">{searchError}</div>}
            {!q.trim() && !searchError && (
              <div className="mt-2 text-xs text-[var(--text-secondary)]">
                Showing active bookings in the selected date window first. Default range is 7 days back and 7 days ahead.
              </div>
            )}
            
            {searchResults.length > 0 && !reservationId && (
              <div className="mt-4 space-y-2 border border-[var(--border-default)] rounded-xl divide-y divide-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden">
                {searchResults.map(r => (
                  <button
                    key={r.id}
                    className="w-full text-left p-3 hover:bg-[var(--bg-surface-hover)] transition-colors"
                    onClick={() => handleSelectReservation(r)}
                  >
                    <div className="font-semibold text-sm text-[var(--text-primary)]">{r.guest_name}</div>
                    <div className="text-xs text-[var(--text-secondary)] flex gap-2 mt-1">
                      <span>{r.booking_code}</span>
                      <span>Rm {r.room_number || "-"}</span>
                      <span className="uppercase">{r.status}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {reservationId && selectedRes && (
            <>
              <div className="card p-5">
                <div className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3">Snapshot</div>
                <div className="font-bold text-lg text-[var(--text-primary)]">{folio?.reservation.guest_name || selectedRes.guest_name}</div>
                <div className="text-sm text-[var(--text-secondary)] mt-1 break-all">{folio?.reservation.booking_code || selectedRes.booking_code}</div>
                <div className="mt-4 grid grid-cols-2 gap-y-3 text-sm">
                  <div>
                    <div className="text-xs text-[var(--text-muted)]">Status</div>
                    <div className="font-semibold capitalize text-[var(--text-primary)]">{status}</div>
                  </div>
                  <div>
                    <div className="text-xs text-[var(--text-muted)]">Room</div>
                    <div className="font-semibold text-[var(--text-primary)]">{folio?.reservation.room_number || selectedRes.room_number || "—"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-[var(--text-muted)]">Outstanding</div>
                    <div className="font-semibold text-indigo-600 dark:text-indigo-400">
                      ฿{formatMoney(folio?.summary.outstanding_balance ?? 0)}
                    </div>
                  </div>
                  {isFolioReopened && (
                    <div className="col-span-2 mt-2 inline-flex items-center gap-1.5 rounded-md bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700 dark:bg-rose-500/10 dark:text-rose-400 border border-rose-200 dark:border-rose-500/20 w-max">
                      <AlertTriangle className="h-3.5 w-3.5" /> Folio Reopened
                    </div>
                  )}
                </div>
              </div>

              <div className="card p-2 space-y-1">
                <div className="px-3 pt-2 pb-1 text-xs font-bold uppercase tracking-widest text-slate-400">Available Actions</div>
                <button
                  onClick={() => handleActionSelect("void_payment")}
                  disabled={!canVoid}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors text-left ${selectedAction === "void_payment" ? "bg-amber-100/50 text-amber-900 font-semibold dark:bg-amber-500/20 dark:text-amber-400" : "hover:bg-[var(--bg-surface-hover)] text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"}`}
                >
                  <Ban className="h-4 w-4 text-amber-500" /> Void Payment
                </button>
                <button
                  onClick={() => handleActionSelect("adjustment")}
                  disabled={!canAdj}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors text-left ${selectedAction === "adjustment" ? "bg-blue-100/50 text-blue-900 font-semibold dark:bg-blue-500/20 dark:text-blue-400" : "hover:bg-[var(--bg-surface-hover)] text-[var(--text-primary)] disabled:opacity-50"}`}
                >
                  <FileWarning className="h-4 w-4 text-blue-500" /> Folio Adjustment
                </button>
                <button
                  onClick={() => handleActionSelect("transfer_payment")}
                  disabled={!canTransfer}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors text-left ${selectedAction === "transfer_payment" ? "bg-purple-100/50 text-purple-900 font-semibold dark:bg-purple-500/20 dark:text-purple-400" : "hover:bg-[var(--bg-surface-hover)] text-[var(--text-primary)] disabled:opacity-50"}`}
                >
                  <ArrowRightLeft className="h-4 w-4 text-purple-500" /> Transfer Payment
                </button>
                <hr className="my-1 border-[var(--border-subtle)] mx-3" />
                <button
                  onClick={() => handleActionSelect("reinstate")}
                  disabled={!canReinstate}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors text-left ${selectedAction === "reinstate" ? "bg-emerald-100/50 text-emerald-900 font-semibold dark:bg-emerald-500/20 dark:text-emerald-400" : "hover:bg-[var(--bg-surface-hover)] text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"}`}
                >
                  <Undo2 className="h-4 w-4 text-emerald-500" /> Reinstate Reservation
                </button>
                <button
                  onClick={() => handleActionSelect("reopen_folio")}
                  disabled={!canReopen}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors text-left ${selectedAction === "reopen_folio" ? "bg-rose-100/50 text-rose-900 font-semibold dark:bg-rose-500/20 dark:text-rose-400" : "hover:bg-[var(--bg-surface-hover)] text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"}`}
                >
                  <FolderOpen className="h-4 w-4 text-rose-500" /> Reopen Folio
                </button>
                <button
                  onClick={() => handleActionSelect("close_folio")}
                  disabled={!canClose}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors text-left ${selectedAction === "close_folio" ? "bg-indigo-100/50 text-indigo-900 font-semibold dark:bg-indigo-500/20 dark:text-indigo-400" : "hover:bg-[var(--bg-surface-hover)] text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"}`}
                >
                  <FolderClosed className="h-4 w-4 text-indigo-500" /> Force Close Folio
                </button>
              </div>
            </>
          )}

        </div>

        {/* RIGHT COLUMN: Action Form & Status */}
        <div className="lg:col-span-2 space-y-6">
          {reservationId && selectedAction ? (
            <div className={`card p-6 border-l-4 shadow-sm ${
              selectedAction === "void_payment" ? "border-l-amber-500" :
              selectedAction === "adjustment" ? "border-l-blue-500" :
              selectedAction === "reinstate" ? "border-l-emerald-500" :
              selectedAction === "reopen_folio" ? "border-l-rose-500" :
              selectedAction === "close_folio" ? "border-l-indigo-500" :
              "border-l-purple-500"
            }`}>
              <div className="flex items-center justify-between mb-6 border-b border-[var(--border-subtle)] pb-4">
                <h2 className="text-lg font-bold text-[var(--text-primary)] flex items-center gap-2">
                  {selectedAction === "void_payment" && <><Ban className="h-5 w-5 text-amber-500" /> Void Receipt / Payment</>}
                  {selectedAction === "adjustment" && <><FileWarning className="h-5 w-5 text-blue-500" /> Folio Ledger Adjustment</>}
                  {selectedAction === "reinstate" && <><Undo2 className="h-5 w-5 text-emerald-500" /> Reinstate Reservation</>}
                  {selectedAction === "reopen_folio" && <><FolderOpen className="h-5 w-5 text-rose-500" /> Reopen Checked-Out Folio</>}
                  {selectedAction === "close_folio" && <><FolderClosed className="h-5 w-5 text-indigo-500" /> Force Close Reopened Folio</>}
                  {selectedAction === "transfer_payment" && <><ArrowRightLeft className="h-5 w-5 text-purple-500" /> Transfer Payment</>}
                </h2>
                <button onClick={() => setSelectedAction(null)} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors rounded-full hover:bg-[var(--bg-surface-hover)]">
                  <XCircle className="h-5 w-5" />
                </button>
              </div>

              {actionError && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 font-medium break-words">{actionError}</div>}
              {actionSuccess && <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 font-medium">{actionSuccess}</div>}

              <form onSubmit={submitAction} className="space-y-5">
                {selectedAction === "void_payment" && (
                  <div className="space-y-4">
                    <div className="bg-amber-50 text-amber-800 p-3 rounded-lg text-sm border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/20 dark:text-amber-300">
                      Creates a negative counter-entry (Void Reversal) and unlinks the original payment from revenue. Standard payments are same-business-day only, but Admin may void extra charges even after Night Audit.
                    </div>
                    <div>
                      <label className="form-label">Select Payment to Void</label>
                      <select className="form-select w-full mb-3" value={selectedPaymentId} onChange={e => setSelectedPaymentId(e.target.value)} disabled={isSubmitting}>
                        <option value="">-- Choose Payment --</option>
                        {validPayments.map(p => (
                          <option key={p.id} value={p.id}>
                            [{p.type.toUpperCase()}/{String(p.tx_type ?? "-").toUpperCase()}] {formatSimpleDate(p.occurred_at)} - {p.method?.toUpperCase()} ฿{formatMoney(p.amount)} {p.note ? `(${p.note})` : ""}
                          </option>
                        ))}
                      </select>
                      {validPayments.length === 0 && <p className="text-xs text-rose-500 mt-1">No payments eligible for void.</p>}
                      {selectedPaymentId && (() => {
                        const vp = validPayments.find(p => p.id === selectedPaymentId);
                        if (!vp) return null;
                        return (
                          <div className="p-3 bg-[var(--bg-muted)] rounded-lg text-sm text-[var(--text-primary)] border border-[var(--border-subtle)] mt-2">
                            <span className="font-semibold text-amber-600">Preview:</span> This will reverse {vp.type} of ฿{formatMoney(vp.amount)} ({vp.method}).
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                )}

                {selectedAction === "adjustment" && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="form-label">Direction</label>
                        <select className="form-select w-full" value={adjType} onChange={e => {
                          setAdjType(e.target.value as any);
                          setAdjOriginalPaymentId("");
                        }} disabled={isSubmitting}>
                          <option value="reduce">Reduce charge / Add Payment (Credit)</option>
                          <option value="add">Add charge / Reduce Payment (Debit)</option>
                        </select>
                      </div>
                      <div>
                        <label className="form-label">Amount</label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] font-medium">฿</span>
                          <input type="number" min="0" step="0.01" className="form-input w-full pl-8 font-mono" value={adjAmount} onChange={e => setAdjAmount(e.target.value)} placeholder="0.00" disabled={isSubmitting} />
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="form-label">Method</label>
                        <select className="form-select w-full" value={adjMethod} onChange={e => setAdjMethod(e.target.value)} disabled={isSubmitting}>
                          <option value="cash">Cash</option>
                          <option value="transfer">Transfer</option>
                          <option value="credit_card">Credit Card</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                      <div>
                        <label className="form-label">Revenue Category</label>
                        <input className="form-input w-full bg-[var(--bg-body)]" value="Extra Charge (Adjustment)" disabled />
                        <p className="text-xs text-[var(--text-muted)] mt-1">Adjustments are always categorized as extra charges.</p>
                      </div>
                    </div>
                    <div>
                      <label className="form-label">
                        {adjType === "reduce" ? "Original Charge" : "Original Payment (Optional)"}
                      </label>
                      <select className="form-select w-full" value={adjOriginalPaymentId} onChange={e => setAdjOriginalPaymentId(e.target.value)} disabled={isSubmitting} required={adjType === "reduce"}>
                        <option value="">-- None --</option>
                        {(folio?.ledger.filter(r => adjType === "reduce"
                          ? r.type === "extra_charge" && r.tx_type === "payment"
                          : r.type === "payment" || r.type === "deposit" || r.type === "extra_charge"
                        ) || []).map(p => (
                          <option key={p.id} value={p.id}>
                            [{p.type.toUpperCase()}] {formatSimpleDate(p.occurred_at)} - {p.method?.toUpperCase()} ฿{formatMoney(p.amount)}
                          </option>
                        ))}
                      </select>
                    </div>
                    {adjAmount && Number(adjAmount) > 0 && (
                      <div className="p-3 bg-[var(--bg-muted)] rounded-lg text-sm text-[var(--text-primary)] border border-[var(--border-subtle)] mt-2">
                        <span className="font-semibold text-blue-600">Preview:</span> Outstanding will change from ฿{formatMoney(folio?.summary.outstanding_balance ?? 0)} to ฿{formatMoney((folio?.summary.outstanding_balance ?? 0) + (adjType === "add" ? Number(adjAmount) : -Number(adjAmount)))}.
                      </div>
                    )}
                  </div>
                )}

                {selectedAction === "transfer_payment" && (
                  <div className="space-y-4">
                    <div className="bg-purple-50 text-purple-800 p-3 rounded-lg text-sm border border-purple-200 dark:bg-purple-500/10 dark:border-purple-500/20 dark:text-purple-300">
                      Moves settled funds from this reservation to another. Creates a negative adjustment here, and a positive payment deposit on the target.
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="form-label">Source Booking Code</label>
                        <input type="text" className="form-input w-full bg-[var(--bg-muted)] cursor-not-allowed font-mono" value={folio?.reservation.booking_code || ""} disabled />
                      </div>
                      <div>
                        <label className="form-label">Destination Booking Code</label>
                        <input type="text" className="form-input w-full font-mono uppercase" value={transferDestCode} onChange={e => setTransferDestCode(e.target.value.toUpperCase())} placeholder="e.g. BK-12345" disabled={isSubmitting} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="form-label">Transfer Amount</label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] font-medium">฿</span>
                          <input type="number" min="0" step="0.01" className="form-input w-full pl-8 font-mono" value={transferAmount} onChange={e => setTransferAmount(e.target.value)} placeholder="0.00" disabled={isSubmitting} />
                        </div>
                      </div>
                      <div>
                        <label className="form-label">Method</label>
                        <select className="form-select w-full" value={transferMethod} onChange={e => setTransferMethod(e.target.value)} disabled={isSubmitting}>
                          <option value="cash">Cash</option>
                          <option value="transfer">Transfer</option>
                          <option value="credit_card">Credit Card</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                    </div>
                    {transferDestCode && transferAmount && Number(transferAmount) > 0 && (
                      <div className="p-3 bg-[var(--bg-muted)] rounded-lg text-sm text-[var(--text-primary)] border border-[var(--border-subtle)] mt-2">
                        <span className="font-semibold text-purple-600">Preview:</span> Move ฿{formatMoney(Number(transferAmount))} from {folio?.reservation.guest_name} to {transferDestCode}.
                      </div>
                    )}
                  </div>
                )}

                {selectedAction === "reinstate" && (
                  <div className="space-y-4">
                    <div className="bg-emerald-50 text-emerald-800 p-3 rounded-lg text-sm border border-emerald-200 dark:bg-emerald-500/10 dark:border-emerald-500/20 dark:text-emerald-300">
                      Restores a cancelled reservation to <b>Active</b> status. <br/>
                      <span className="font-mono text-xs opacity-80 mt-1 block">Original Stay: {formatDateRangeDisplay(folio?.reservation.checkin_date, folio?.reservation.checkout_date, { separator: " to " })}</span>
                    </div>
                    <div>
                      <label className="form-label">Room Allocation (Optional)</label>
                      <select className="form-select w-full" value={reinstateRoomId} onChange={e => setReinstateRoomId(e.target.value)} disabled={isSubmitting}>
                        <option value="">-- Keep unassigned / Pending --</option>
                        {folio?.reservation.room_number ? (
                          <option value="">Room {folio.reservation.room_number} (keep current room reference)</option>
                        ) : null}
                      </select>
                    </div>
                    <div className="p-3 bg-[var(--bg-muted)] rounded-lg text-sm text-[var(--text-primary)] border border-[var(--border-subtle)]">
                      <span className="font-semibold text-emerald-600">Warning:</span> This will restore nights and void any cancellation settlement entries.
                    </div>
                    {isLoadingReinstatePreview && (
                      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-muted)] px-4 py-3 text-sm text-[var(--text-secondary)]">
                        Checking room availability for reinstate...
                      </div>
                    )}
                    {reinstatePreviewError && (
                      <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300">
                        {reinstatePreviewError}
                      </div>
                    )}
                    {!reinstatePreviewError && reinstatePreview && (
                      <div className={`rounded-lg border px-4 py-3 text-sm ${
                        reinstatePreview.can_reinstate
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300"
                          : "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300"
                      }`}>
                        <div className="font-semibold">
                          {reinstatePreview.can_reinstate ? "Availability Preview: OK" : "Availability Preview: Blocked"}
                        </div>
                        <div className="mt-1">{reinstatePreview.message}</div>
                        <div className="mt-2 text-xs opacity-80">
                          Stay dates: {reinstatePreview.stay_dates.join(", ")}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {selectedAction === "reopen_folio" && (
                  <div className="space-y-4">
                    <div className="bg-rose-50 text-rose-800 p-3 rounded-lg text-sm border border-rose-200 dark:bg-rose-500/10 dark:border-rose-500/20 dark:text-rose-300">
                      Temporarily re-opens a checked-out folio for modifications. It keeps the room Checked Out but allows financial changes. <b>You must close it when done.</b>
                    </div>
                  </div>
                )}

                {selectedAction === "close_folio" && (
                  <div className="space-y-4">
                    <div className="bg-indigo-50 text-indigo-800 p-3 rounded-lg text-sm border border-indigo-200 dark:bg-indigo-500/10 dark:border-indigo-500/20 dark:text-indigo-300">
                      Closes a previously reopened Folio. The outstanding balance <b>MUST</b> be 0.
                    </div>
                    <div className="p-4 border border-[var(--border-subtle)] rounded-lg text-center bg-[var(--bg-surface)]">
                       <span className="text-xs font-bold uppercase tracking-widest text-[var(--text-muted)] block mb-1">Current Outstanding</span>
                       <span className={`text-2xl font-bold ${(folio?.summary.outstanding_balance ?? 0) === 0 ? "text-emerald-600" : "text-rose-600"}`}>
                         ฿{formatMoney(folio?.summary.outstanding_balance ?? 0)}
                       </span>
                    </div>
                  </div>
                )}

                <div>
                  <label className="form-label">Correction Reason (Mandatory Audit Log)</label>
                  <textarea
                    required
                    className="form-textarea w-full"
                    rows={3}
                    placeholder="Provide a detailed reason for this admin override..."
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>

                <div className="pt-2 flex justify-end gap-3">
                  <button type="button" className="btn btn-ghost" onClick={() => setSelectedAction(null)}>Cancel</button>
                  <button
                    type="submit"
                    disabled={
                      isSubmitting ||
                      !reason.trim() ||
                      (selectedAction === "reinstate" && (isLoadingReinstatePreview || !!reinstatePreviewError))
                    }
                    className="btn btn-primary px-6"
                  >
                    {isSubmitting ? "Executing..." : "Execute Correction"}
                  </button>
                </div>
              </form>
            </div>
          ) : reservationId ? (
            <div className="card p-12 text-center text-[var(--text-muted)] border-dashed">
              <Banknote className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium text-[var(--text-secondary)]">Select an action on the left to begin.</p>
              <p className="text-sm mt-1">Modifications made here are strictly logged with before/after snapshots.</p>
            </div>
          ) : (
             <div className="card p-12 text-center text-[var(--text-muted)] border-dashed">
              <Search className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium text-[var(--text-secondary)]">Search and select a reservation first.</p>
            </div>
          )}

          {/* History Panel */}
          {reservationId && (
            <div className="card p-5 mt-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold uppercase tracking-widest text-[var(--text-secondary)]">Correction History</h3>
                {isLoadingHistory && <RefreshCw className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />}
              </div>
              
              {history.length === 0 ? (
                <div className="text-center p-4 text-sm text-[var(--text-muted)]">No correction history recorded for this reservation.</div>
              ) : (
                <div className="space-y-3">
                  {history.map(record => {
                    const summary = correctionSummary(record);
                    return (
                      <div key={record.id} className="p-3 border border-[var(--border-subtle)] rounded-lg bg-[var(--bg-body)]">
                        <div className="flex justify-between items-start mb-2">
                          <div className="font-semibold text-sm capitalize text-[var(--text-primary)]">
                            {record.action.replaceAll("_", " ")}
                          </div>
                          <div className="text-[10px] text-[var(--text-muted)]">{formatSimpleDate(record.created_at)}</div>
                        </div>
                        {summary && (
                          <div className="text-sm font-medium text-[var(--text-primary)] mb-2 px-2 py-1.5 rounded bg-[var(--bg-muted)] border border-[var(--border-subtle)]">
                            {summary}
                          </div>
                        )}
                        <div className="text-xs text-[var(--text-secondary)] mb-1">
                          <span className="font-medium text-[var(--text-primary)]">Actor:</span> {record.actor_name || record.actor_user_id}
                        </div>
                        <div className="text-xs text-[var(--text-secondary)] bg-[var(--bg-surface)] p-2 rounded border border-[var(--border-subtle)] mt-2">
                          <span className="font-medium text-[var(--text-primary)] block mb-1">Reason:</span>
                          {record.reason}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

        </div>

      </div>
    </div>
  );
}
