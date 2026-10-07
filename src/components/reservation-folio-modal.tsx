"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCw, WalletCards, ReceiptText, Landmark, FileClock, ShieldAlert, CheckCircle2, Printer, PencilLine } from "lucide-react";
import PmsModal from "./pms-modal";
import { toBangkokDateString } from "@/lib/audit-utils";
import { PostChargeModal } from "./post-charge-modal";
import { SettlementDrawer } from "./settlement-drawer";
import LinkedStayPanel from "./linked-stay-panel";
import { PAYMENT_METHODS } from "@/lib/constants";
import { formatMoney, fromSatang, toSatang } from "@/lib/money";
import { applyDefaultTransferSender } from "@/lib/transfer-detail";
import { getExactTransferDepositSplit } from "@/lib/transfer-deposit-split";
import { canEditFolioPaymentMethod } from "@/lib/folio-payment-method-edit";
import type { PaymentMethod, ReservationFolioLedgerRow, ReservationFolioResponse } from "@/lib/types";
import {
  buildTransferDetailPayload,
  createDefaultTransferDetailDraft,
  TransferDetailFields,
  type TransferDetailDraft,
} from "./transfer-detail-fields";

type BookingMode = "create" | "edit" | "checkin" | "inhouse" | "checkout";

type BillingData = {
  roomTotalSatang: number;
  extraChargesSatang: number;
  totalChargesSatang: number;
  totalCreditsSatang: number;
  outstandingSatang: number;
};

interface ReservationFolioModalProps {
  open: boolean;
  onClose: () => void;
  reservationId: string;
  mode: BookingMode;
  isReadonly?: boolean;
  allowPaymentMethodEdit?: boolean;
  totalPrice: number;
  depositAmount: number;
  billingData: BillingData | null;
  policyFeePayload?: {
    fee_template_code: string;
    amount: number;
    payment_method: string;
    note: string;
  } | null;
  onInlineRefresh?: () => void;
  onCheckoutComplete: () => void;
  onSwitchTab?: (id: string) => void;
}

type FolioFilter = "all" | "charges" | "payments" | "deposits";
type PaymentMethodEditState = {
  row: ReservationFolioLedgerRow;
  method: PaymentMethod;
  reason: string;
  referenceNote: string;
};

const FILTERS: Array<{ key: FolioFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "charges", label: "Charges" },
  { key: "payments", label: "Payments" },
  { key: "deposits", label: "Deposits" },
];

function formatLedgerDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatStayRange(checkinDate: string | null, checkoutDate: string | null): string {
  if (!checkinDate || !checkoutDate) return "—";
  return `${checkinDate} → ${checkoutDate}`;
}

function getMethodLabel(method: PaymentMethod | null): string {
  if (!method) return "—";
  return PAYMENT_METHODS.find((item) => item.value === method)?.label ?? method;
}

function getRowTypeLabel(row: ReservationFolioLedgerRow): string {
  if (row.type === "room_charge") return "Room Charge";
  if (row.type === "discount") return "Discount";
  if (row.type === "extra_charge") return "Extra Charge";
  if (row.type === "deposit") return "Deposit";
  if (row.type === "refund") return "Refund";
  return "Payment";
}

function getAmountTone(row: ReservationFolioLedgerRow): string {
  if (row.type === "discount") return "text-rose-700";
  if (row.type === "room_charge" || row.type === "extra_charge") return "text-amber-700";
  if (row.type === "refund") return "text-rose-700";
  if (row.type === "deposit") return "text-indigo-700";
  return "text-emerald-700";
}

function getAmountPrefix(row: ReservationFolioLedgerRow): string {
  if (row.type === "room_charge" || row.type === "extra_charge") return "+";
  if (row.type === "discount") return "-";
  if (row.type === "refund") return "-";
  if (row.type === "deposit") {
    const note = String(row.note ?? "").toLowerCase();
    if (note.includes("paid by deposit")) return "-";
    return "";
  }
  return "";
}

function isOperatorPaymentMethod(method: PaymentMethod | null): method is "cash" | "transfer" | "credit_card" {
  return method === "cash" || method === "transfer" || method === "credit_card";
}

export function ReservationFolioModal({
  open,
  onClose,
  reservationId,
  mode,
  isReadonly = false,
  allowPaymentMethodEdit = false,
  totalPrice,
  depositAmount,
  billingData,
  policyFeePayload = null,
  onInlineRefresh,
  onCheckoutComplete,
  onSwitchTab,
}: ReservationFolioModalProps) {
  const [loading, setLoading] = useState(false);
  const [submittingPayment, setSubmittingPayment] = useState(false);
  const [error, setError] = useState("");
  const [folio, setFolio] = useState<ReservationFolioResponse | null>(null);
  const [filter, setFilter] = useState<FolioFilter>("all");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentNote, setPaymentNote] = useState("");
  const [paymentTransferDetail, setPaymentTransferDetail] = useState<TransferDetailDraft>(() => createDefaultTransferDetailDraft());
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [showPostCharge, setShowPostCharge] = useState(false);
  const [showSettlement, setShowSettlement] = useState(false);
  const [taxInvoiceRequested, setTaxInvoiceRequested] = useState(false);
  const [taxInvoiceLoading, setTaxInvoiceLoading] = useState(false);
  const [taxInvoiceNo, setTaxInvoiceNo] = useState<string | null>(null);
  const [businessDate, setBusinessDate] = useState<string>(toBangkokDateString());
  const [paymentMethodEdit, setPaymentMethodEdit] = useState<PaymentMethodEditState | null>(null);
  const [submittingMethodEdit, setSubmittingMethodEdit] = useState(false);
  const defaultTransferSenderName = folio?.reservation.guest_name ?? "";

  const loadFolio = useCallback(async () => {
    if (!reservationId) return;
    try {
      setLoading(true);
      setError("");
      const response = await fetch(`/api/bookings/${reservationId}/folio`, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || "Failed to load folio.");
      }
      setFolio(data);
      if (typeof data.business_date === "string" && data.business_date.trim()) {
        setBusinessDate(data.business_date.trim());
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load folio.");
      setFolio(null);
    } finally {
      setLoading(false);
    }
  }, [reservationId]);

  useEffect(() => {
    if (!open) return;
    void loadFolio();
  }, [open, loadFolio]);

  useEffect(() => {
    if (paymentMethod !== "transfer") return;
    setPaymentTransferDetail((current) => applyDefaultTransferSender(current, defaultTransferSenderName));
  }, [defaultTransferSenderName, paymentMethod]);

  // Sync tax invoice state from folio response
  useEffect(() => {
    if (folio?.reservation?.tax_invoice_requested !== undefined) {
      setTaxInvoiceRequested(Boolean(folio.reservation.tax_invoice_requested));
      // In the future, Agent B will add tax_invoice_no to the folio response
      // setTaxInvoiceNo(folio.reservation.tax_invoice_no || null);
    }
  }, [folio]);

  const handleToggleTaxInvoice = async () => {
    const next = !taxInvoiceRequested;
    setTaxInvoiceLoading(true);
    try {
      const res = await fetch(`/api/bookings/${reservationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tax_invoice_requested: next }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error ?? "Failed to update");
      setTaxInvoiceRequested(next);
    } catch {
      // revert on error
    } finally {
      setTaxInvoiceLoading(false);
    }
  };

  const voidedRowIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of (folio?.ledger ?? [])) {
      if (row.void_of) {
        ids.add(row.void_of);
      }
    }
    return ids;
  }, [folio?.ledger]);

  const visibleLedger = useMemo(() => {
    const rows = folio?.ledger ?? [];
    if (filter === "all") return rows;
    if (filter === "charges") return rows.filter((row) => row.type === "room_charge" || row.type === "discount" || row.type === "extra_charge");
    if (filter === "payments") return rows.filter((row) => row.type === "payment" || row.type === "refund");
    return rows.filter((row) => row.type === "deposit");
  }, [folio?.ledger, filter]);

  const canAddPayment = open && !!reservationId && !isReadonly && mode !== "create";
  const canPostCharge = open && !!reservationId && !isReadonly && mode === "inhouse";
  const canOpenSettlement = open && !!reservationId && !isReadonly && mode === "checkout";
  const canEditPaymentMethod = useCallback(
    (row: ReservationFolioLedgerRow) =>
      canEditFolioPaymentMethod(row, {
        hasReservation: Boolean(reservationId),
        businessDate,
        ledgerReadonly: isReadonly,
        allowMethodEditWhenReadonly: allowPaymentMethodEdit,
        isVoided: voidedRowIds.has(row.id),
      }),
    [allowPaymentMethodEdit, businessDate, isReadonly, reservationId, voidedRowIds]
  );
  const depositHeld = folio?.summary.deposit_held ?? 0;
  const depositSplitTargetAmount = fromSatang(Math.max(0, toSatang(depositAmount) - toSatang(depositHeld)));
  const depositHeldNote =
    depositHeld <= 0
      ? (folio?.reservation.deposit_note ?? "").trim() || null
      : null;

  const handlePaymentSubmit = async () => {
    const amountInput = paymentMethod === "transfer"
      ? (paymentAmount.trim() || paymentTransferDetail.actualAmount.trim())
      : paymentAmount.trim();
    const amount = Number(amountInput);
    if (!reservationId || !Number.isFinite(amount) || amount <= 0) {
      setError("Payment amount must be greater than 0.");
      return;
    }
    const transferPayload = paymentMethod === "transfer"
      ? buildTransferDetailPayload(paymentTransferDetail)
      : undefined;
    const exactDepositSplit = paymentMethod === "transfer" && transferPayload
      ? getExactTransferDepositSplit({
          folioAmount: amount,
          actualTransferAmount: paymentTransferDetail.actualAmount,
          depositTargetAmount: depositSplitTargetAmount,
        })
      : { ok: false as const };
    const transferDepositSplit = exactDepositSplit.ok && window.confirm(
      `Actual transfer ฿${formatMoney(exactDepositSplit.actualTransferAmount)} matches room payment ฿${formatMoney(exactDepositSplit.folioAmount)} + deposit ฿${formatMoney(exactDepositSplit.depositAmount)}.\n\nRecord the remainder as Deposit and keep both rows in one Transfer Set?`
    )
      ? { deposit_amount: exactDepositSplit.depositAmount }
      : undefined;

    try {
      setSubmittingPayment(true);
      setError("");
      const response = await fetch(`/api/bookings/${reservationId}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tx_type: "payment",
          method: paymentMethod,
          amount,
          note: paymentMethod === "transfer" ? paymentTransferDetail.note.trim() || undefined : paymentNote.trim() || undefined,
          transfer_detail: transferPayload,
          require_transfer_detail: paymentMethod === "transfer" && !!transferPayload,
          transfer_deposit_split: transferDepositSplit,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || "Failed to add payment.");
      }

      const effectiveReservationId =
        typeof data?.effective_reservation_id === "string"
          ? data.effective_reservation_id
          : reservationId;

      setPaymentAmount("");
      setPaymentNote("");
      setPaymentTransferDetail(createDefaultTransferDetailDraft("", defaultTransferSenderName));
      setShowPaymentForm(false);
      window.dispatchEvent(new CustomEvent("billing-panel-refresh"));
      onInlineRefresh?.();
      if (effectiveReservationId && effectiveReservationId !== reservationId && onSwitchTab) {
        onSwitchTab(effectiveReservationId);
      } else {
        await loadFolio();
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to add payment.");
    } finally {
      setSubmittingPayment(false);
    }
  };

  const handlePaymentMethodEditSubmit = async () => {
    if (!paymentMethodEdit || !reservationId) return;
    const reason = paymentMethodEdit.reason.trim();
    if (reason.length < 3) {
      setError("Reason is required to edit payment method.");
      return;
    }

    try {
      setSubmittingMethodEdit(true);
      setError("");
      const response = await fetch(`/api/bookings/${reservationId}/payments/${paymentMethodEdit.row.id}/method`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: paymentMethodEdit.method,
          reason,
          reference_note: paymentMethodEdit.referenceNote.trim() || null,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || "Failed to update payment method.");
      }

      setPaymentMethodEdit(null);
      window.dispatchEvent(new CustomEvent("billing-panel-refresh"));
      onInlineRefresh?.();
      await loadFolio();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to update payment method.");
    } finally {
      setSubmittingMethodEdit(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <PmsModal
        title="Reservation Folio"
        size="wide"
        onClose={onClose}
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => window.open(`/pms/folio/preview/${reservationId}`, "_blank", "noopener,noreferrer")}
                disabled={!reservationId}
              >
                <Printer className="h-4 w-4" />
                Print Folio
              </button>
              <div className="text-xs text-[var(--text-secondary)]">
                Full folio ledger for this reservation
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        }
      >
        {error && (
          <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-500/10 dark:border-rose-500/20 dark:text-rose-400">
            {error}
          </div>
        )}

        <div className="space-y-5">
          {folio?.linked_stay && onSwitchTab && (
            <LinkedStayPanel
              linkedStay={folio.linked_stay}
              currentReservationId={reservationId}
              onSwitchTab={onSwitchTab}
            />
          )}
          <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-body)] px-4 py-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-2">
                <div className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--text-secondary)]">Reservation</div>
                <div className="text-2xl font-semibold text-[var(--text-primary)]">
                  {folio?.reservation.guest_name || "Guest"}
                </div>
                <div className="flex flex-wrap gap-3 text-sm text-[var(--text-secondary)]">
                  <span>{folio?.reservation.booking_code || "—"}</span>
                  <span>Room {folio?.reservation.room_number || "—"}</span>
                  <span className="capitalize">{folio?.reservation.status || "—"}</span>
                  <span>{formatStayRange(folio?.reservation.checkin_date ?? null, folio?.reservation.checkout_date ?? null)}</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {FILTERS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${filter === item.key
                      ? "border-slate-900 bg-slate-900 text-white dark:bg-brand-500/20 dark:border-brand-500/30 dark:text-brand-400 shadow-[0_0_15px_rgba(var(--brand-500-rgb),0.2)]"
                      : "border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)] dark:border-white/5"
                      }`}
                    onClick={() => setFilter(item.key)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
            <div className="flex min-h-[120px] flex-col justify-between rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
              <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--text-secondary)]">Room Charges</div>
              <div className="mt-4 text-2xl font-semibold text-[var(--text-primary)]">฿{formatMoney(folio?.summary.room_charges_total ?? 0)}</div>
            </div>
            <div className="flex min-h-[120px] flex-col justify-between rounded-2xl border border-rose-200 bg-rose-50 p-4 dark:bg-rose-500/10 dark:border-rose-500/20">
              <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-rose-700 dark:text-rose-400">Discount</div>
              <div className="mt-4 text-2xl font-semibold text-rose-800 dark:text-rose-200">฿{formatMoney(folio?.summary.discount_total ?? 0)}</div>
            </div>
            <div className="flex min-h-[120px] flex-col justify-between rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:bg-amber-500/10 dark:border-amber-500/20">
              <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-amber-700 dark:text-amber-400">Extra Charges</div>
              <div className="mt-4 text-2xl font-semibold text-amber-800 dark:text-amber-200">฿{formatMoney(folio?.summary.extra_charges_total ?? 0)}</div>
            </div>
            <div className="flex min-h-[120px] flex-col justify-between rounded-2xl border border-emerald-200 bg-emerald-50 p-4 dark:bg-emerald-500/10 dark:border-emerald-500/20">
              <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-400">Payments</div>
              <div className="mt-4 text-2xl font-semibold text-emerald-800 dark:text-emerald-200">฿{formatMoney(folio?.summary.payments_total ?? 0)}</div>
            </div>
            <div className="flex min-h-[120px] flex-col justify-between rounded-2xl border border-rose-200 bg-rose-50 p-4 dark:bg-rose-500/10 dark:border-rose-500/20">
              <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-rose-700 dark:text-rose-400">Refunds</div>
              <div className="mt-4 text-2xl font-semibold text-rose-800 dark:text-rose-200">฿{formatMoney(folio?.summary.refunds_total ?? 0)}</div>
            </div>
            <div className="flex min-h-[120px] flex-col justify-between rounded-2xl border border-indigo-200 bg-indigo-50 p-4 dark:bg-indigo-500/10 dark:border-indigo-500/20">
              <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-indigo-700 dark:text-indigo-400">Deposit Held</div>
              <div className="mt-4 text-2xl font-semibold text-indigo-800 dark:text-indigo-200">฿{formatMoney(depositHeld)}</div>
              {depositHeldNote && (
                <div className="mt-1 text-xs leading-snug text-indigo-700 dark:text-indigo-300">
                  Note: {depositHeldNote}
                </div>
              )}
            </div>
            <div className="flex min-h-[120px] flex-col justify-between rounded-2xl border border-[#312e81] bg-[#1e1b4b] p-4 text-white dark:border-indigo-500/30 dark:bg-indigo-900/40">
              <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-indigo-200/60 dark:text-indigo-300">Outstanding</div>
              <div className="mt-4 text-2xl font-semibold dark:text-indigo-50">฿{formatMoney(folio?.summary.outstanding_balance ?? 0)}</div>
            </div>
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-sm">
              <div className="flex items-center justify-between border-b border-[var(--border-default)] px-4 py-3">
                <div>
                  <div className="text-sm font-semibold text-[var(--text-primary)]">Unified Ledger</div>
                  <div className="text-xs text-[var(--text-secondary)]">Charges, payments, refunds, and deposits in one view</div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void loadFolio()}
                  disabled={loading}
                >
                  <RotateCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                  Refresh
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <colgroup>
                    <col className="w-[15%]" />
                    <col className="w-[16%]" />
                    <col className="w-[12%]" />
                    <col className="w-[19%]" />
                    <col className="w-[15%]" />
                    <col className="w-[16%]" />
                    <col className="w-[7%]" />
                  </colgroup>
                  <thead className="bg-[var(--bg-body)] text-left text-xs font-bold uppercase tracking-[0.16em] text-[var(--text-secondary)]">
                    <tr>
                      <th className="px-4 py-3">Date/Time</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Method</th>
                      <th className="px-4 py-3">Amount</th>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3">Note</th>
                      <th className="px-4 py-3">Cashier</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleLedger.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-8 text-center text-[var(--text-secondary)]">
                          No folio rows for this filter.
                        </td>
                      </tr>
                    ) : (
                      visibleLedger.map((row) => {
                        const isVoided = voidedRowIds.has(row.id);
                        return (
                          <tr
                            key={row.id}
                            className={`border-t border-[var(--border-subtle)] align-top ${row.is_record_only && !row.is_correction ? "opacity-60 italic" : ""} ${row.is_void_reversal || isVoided ? "italic" : ""} ${isVoided ? "line-through opacity-50" : ""}`}
                          >
                            <td className="px-4 py-3 font-medium text-[var(--text-table-cell)]">{formatLedgerDateTime(row.occurred_at)}</td>
                            <td className="px-4 py-3">
                              <div className="font-semibold text-[var(--text-primary)]">{getRowTypeLabel(row)}</div>
                              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                                <span>{row.label}</span>
                                {row.is_record_only && !row.is_correction ? (
                                  <span
                                    className="rounded-full bg-[var(--bg-surface-hover)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]"
                                    title="This transaction was settled in POS. Shown for reference only."
                                  >
                                    Record Only
                                  </span>
                                ) : null}
                                {row.is_void_reversal && (
                                  <span
                                    className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700 dark:bg-amber-500/20 dark:text-amber-400"
                                    title={row.correction_reason || "Reversal entry"}
                                  >
                                    VOID
                                  </span>
                                )}
                                {row.is_correction && (
                                  <span
                                    className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-blue-700 dark:bg-blue-500/20 dark:text-blue-400"
                                    title={row.correction_reason || "Adjustment entry"}
                                  >
                                    ADJ
                                  </span>
                                )}
                                {isVoided && (
                                  <span
                                    className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                                    title="This entry has been voided"
                                  >
                                    VOIDED
                                  </span>
                                )}
                              </div>
                            </td>
                          <td className="px-4 py-3 text-[var(--text-table-cell)]">
                            <div className="flex items-center gap-2">
                              <span>{getMethodLabel(row.method)}</span>
                              {canEditPaymentMethod(row) && isOperatorPaymentMethod(row.method) ? (
                                <button
                                  type="button"
                                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-secondary)] transition hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-primary)]"
                                  title="Edit payment method before Night Audit"
                                  onClick={() =>
                                    setPaymentMethodEdit({
                                      row,
                                      method: row.method as PaymentMethod,
                                      reason: "",
                                      referenceNote: row.note ?? "",
                                    })
                                  }
                                >
                                  <PencilLine className="h-3.5 w-3.5" />
                                </button>
                              ) : null}
                            </div>
                          </td>
                          <td className={`whitespace-nowrap px-4 py-3 font-mono font-semibold ${getAmountTone(row)}`}>
                            {getAmountPrefix(row)}฿{formatMoney(row.amount)}
                          </td>
                          <td className="px-4 py-3 text-[var(--text-secondary)]">
                            {row.template_name || row.revenue_category || "—"}
                          </td>
                          <td className="max-w-[260px] px-4 py-3 text-[var(--text-secondary)]">
                            <div className="truncate" title={row.note || ""}>
                              {row.note || "—"}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-[var(--text-secondary)]">{row.cashier_name || "—"}</td>
                        </tr>
                      );
                    })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 shadow-sm">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                  <WalletCards className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                  Action Rail
                </div>

                <div className="space-y-2">
                  {canAddPayment && (
                    <button
                      type="button"
                      className="btn btn-primary w-full justify-center dark:bg-brand-500/20 dark:text-brand-400 dark:border-brand-500/50 dark:hover:bg-brand-500/30 transition-all"
                      onClick={() => setShowPaymentForm((current) => !current)}
                    >
                      Add Payment
                    </button>
                  )}
                  {canPostCharge && (
                    <button
                      type="button"
                      className="btn btn-secondary w-full justify-center"
                      onClick={() => setShowPostCharge(true)}
                    >
                      Post Charge
                    </button>
                  )}
                  {canOpenSettlement && (
                    <button
                      type="button"
                      className="btn btn-secondary w-full justify-center"
                      onClick={() => setShowSettlement(true)}
                    >
                      Open Settlement
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost w-full justify-center"
                    onClick={() => void loadFolio()}
                    disabled={loading}
                  >
                    Refresh
                  </button>
                </div>
              </div>

              {canAddPayment && showPaymentForm && (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm dark:bg-emerald-500/10 dark:border-emerald-500/20">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-emerald-900 dark:text-emerald-400">
                    <ReceiptText className="h-4 w-4" />
                    Add Payment
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="form-label">Method</label>
                      <select
                        className="form-select"
                        value={paymentMethod}
                        onChange={(event) => {
                          const nextMethod = event.target.value as PaymentMethod;
                          setPaymentMethod(nextMethod);
                          if (nextMethod === "transfer") {
                            setPaymentTransferDetail(createDefaultTransferDetailDraft("", defaultTransferSenderName));
                          }
                        }}
                        disabled={submittingPayment}
                      >
                        {PAYMENT_METHODS.map((item) => (
                          <option key={item.value} value={item.value}>{item.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="form-label">{paymentMethod === "transfer" ? "Folio amount" : "Amount"}</label>
                      <input
                        className="form-input"
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={paymentAmount}
                        onChange={(event) => {
                          setPaymentAmount(event.target.value);
                          setError("");
                        }}
                        disabled={submittingPayment}
                        placeholder="0.00"
                      />
                    </div>
                    {paymentMethod === "transfer" ? (
                      <TransferDetailFields
                        value={paymentTransferDetail}
                        onChange={(next) => {
                          setPaymentTransferDetail(next);
                          setError("");
                        }}
                        disabled={submittingPayment}
                        compact
                      />
                    ) : (
                      <div>
                        <label className="form-label">Note</label>
                        <input
                          className="form-input"
                          type="text"
                          value={paymentNote}
                          onChange={(event) => setPaymentNote(event.target.value)}
                          disabled={submittingPayment}
                          placeholder="Optional"
                        />
                      </div>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="btn btn-secondary flex-1"
                        onClick={() => setShowPaymentForm(false)}
                        disabled={submittingPayment}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary flex-1"
                        onClick={() => void handlePaymentSubmit()}
                        disabled={submittingPayment}
                      >
                        {submittingPayment ? "Saving..." : "Save Payment"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-body)] p-4 shadow-sm">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                  <Landmark className="h-4 w-4 text-[var(--text-secondary)]" />
                  Quick Snapshot
                </div>
                <div className="space-y-2 text-sm text-[var(--text-secondary)]">
                  <div className="flex justify-between gap-3">
                    <span>Grand Total</span>
                    <span className="font-semibold text-[var(--text-primary)]">฿{formatMoney(folio?.summary.grand_total ?? totalPrice)}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>Deposit Held</span>
                    <span className="font-semibold text-[var(--text-primary)]">฿{formatMoney(folio?.summary.deposit_held ?? depositAmount)}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>Outstanding</span>
                    <span className="font-semibold text-[var(--text-primary)]">
                      ฿{formatMoney(fromSatang(billingData?.outstandingSatang ?? toSatang(folio?.summary.outstanding_balance ?? 0)))}
                    </span>
                  </div>
                  <div className="border-t border-[var(--border-default)] pt-3 mt-1 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex flex-col">
                        <label htmlFor="tax-invoice-toggle" className="text-sm font-semibold text-[var(--text-primary)] cursor-pointer select-none">
                          Tax Invoice
                        </label>
                        <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-tight">
                          {taxInvoiceNo ? (
                            <span className="text-brand-600 font-bold flex items-center gap-1">
                              <CheckCircle2 className="h-2.5 w-2.5" /> {taxInvoiceNo}
                            </span>
                          ) : taxInvoiceRequested ? (
                            <span className="text-amber-600 font-bold">Pending Request</span>
                          ) : (
                            "Not Requested"
                          )}
                        </p>
                      </div>
                      <button
                        id="tax-invoice-toggle"
                        type="button"
                        role="switch"
                        aria-checked={taxInvoiceRequested}
                        disabled={taxInvoiceLoading}
                        onClick={() => void handleToggleTaxInvoice()}
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-1 ${
                          taxInvoiceRequested
                            ? "bg-[var(--accent)]"
                            : "bg-[var(--border-default)]"
                        } ${taxInvoiceLoading ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ${
                            taxInvoiceRequested ? "translate-x-[18px]" : "translate-x-[3px]"
                          }`}
                        />
                      </button>
                    </div>
                    
                    {/* Locking logic: Business Date > Checkout Date requires Admin bypass */}
                    {folio?.reservation.checkout_date && businessDate > folio.reservation.checkout_date && (
                      <div className="flex items-start gap-2 p-2 rounded-lg bg-rose-50 dark:bg-rose-500/10 border border-rose-100 dark:border-rose-500/20">
                        <ShieldAlert className="h-3 w-3 text-rose-600 mt-0.5 shrink-0" />
                        <p className="text-[10px] text-rose-700 dark:text-rose-400 leading-tight">
                          Folio locked after checkout date. Changes require Admin bypass.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 shadow-sm">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
                  <FileClock className="h-4 w-4 text-[var(--text-secondary)]" />
                  Notes
                </div>
                <p className="text-sm leading-6 text-[var(--text-secondary)]">
                  This full folio view is the detailed financial workspace for the reservation. Inline booking folio can be reduced later after this view is validated.
                </p>
              </div>
            </div>
          </div>
        </div>
      </PmsModal>

      {paymentMethodEdit && (
        <PmsModal
          title="Edit Payment Method"
          size="sm"
          onClose={() => {
            if (!submittingMethodEdit) setPaymentMethodEdit(null);
          }}
          footer={
            <div className="flex w-full items-center justify-end gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setPaymentMethodEdit(null)}
                disabled={submittingMethodEdit}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handlePaymentMethodEditSubmit()}
                disabled={submittingMethodEdit || paymentMethodEdit.reason.trim().length < 3}
              >
                {submittingMethodEdit ? "Updating..." : "Update Method"}
              </button>
            </div>
          }
        >
          <div className="space-y-4">
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
              This changes only the payment method bucket before Night Audit. Amount, payment date, and payment time stay unchanged.
            </div>

            <div className="grid gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-body)] p-4 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-[var(--text-secondary)]">Current method</span>
                <span className="font-semibold text-[var(--text-primary)]">{getMethodLabel(paymentMethodEdit.row.method)}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-[var(--text-secondary)]">Amount</span>
                <span className="font-mono font-semibold text-[var(--text-primary)]">฿{formatMoney(paymentMethodEdit.row.amount)}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-[var(--text-secondary)]">Paid date</span>
                <span className="font-semibold text-[var(--text-primary)]">{paymentMethodEdit.row.paid_date || "—"}</span>
              </div>
            </div>

            <div>
              <label className="form-label">New method</label>
              <select
                className="form-select"
                value={paymentMethodEdit.method}
                onChange={(event) =>
                  setPaymentMethodEdit((current) =>
                    current
                      ? { ...current, method: event.target.value as PaymentMethod }
                      : current
                  )
                }
                disabled={submittingMethodEdit}
              >
                {PAYMENT_METHODS.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="form-label">Reason</label>
              <input
                className="form-input"
                type="text"
                value={paymentMethodEdit.reason}
                onChange={(event) =>
                  setPaymentMethodEdit((current) =>
                    current ? { ...current, reason: event.target.value } : current
                  )
                }
                disabled={submittingMethodEdit}
                placeholder="Wrong method selected by FO"
              />
            </div>

            <div>
              <label className="form-label">Reference / note</label>
              <input
                className="form-input"
                type="text"
                value={paymentMethodEdit.referenceNote}
                onChange={(event) =>
                  setPaymentMethodEdit((current) =>
                    current ? { ...current, referenceNote: event.target.value } : current
                  )
                }
                disabled={submittingMethodEdit}
                placeholder="Optional bank ref or context"
              />
            </div>
          </div>
        </PmsModal>
      )}

      {showPostCharge && (
        <PostChargeModal
          open={showPostCharge}
          onClose={() => setShowPostCharge(false)}
          reservationId={reservationId}
          onChargePosted={() => {
            window.dispatchEvent(new CustomEvent("billing-panel-refresh"));
            onInlineRefresh?.();
            void loadFolio();
          }}
        />
      )}

      {showSettlement && (
        <SettlementDrawer
          open={showSettlement}
          onClose={() => setShowSettlement(false)}
          reservationId={reservationId}
          totalPrice={totalPrice}
          depositAmount={depositAmount}
          policyFeePayload={policyFeePayload}
          billingData={billingData}
          onCheckoutComplete={() => {
            setShowSettlement(false);
            onCheckoutComplete();
          }}
        />
      )}
    </>
  );
}
