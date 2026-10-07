"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { mergeSameRateRoomLineItems } from "@/lib/tax-invoice/line-item-merge";
import { mergeExtraIntoRoomLines } from "@/lib/tax-invoice/merge-extra-into-room";
import {
  itemDiscountAmount,
  itemGrossAmount,
  trimRoomLineItemToDates,
} from "@/lib/tax-invoice/trim-room-line";
import {
  TaxInvoiceLineItem,
  TaxInvoiceTotals,
  TaxInvoiceBookingSnapshot,
  TaxInvoiceLanguage,
  TaxInvoiceKind,
  BuildLineItemsResult,
  TaxInvoiceAvailableExtraItem,
} from "@/lib/tax-invoice/types";
import {
  fmtMoney,
  getLabels,
  computeVatInclusiveTotals,
  compareRoomNumber,
  formatTaxInvoiceItemDescription,
  formatTaxInvoiceItemUnit,
  round2,
} from "@/lib/tax-invoice/utils";

// ─── Date helpers ────────────────────────────────────────────────────────────

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d + n); // local date arithmetic — no UTC offset issue
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function daysBetween(from: string, to: string): number {
  if (!from || !to) return 0;
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const a = new Date(fy, fm - 1, fd);
  const b = new Date(ty, tm - 1, td);
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

function fmtDisplayDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00+07:00`);
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  });
}

type DisplayLineItem = {
  item: TaxInvoiceLineItem;
  sourceIndex: number;
};

function normalizeInvoiceKind(value: unknown): TaxInvoiceKind {
  const kind = String(value ?? "standard").trim().toLowerCase();
  return kind === "prepayment" || kind === "balance" ? kind : "standard";
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface TaxProfile {
  id?: string;
  tax_id: string;
  company_name: string;
  address: string;
  branch: string;
}

interface TaxInvoiceFormProps {
  initialData?: BuildLineItemsResult;
  invoiceId?: string;
  mode: "issue" | "edit";
  /** reservationId — used for Refresh Folio in edit mode */
  reservationId?: string;
  existingInvoice?: {
    language?: TaxInvoiceLanguage;
    customer_name?: string;
    customer_tax_id?: string;
    customer_address?: string;
    customer_branch?: string;
    remark?: string | null;
    issue_date?: string;
    invoice_kind?: TaxInvoiceKind | null;
    coverage_amount?: number | null;
    coverage_note?: string | null;
    manual_issue_date_reason?: string | null;
  };
  initialPeriod?: {
    from: string;
    to: string;
  };
  initialInvoiceKind?: TaxInvoiceKind;
  viewerIsAdmin?: boolean;
  businessDate?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function TaxInvoiceForm({
  initialData,
  invoiceId,
  mode,
  reservationId,
  existingInvoice,
  initialPeriod,
  initialInvoiceKind,
  viewerIsAdmin = false,
  businessDate,
}: TaxInvoiceFormProps) {
  const router = useRouter();

  // ── Customer form state ────────────────────────────────────────────────────
  const [language, setLanguage] = useState<TaxInvoiceLanguage>(
    existingInvoice?.language || "th"
  );
  const [customerName, setCustomerName] = useState(
    existingInvoice?.customer_name || initialData?.reservation.guest_name || ""
  );
  const [customerTaxId, setCustomerTaxId] = useState(
    existingInvoice?.customer_tax_id || ""
  );
  const [customerAddress, setCustomerAddress] = useState(
    existingInvoice?.customer_address || ""
  );
  const [customerBranch, setCustomerBranch] = useState(
    existingInvoice?.customer_branch || "00000"
  );
  const [remark, setRemark] = useState(existingInvoice?.remark || "");
  const [isPassport, setIsPassport] = useState(false);
  const [updateReason, setUpdateReason] = useState("");
  const [invoiceKind, setInvoiceKind] = useState<TaxInvoiceKind>(
    normalizeInvoiceKind(existingInvoice?.invoice_kind ?? initialInvoiceKind)
  );
  const [issueDate, setIssueDate] = useState(
    existingInvoice?.issue_date || businessDate || new Date().toISOString().slice(0, 10)
  );
  const [coverageAmount, setCoverageAmount] = useState(
    existingInvoice?.coverage_amount ? String(existingInvoice.coverage_amount) : ""
  );
  const [coverageNote, setCoverageNote] = useState(existingInvoice?.coverage_note || "");
  const [manualIssueDateReason, setManualIssueDateReason] = useState(
    existingInvoice?.manual_issue_date_reason || "Admin manual split invoice date"
  );

  // ── Line items & booking state ─────────────────────────────────────────────
  const [lineItems, setLineItems] = useState<TaxInvoiceLineItem[]>(
    initialData?.line_items || []
  );
  const [availableExtraItems, setAvailableExtraItems] = useState<TaxInvoiceAvailableExtraItem[]>(
    initialData?.available_extra_items || []
  );
  const [showExtraPicker, setShowExtraPicker] = useState(false);
  const [mergeSameRateRows, setMergeSameRateRows] = useState(false);
  const [booking, setBooking] = useState<TaxInvoiceBookingSnapshot | null>(
    initialData?.booking_snapshot || null
  );

  // ── Edit mode: date range selector ────────────────────────────────────────
  const fullCheckin = booking?.checkin_date ?? "";
  const fullCheckout = booking?.checkout_date ?? "";
  const [editFrom, setEditFrom] = useState<string>(initialPeriod?.from || fullCheckin);
  const [editTo, setEditTo] = useState<string>(initialPeriod?.to || fullCheckout);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [refreshLoading, setRefreshLoading] = useState(false);
  const [showProfileDropdown, setShowProfileDropdown] = useState(false);

  const l = getLabels(language);

  // ── Filtered line items: trim room charges to selected invoice period ──
  const baseFilteredDisplayItems = useMemo((): DisplayLineItem[] => {
    if (!editFrom || !editTo) return lineItems.map((item, sourceIndex) => ({ item, sourceIndex }));
    return lineItems.flatMap((item, sourceIndex) => {
      if (item.kind !== "room_charge" || !item.stay_dates?.length) {
        return [{ item, sourceIndex }]; // Extra charges always included
      }
      const inRange = item.stay_dates.filter(
        (d) => d >= editFrom && d < editTo
      );
      if (inRange.length === 0) return [];
      return [{ item: trimRoomLineItemToDates(item, inRange), sourceIndex }];
    });
  }, [lineItems, editFrom, editTo]);

  const baseFilteredLineItems = useMemo(
    () => baseFilteredDisplayItems.map((row) => row.item),
    [baseFilteredDisplayItems]
  );

  const filteredLineItems = useMemo(
    () => mergeSameRateRows
      ? mergeSameRateRoomLineItems(baseFilteredLineItems, language)
      : baseFilteredLineItems,
    [baseFilteredLineItems, language, mergeSameRateRows]
  );

  const filteredDisplayItems = useMemo(
    () => mergeSameRateRows
      ? filteredLineItems.map((item, index) => ({ item, sourceIndex: -1 - index }))
      : baseFilteredDisplayItems,
    [baseFilteredDisplayItems, filteredLineItems, mergeSameRateRows]
  );

  // ── Sorted line items for display (preserve original idx for display only) ─
  const sortedDisplayItems = useMemo(() => {
    const source = filteredDisplayItems;
    return [...source].sort((a, b) => {
      if (a.item.room_number && b.item.room_number)
        return compareRoomNumber(a.item.room_number, b.item.room_number);
      if (a.item.room_number) return -1;
      if (b.item.room_number) return 1;
      return 0;
    });
  }, [filteredDisplayItems]);

  // ── Totals ─────────────────────────────────────────────────────────────────
  const totals = useMemo((): TaxInvoiceTotals => {
    const items = filteredLineItems;
    const gross = items.reduce((acc, it) => acc + itemGrossAmount(it), 0);
    const discount = items.reduce((acc, it) => acc + itemDiscountAmount(it), 0);
    return computeVatInclusiveTotals(gross, discount);
  }, [filteredLineItems]);

  const splitCoveragePreview = invoiceKind === "prepayment"
    ? Math.max(0, Number(coverageAmount || 0))
    : null;

  // ── Date range helpers ─────────────────────────────────────────────────────
  const selectedNights = daysBetween(editFrom, editTo);
  const fullNights = daysBetween(fullCheckin, fullCheckout);
  const excludedNights = fullNights - selectedNights;

  function shiftFrom(delta: number) {
    const next = addDays(editFrom, delta);
    if (next < fullCheckin) return;
    if (next >= editTo) return;
    setEditFrom(next);
  }

  function shiftTo(delta: number) {
    const next = addDays(editTo, delta);
    if (next > fullCheckout) return;
    if (next <= editFrom) return;
    setEditTo(next);
  }

  // ── Refresh folio ──────────────────────────────────────────────────────────
  const handleRefreshFolio = async () => {
    if (!reservationId) return;
    setRefreshLoading(true);
    try {
      const res = await fetch(
        `/api/tax-invoice/build-line-items/${reservationId}`
      );
      const result = await res.json();
      if (!result.success)
        throw new Error(result.error || "Failed to refresh folio");
      const newItems: TaxInvoiceLineItem[] = result.data?.line_items || [];
      const newExtraItems: TaxInvoiceAvailableExtraItem[] = result.data?.available_extra_items || [];
      const newBooking: TaxInvoiceBookingSnapshot | null =
        result.data?.booking_snapshot || null;
      setLineItems(newItems);
      setAvailableExtraItems(newExtraItems);
      setBooking(newBooking);
      // Reset range to full new period
      setEditFrom(newBooking?.checkin_date ?? "");
      setEditTo(newBooking?.checkout_date ?? "");
    } catch (err: any) {
      alert(err.message || "Refresh failed");
    } finally {
      setRefreshLoading(false);
    }
  };

  const selectedExtraIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of lineItems) {
      for (const id of item.merged_extra_charge_ids ?? []) ids.add(id);
    }
    return ids;
  }, [lineItems]);

  const invoiceNightOptions = useMemo(() => {
    if (!editFrom || !editTo) return [];
    const nights: string[] = [];
    let cursor = editFrom;
    while (cursor < editTo) {
      nights.push(cursor);
      cursor = addDays(cursor, 1);
    }
    return nights;
  }, [editFrom, editTo]);

  const [selectedExtraNightById, setSelectedExtraNightById] = useState<Record<string, string>>({});

  const getSelectedExtraNight = (extra: TaxInvoiceAvailableExtraItem) =>
    selectedExtraNightById[extra.id]
    ?? (extra.paid_date && invoiceNightOptions.includes(extra.paid_date) ? extra.paid_date : undefined)
    ?? invoiceNightOptions[0]
    ?? "";

  const updateLineItemDescription = (sourceIndex: number, description: string) => {
    if (sourceIndex < 0) return;
    setLineItems((current) =>
      current.map((item, index) => (index === sourceIndex ? { ...item, description } : item))
    );
  };

  const addExtraAsSeparateLine = (extra: TaxInvoiceAvailableExtraItem) => {
    if (selectedExtraIds.has(extra.id)) return;
    const description = extra.description || extra.note || "Extra Charge";
    setLineItems((current) => [
      ...current,
      {
        kind: "extra_charge",
        description,
        quantity: 1,
        unit: "รายการ",
        unit_price: round2(extra.amount),
        amount: round2(extra.amount),
        room_number: extra.room_number,
        reservation_id: extra.reservation_id,
        merged_extra_charge_ids: [extra.id],
        merged_extra_charge_total: round2(extra.amount),
        fee_template_code: extra.fee_template_code ?? null,
        note: null,
      },
    ]);
  };

  const removeLineItem = (sourceIndex: number) => {
    setLineItems((current) => current.filter((_, index) => index !== sourceIndex));
  };

  const addExtraToRoomCharge = (
    extra: TaxInvoiceAvailableExtraItem,
    mode: "average" | "specific",
    specificDate?: string
  ) => {
    if (selectedExtraIds.has(extra.id)) return;
    const targetDates = mode === "specific"
      ? specificDate
        ? [specificDate]
        : []
      : invoiceNightOptions;
    if (targetDates.length === 0) return;

    setLineItems((current) =>
      mergeExtraIntoRoomLines(current, extra, targetDates, invoiceNightOptions)
    );
  };

  // ── Lookup ─────────────────────────────────────────────────────────────────
  const handleLookup = async () => {
    if (!customerTaxId || customerTaxId.length < 13) return;
    setLookupLoading(true);
    try {
      const res = await fetch("/api/tax/lookup", {
        method: "POST",
        body: JSON.stringify({ tax_id: customerTaxId }),
      });
      const data = await res.json();
      if (data.success) {
        setCustomerName(data.name);
        setCustomerAddress(data.address);
        setCustomerBranch(data.branch || "00000");
      }
    } catch (e) {
      console.error("Lookup failed", e);
    } finally {
      setLookupLoading(false);
    }
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleIssue = async () => {
    if (!initialData?.reservation?.id && !invoiceId) {
      alert("Missing reservation or invoice ID");
      return;
    }
    setLoading(true);
    try {
      if (mode === "issue") {
        // Step 1: Create draft
        const createRes = await fetch("/api/tax-invoice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reservation_id: initialData!.reservation.id,
            reservation_ids: initialData!.reservation.reservation_ids,
            language,
            customer_name: customerName,
            customer_tax_id: customerTaxId,
            customer_address: customerAddress,
            customer_branch: customerBranch,
            remark: remark.trim() || null,
            is_passport: isPassport,
            line_items: filteredLineItems,
            discount: 0,
            invoice_kind: invoiceKind,
            issue_date: invoiceKind !== "standard" ? issueDate : undefined,
            coverage_amount: invoiceKind === "prepayment" ? Number(coverageAmount || 0) : undefined,
            coverage_note: invoiceKind !== "standard" ? coverageNote.trim() || null : undefined,
            manual_issue_date_reason: invoiceKind !== "standard" ? manualIssueDateReason.trim() || null : undefined,
            save_customer_profile: true,
          }),
        });
        const createResult = await createRes.json();
        if (!createRes.ok || !createResult.success)
          throw new Error(createResult.error || "Failed to create invoice");

        // Step 2: Issue (finalize)
        const draftId = createResult.data?.id ?? createResult.invoice?.id;
        const issueRes = await fetch(`/api/tax-invoice/${draftId}/issue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(invoiceKind !== "standard" ? { issue_date: issueDate } : {}),
        });
        const issueResult = await issueRes.json();
        if (!issueRes.ok || !issueResult.success)
          throw new Error(issueResult.error || "Failed to issue invoice");

        const issuedId =
          issueResult.data?.id ?? issueResult.invoice?.id ?? draftId;
        setShowConfirm(false);
        router.push(`/pms/tax-invoice/preview/${issuedId}?updated=${Date.now()}`);
      } else {
        // Edit mode: PATCH with filtered items only
        const patchRes = await fetch(`/api/tax-invoice/${invoiceId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            language,
            customer_name: customerName,
            customer_tax_id: customerTaxId,
            customer_address: customerAddress,
            customer_branch: customerBranch,
            remark: remark.trim() || null,
            is_passport: isPassport,
            line_items: filteredLineItems,
            discount: 0,
            issue_date: invoiceKind !== "standard" ? issueDate : undefined,
            coverage_amount: invoiceKind === "prepayment" ? Number(coverageAmount || 0) : undefined,
            coverage_note: invoiceKind !== "standard" ? coverageNote.trim() || null : undefined,
            manual_issue_date_reason: invoiceKind !== "standard" ? manualIssueDateReason.trim() || null : undefined,
            update_reason: updateReason.trim() || undefined,
          }),
        });
        const patchResult = await patchRes.json();
        if (!patchRes.ok || !patchResult.success)
          throw new Error(patchResult.error || "Failed to update invoice");

        setShowConfirm(false);
        const updatedAt = patchResult.data?.updated_at ?? patchResult.invoice?.updated_at ?? Date.now();
        router.push(`/pms/tax-invoice/preview/${invoiceId}?updated=${encodeURIComponent(String(updatedAt))}`);
      }
    } catch (e: any) {
      alert(e.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  // ────────────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* ── Edit mode info banner ── */}
      {mode === "edit" && (
        <div className="flex items-start gap-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl p-4">
          <span className="text-lg leading-none mt-0.5">ℹ️</span>
          <div className="text-sm text-amber-800 dark:text-amber-300 leading-relaxed">
            <p className="font-bold mb-0.5">การแก้ไขใบกำกับภาษีที่ออกแล้ว</p>
            <p>
              ระบบต้อง Issue ใบครบทุกรายการก่อน ค่อยกลับมาที่นี่เพื่อเลือกช่วงวันที่ต้องการ
              ระบบจะคำนวณยอดจากช่วงวันที่เลือกเท่านั้น พร้อมระบุเหตุผลก่อนบันทึก
            </p>
          </div>
        </div>
      )}

      {/* ── Top bar: Language + action buttons ── */}
      <div className="flex items-center justify-between bg-[var(--bg-surface)] p-4 rounded-xl border border-[var(--border-default)] shadow-sm">
        <div className="flex items-center gap-6">
          <div>
            <p className="text-[10px] font-bold uppercase text-[var(--text-muted)] mb-1">
              Select Language
            </p>
            <div className="flex bg-[var(--bg-muted)] p-1 rounded-lg">
              <button
                onClick={() => setLanguage("th")}
                className={`px-4 py-1.5 text-xs font-bold rounded-md transition ${
                  language === "th"
                    ? "bg-white dark:bg-white/10 shadow-sm text-brand-600"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                ภาษาไทย (TH)
              </button>
              <button
                onClick={() => setLanguage("en")}
                className={`px-4 py-1.5 text-xs font-bold rounded-md transition ${
                  language === "en"
                    ? "bg-white dark:bg-white/10 shadow-sm text-brand-600"
                    : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                English (EN)
              </button>
            </div>
          </div>

          {booking && (
            <div className="h-10 w-px bg-[var(--border-subtle)]" />
          )}

          {booking && (
            <div>
              <p className="text-[10px] font-bold uppercase text-[var(--text-muted)] mb-1">
                Reservation Info
              </p>
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                {booking.booking_code || "N/A"} · {booking.room_numbers.join(", ")}
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => router.back()}
            className="px-4 py-2 text-sm font-bold text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (!customerName || !customerTaxId) {
                alert("Please enter Customer Name and Tax ID");
                return;
              }
              if (
                !isPassport &&
                (customerTaxId.length !== 13 || !/^\d+$/.test(customerTaxId))
              ) {
                alert("Tax ID must be exactly 13 numeric digits (or check Passport)");
                return;
              }
              if (isPassport && !customerTaxId.trim()) {
                alert("Please enter Passport number");
                return;
              }
              if (mode === "edit" && !updateReason.trim()) {
                alert("กรุณาระบุเหตุผลการแก้ไข");
                return;
              }
              if (invoiceKind !== "standard" && !viewerIsAdmin) {
                alert("เฉพาะ Admin เท่านั้นที่ออกหรือแก้ไขใบ Prepayment / Balance ได้");
                return;
              }
              if (invoiceKind === "prepayment" && Number(coverageAmount || 0) <= 0) {
                alert("กรุณาระบุยอด Prepayment มากกว่า 0");
                return;
              }
              if (invoiceKind !== "standard" && !manualIssueDateReason.trim()) {
                alert("กรุณาระบุเหตุผลวันที่ Manual สำหรับใบ Split");
                return;
              }
              if (mode === "edit" && filteredLineItems.length === 0) {
                alert("ไม่มีรายการในช่วงวันที่เลือก กรุณาปรับช่วงวันที่");
                return;
              }
              setShowConfirm(true);
            }}
            className="px-6 py-2 rounded-xl bg-brand-600 text-white font-bold text-sm shadow-md hover:bg-brand-700 transition active:scale-95"
          >
            {mode === "issue" ? "Issue Official Invoice" : "Update Document"}
          </button>
        </div>
      </div>

      {(viewerIsAdmin || invoiceKind !== "standard") && (
        <div className="bg-[var(--bg-surface)] p-4 rounded-xl border border-[var(--border-default)] shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase text-[var(--text-muted)] mb-2">
                Invoice Coverage
              </p>
              <div className="flex flex-wrap gap-2">
                {(["standard", "prepayment", "balance"] as TaxInvoiceKind[]).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    disabled={!viewerIsAdmin || mode === "edit"}
                    onClick={() => setInvoiceKind(kind)}
                    className={`px-3 py-2 rounded-lg border text-xs font-bold transition ${
                      invoiceKind === kind
                        ? "border-brand-400 bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
                        : "border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    } ${!viewerIsAdmin || mode === "edit" ? "opacity-70 cursor-not-allowed" : ""}`}
                  >
                    {kind === "standard" ? "Standard" : kind === "prepayment" ? "Prepayment" : "Balance"}
                  </button>
                ))}
              </div>
            </div>

            {invoiceKind !== "standard" && (
              <div className="grid flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className="form-label">Issue Date</label>
                  <input
                    type="date"
                    value={issueDate}
                    onChange={(event) => setIssueDate(event.target.value)}
                    disabled={!viewerIsAdmin}
                    className="form-input"
                  />
                </div>
                {invoiceKind === "prepayment" ? (
                  <div>
                    <label className="form-label">Coverage Amount</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={coverageAmount}
                      onChange={(event) => setCoverageAmount(event.target.value)}
                      disabled={!viewerIsAdmin}
                      className="form-input"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="form-label">Coverage Amount</label>
                    <div className="form-input flex items-center text-sm font-bold text-[var(--text-muted)]">
                      Auto balance
                    </div>
                  </div>
                )}
                <div>
                  <label className="form-label">Coverage Note</label>
                  <input
                    type="text"
                    value={coverageNote}
                    onChange={(event) => setCoverageNote(event.target.value)}
                    disabled={!viewerIsAdmin}
                    className="form-input"
                  />
                </div>
                <div>
                  <label className="form-label">Manual Date Reason</label>
                  <input
                    type="text"
                    value={manualIssueDateReason}
                    onChange={(event) => setManualIssueDateReason(event.target.value)}
                    disabled={!viewerIsAdmin}
                    className="form-input"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Main grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Left: Customer details ── */}
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-[var(--bg-surface)] p-5 rounded-xl border border-[var(--border-default)] shadow-sm">
            <h2 className="text-sm font-bold text-[var(--text-primary)] mb-4 flex items-center gap-2">
              <span>👤</span> {l.customer} Details
            </h2>

            <div className="space-y-4">
              <div>
                <label className="form-label">{l.taxId}</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={customerTaxId}
                      onChange={(e) => setCustomerTaxId(e.target.value)}
                      placeholder="Enter 13-digit Tax ID"
                      className="form-input"
                    />
                    {showProfileDropdown && (
                      <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl shadow-xl max-h-48 overflow-y-auto" />
                    )}
                  </div>
                  <button
                    onClick={handleLookup}
                    disabled={lookupLoading || customerTaxId.length < 13}
                    className="px-3 py-2 bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400 border border-sky-100 dark:border-sky-500/20 rounded-lg text-xs font-bold hover:bg-sky-100 transition whitespace-nowrap disabled:opacity-50"
                  >
                    {lookupLoading ? "..." : "Lookup"}
                  </button>
                </div>
                <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={isPassport}
                    onChange={(e) => {
                      setIsPassport(e.target.checked);
                      if (e.target.checked) setLanguage("en");
                    }}
                    className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="text-xs font-medium text-[var(--text-secondary)]">
                    Passport (ไม่ใช่เลข 13 หลัก)
                  </span>
                </label>
              </div>

              <div>
                <label className="form-label">Company Name / Guest Name</label>
                <input
                  type="text"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  className="form-input"
                />
              </div>

              <div>
                <label className="form-label">{l.branch}</label>
                <input
                  type="text"
                  value={customerBranch}
                  onChange={(e) => setCustomerBranch(e.target.value)}
                  placeholder="00000 (HQ)"
                  className="form-input"
                />
              </div>

              <div>
                <label className="form-label">{l.address}</label>
                <textarea
                  value={customerAddress}
                  onChange={(e) => setCustomerAddress(e.target.value)}
                  className="form-input min-h-[100px]"
                />
              </div>

              <div>
                <label className="form-label">{l.remark}</label>
                <textarea
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                  placeholder={language === "th" ? "ข้อความที่ต้องการพิมพ์ในช่องหมายเหตุ" : "Text to print in the remark box"}
                  rows={3}
                  maxLength={2000}
                  className="form-input min-h-[80px]"
                />
                <p className="text-[10px] text-[var(--text-muted)] mt-1">
                  {language === "th"
                    ? "ข้อความนี้จะแสดงบนใบกำกับภาษี"
                    : "This text will appear on the printed tax invoice."}
                </p>
              </div>

              {mode === "edit" && (
                <div className="pt-2 border-t border-[var(--border-subtle)]">
                  <label className="form-label text-amber-700 dark:text-amber-400">
                    เหตุผลการแก้ไข{" "}
                    <span className="text-rose-500">*</span>
                  </label>
                  <textarea
                    value={updateReason}
                    onChange={(e) => setUpdateReason(e.target.value)}
                    placeholder="ระบุเหตุผล เช่น แก้ไขที่อยู่, ตัดรายการบางคืน..."
                    rows={2}
                    className="form-input min-h-[60px] resize-none border-amber-200 dark:border-amber-500/30 focus:ring-amber-400"
                  />
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">
                    หมายเหตุนี้บันทึกใน system เท่านั้น ไม่แสดงบนกระดาษ
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Right: Date range + Line items ── */}
        <div className="lg:col-span-2 space-y-6">

          {/* ── Date range picker — booking-style ── */}
          {fullCheckin && fullCheckout && (
            <div className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] shadow-sm overflow-hidden">
              {/* Header */}
              <div className="px-5 py-3.5 bg-[var(--bg-muted)] border-b border-[var(--border-default)] flex items-center justify-between">
                <h2 className="text-sm font-bold text-[var(--text-primary)] flex items-center gap-2">
                  <span>📅</span> ช่วงวันที่ออกใบ / Invoice Period
                </h2>
                <div className="flex items-center gap-3">
                  {excludedNights > 0 ? (
                    <span className="text-xs font-bold text-amber-600 dark:text-amber-400">
                      ตัดออก {excludedNights} คืน
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold text-emerald-600">
                      ✓ ครบทุกคืน
                    </span>
                  )}
                  {reservationId && (
                    <button
                      onClick={handleRefreshFolio}
                      disabled={refreshLoading}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-sky-700 dark:text-sky-400 bg-sky-50 dark:bg-sky-500/10 border border-sky-100 dark:border-sky-500/20 rounded-lg hover:bg-sky-100 transition disabled:opacity-60"
                    >
                      {refreshLoading ? (
                        <span className="w-3 h-3 border-2 border-sky-300 border-t-sky-600 rounded-full animate-spin" />
                      ) : "🔄"}
                      Refresh from Folio
                    </button>
                  )}
                </div>
              </div>

              {/* Booking-style date range row */}
              <div className="p-5">
                <div className="flex items-end gap-3 bg-[var(--bg-muted)] rounded-2xl border border-[var(--border-subtle)] p-3">

                  {/* ── Left: check-in date input (grayed, read-only) ── */}
                  <div className="flex-1">
                    <input
                      type="date"
                      value={editFrom}
                      min={fullCheckin}
                      max={addDays(editTo, -1)}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v >= fullCheckin && v < editTo) setEditFrom(v);
                      }}
                      className="w-full px-4 py-3 rounded-xl bg-white dark:bg-white/5 border border-[var(--border-default)] text-sm font-bold text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-brand-400 cursor-pointer shadow-sm"
                    />
                  </div>

                  {/* ── Center: ← NIGHTS → counter ── */}
                  <div className="flex flex-col items-center gap-1 shrink-0">
                    <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                      ← NIGHTS →
                    </p>
                    <div className="flex items-center gap-0 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl overflow-hidden shadow-sm">
                      <button
                        onClick={() => shiftTo(-1)}
                        disabled={selectedNights <= 1}
                        className="w-10 h-10 flex items-center justify-center text-lg font-black text-[var(--text-secondary)] hover:bg-[var(--bg-muted)] disabled:opacity-30 transition"
                      >
                        −
                      </button>
                      <div className="w-12 h-10 flex items-center justify-center text-base font-black text-[var(--text-primary)] border-x border-[var(--border-subtle)]">
                        {selectedNights}
                      </div>
                      <button
                        onClick={() => shiftTo(1)}
                        disabled={editTo >= fullCheckout}
                        className="w-10 h-10 flex items-center justify-center text-lg font-black text-[var(--text-secondary)] hover:bg-[var(--bg-muted)] disabled:opacity-30 transition"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  {/* ── Right: check-out date input (white, editable) ── */}
                  <div className="flex-1">
                    <input
                      type="date"
                      value={editTo}
                      min={addDays(editFrom, 1)}
                      max={fullCheckout}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v > editFrom && v <= fullCheckout) setEditTo(v);
                      }}
                      className="w-full px-4 py-3 rounded-xl bg-white dark:bg-white/5 border border-[var(--border-default)] text-sm font-bold text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-brand-400 cursor-pointer shadow-sm"
                    />
                  </div>
                </div>

                {/* Full stay reference */}
                <p className="mt-2.5 text-[10px] text-[var(--text-muted)] text-center">
                  Full stay: {fmtDisplayDate(fullCheckin)} → {fmtDisplayDate(fullCheckout)} ({fullNights} คืน)
                </p>
              </div>
            </div>
          )}

          {/* ── Line items table ── */}
          <div className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] shadow-sm overflow-hidden">
            <div className="px-5 py-4 bg-[var(--bg-muted)] border-b border-[var(--border-default)] flex justify-between items-center">
              <h2 className="text-sm font-bold text-[var(--text-primary)]">
                Revenue Items
                <span className="ml-2 text-[10px] font-bold text-[var(--text-muted)]">
                  · {filteredLineItems.length} รายการ
                </span>
              </h2>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setMergeSameRateRows((value) => !value)}
                  className={`rounded-lg border px-3 py-1.5 text-[10px] font-bold uppercase transition ${
                    mergeSameRateRows
                      ? "border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300"
                      : "border-[var(--border-default)] text-[var(--text-secondary)] hover:text-brand-600"
                  }`}
                >
                  {mergeSameRateRows ? "Merged rows" : "Merge same rate"}
                </button>
                {/* Also reachable while editing: an issued invoice can be missing
                    an extra charge (see the edit page's line_items comment), and
                    without this button there was no way to put it back from the
                    UI at all. selectedExtraIds already blocks adding the same
                    folio charge twice. */}
                <button
                  type="button"
                  onClick={() => setShowExtraPicker((value) => !value)}
                  className="text-[10px] uppercase font-bold text-brand-600 hover:text-brand-700"
                >
                  + Add Item
                </button>
              </div>
            </div>

            {showExtraPicker && (
              <div className="border-b border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-bold text-[var(--text-primary)]">Available extra charges</p>
                  <p className="text-[10px] text-[var(--text-muted)]">เพิ่มแยกบรรทัด หรือรวมเข้า Room charge เฉพาะใบนี้</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {availableExtraItems.length === 0 ? (
                    <p className="text-xs text-[var(--text-muted)]">ไม่มี Extra charge สำหรับ folio นี้</p>
                  ) : (
                    availableExtraItems.map((extra) => {
                      const selected = selectedExtraIds.has(extra.id);
                      return (
                        <div
                          key={extra.id}
                          aria-disabled={selected}
                          className={`rounded-lg border px-3 py-2 text-left text-xs transition ${
                            selected
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700 opacity-70 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
                              : "border-[var(--border-default)] bg-[var(--bg-muted)] text-[var(--text-primary)] hover:border-brand-400"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-semibold">{extra.description}</span>
                            <span className="font-mono font-bold">{fmtMoney(extra.amount)}</span>
                          </div>
                          <div className="mt-1 text-[10px] text-[var(--text-muted)]">
                            Room {extra.room_number ?? "-"} · {extra.paid_date ?? "-"} {selected ? "· Added" : ""}
                          </div>
                          {!selected && (
                            <div className="mt-3 space-y-2">
                              <div className="grid grid-cols-2 gap-2">
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    addExtraAsSeparateLine(extra);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault();
                                      addExtraAsSeparateLine(extra);
                                    }
                                  }}
                                  className="rounded-md border border-brand-200 bg-white px-2 py-1.5 text-center font-bold text-brand-700 hover:bg-brand-50 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300"
                                >
                                  Add line
                                </span>
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    addExtraToRoomCharge(extra, "average");
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault();
                                      addExtraToRoomCharge(extra, "average");
                                    }
                                  }}
                                  className="rounded-md border border-emerald-200 bg-white px-2 py-1.5 text-center font-bold text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
                                >
                                  Avg room
                                </span>
                              </div>
                              <div className="flex gap-2">
                                <select
                                  className="min-w-0 flex-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[11px]"
                                  value={getSelectedExtraNight(extra)}
                                  onClick={(event) => event.stopPropagation()}
                                  onChange={(event) =>
                                    setSelectedExtraNightById((current) => ({
                                      ...current,
                                      [extra.id]: event.target.value,
                                    }))
                                  }
                                >
                                  {invoiceNightOptions.map((date) => (
                                    <option key={date} value={date}>
                                      {fmtDisplayDate(date)}
                                    </option>
                                  ))}
                                </select>
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    addExtraToRoomCharge(
                                      extra,
                                      "specific",
                                      getSelectedExtraNight(extra)
                                    );
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault();
                                      addExtraToRoomCharge(
                                        extra,
                                        "specific",
                                        getSelectedExtraNight(extra)
                                      );
                                    }
                                  }}
                                  className="shrink-0 rounded-md border border-amber-200 bg-white px-2 py-1.5 text-center font-bold text-amber-700 hover:bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
                                >
                                  This night
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            <table className="w-full text-left">
              <thead className="border-b border-[var(--border-default)]">
                <tr>
                  <th className="px-5 py-3 text-[10px] font-bold uppercase text-[var(--text-muted)]">
                    Description
                  </th>
                  <th className="px-5 py-3 text-[10px] font-bold uppercase text-[var(--text-muted)] text-center">
                    Qty
                  </th>
                  <th className="px-5 py-3 text-[10px] font-bold uppercase text-[var(--text-muted)] text-right">
                    Rate
                  </th>
                  <th className="px-5 py-3 text-[10px] font-bold uppercase text-[var(--text-muted)] text-right">
                    Discount
                  </th>
                  <th className="px-5 py-3 text-[10px] font-bold uppercase text-[var(--text-muted)] text-right">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)] text-base">
                {sortedDisplayItems.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-5 py-10 text-center text-[var(--text-muted)] text-sm"
                    >
                      ไม่มีรายการในช่วงวันที่เลือก
                    </td>
                  </tr>
                ) : (
                  sortedDisplayItems.map(({ item, sourceIndex }) => (
                    <tr
                      key={`${sourceIndex}-${item.kind}-${item.stay_dates?.join("_") ?? item.description}`}
                      className="hover:bg-[var(--bg-muted)]/50"
                    >
                      <td className="px-5 py-4">
                        <div className="flex items-start gap-2">
                          <input
                            className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-0 py-1 font-semibold text-[var(--text-primary)] outline-none transition hover:border-[var(--border-subtle)] hover:bg-[var(--bg-surface)] focus:border-brand-400 focus:bg-[var(--bg-surface)] focus:px-2"
                            value={item.description}
                            readOnly={sourceIndex < 0}
                            onChange={(event) => updateLineItemDescription(sourceIndex, event.target.value)}
                            aria-label="Line item description"
                          />
                          {item.kind === "extra_charge" && sourceIndex >= 0 && (
                            <button
                              type="button"
                              className="rounded-md px-2 py-1 text-[10px] font-bold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10"
                              onClick={() => removeLineItem(sourceIndex)}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                        {item.description !== formatTaxInvoiceItemDescription(item, language) && (
                          <p className="text-[11px] text-[var(--text-muted)]">
                            Print: {formatTaxInvoiceItemDescription(item, language)}
                          </p>
                        )}
                        {item.note && (
                          <p className="text-[13px] text-[var(--text-muted)]">
                            {item.note}
                          </p>
                        )}
                        {item.room_number && (
                          <span className="text-xs bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400 px-1.5 py-0.5 rounded border border-sky-100 dark:border-sky-500/20 font-bold uppercase mt-1 inline-block">
                            Room {item.room_number}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-4 text-center text-[var(--text-secondary)] text-base">
                        {item.quantity} {formatTaxInvoiceItemUnit(item, language)}
                      </td>
                      <td className="px-5 py-4 text-right text-[var(--text-secondary)] font-mono">
                        {fmtMoney(item.unit_price)}
                      </td>
                      <td className="px-5 py-4 text-right text-[var(--text-secondary)] font-mono">
                        {fmtMoney(itemDiscountAmount(item))}
                      </td>
                      <td className="px-5 py-4 text-right font-bold text-[var(--text-primary)] font-mono">
                        {fmtMoney(item.amount)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            <div className="bg-white dark:bg-[var(--bg-surface)] p-6 flex justify-end border-t border-[var(--border-default)]">
              <div className="w-64 space-y-3">
                {excludedNights > 0 && (
                  <p className="text-xs text-amber-600 font-bold text-right mb-1">
                    คำนวณจาก {selectedNights} คืน (ตัด {excludedNights} คืน)
                  </p>
                )}
                <div className="flex justify-between text-sm text-[var(--text-secondary)]">
                  <span>{l.subtotal}</span>
                  <span className="font-mono">{fmtMoney(totals.subtotal)}</span>
                </div>
                {totals.discount > 0 && (
                  <div className="flex justify-between text-sm text-emerald-700 dark:text-emerald-300">
                    <span>{l.discount}</span>
                    <span className="font-mono">-{fmtMoney(totals.discount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm text-[var(--text-secondary)]">
                  <span>{l.vat}</span>
                  <span className="font-mono">{fmtMoney(totals.vat_amount)}</span>
                </div>
                <div className="pt-3 border-t border-[var(--border-default)] flex justify-between text-lg font-extrabold text-[var(--text-primary)]">
                  <span>{l.total}</span>
                  <span className="font-mono text-brand-600">
                    {fmtMoney(splitCoveragePreview ?? totals.grand_total)}
                  </span>
                </div>
                {invoiceKind === "prepayment" && (
                  <p className="text-[10px] text-right text-[var(--text-muted)]">
                    Full discounted stay total: {fmtMoney(totals.grand_total)}
                  </p>
                )}
                {invoiceKind === "balance" && (
                  <p className="text-[10px] text-right text-[var(--text-muted)]">
                    Balance total is calculated from active prepayment coverage.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Confirmation modal ── */}
      {showConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="bg-[var(--bg-surface)] w-full max-w-md rounded-2xl shadow-2xl border border-[var(--border-default)] overflow-hidden animate-in zoom-in duration-200">
            <div className="bg-amber-50 dark:bg-amber-500/10 p-6 flex items-center gap-4 border-b border-amber-100 dark:border-amber-500/20">
              <div className="w-12 h-12 rounded-full bg-amber-50 dark:bg-amber-500/20 flex items-center justify-center text-2xl">
                ⚠️
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-bold text-amber-900 dark:text-amber-400">
                  {mode === "issue" ? "Issue Tax Invoice" : "Update Tax Invoice"}
                </h3>
                <p className="text-xs text-amber-700/80 dark:text-amber-500/60 mt-0.5">
                  Please review carefully before proceeding.
                </p>
              </div>
            </div>

            <div className="p-6 space-y-5">
              {mode === "issue" ? (
                <div className="space-y-2">
                  <p className="text-sm font-bold text-[var(--text-primary)]">
                    Sequential Compliance Warning
                  </p>
                  <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                    The system will generate a permanent{" "}
                    <strong>Invoice Number</strong> based on the current
                    sequence. Once issued:
                  </p>
                  {excludedNights > 0 && (
                    <p className="text-xs text-amber-700 dark:text-amber-400 font-bold">
                      Invoice period: {fmtDisplayDate(editFrom)} → {fmtDisplayDate(editTo)} ({selectedNights} คืน)
                    </p>
                  )}
                  <ul className="text-[10px] space-y-1 text-rose-600 dark:text-rose-400 font-bold list-disc pl-4">
                    <li>It CANNOT be deleted or skipped.</li>
                    <li>The sequence must be strictly continuous.</li>
                    <li>Mistakes must be handled via Credit Note or Void.</li>
                  </ul>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm font-bold text-[var(--text-primary)]">
                    ยืนยันการแก้ไข
                  </p>
                  <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                    ออกใบสำหรับ{" "}
                    <strong>
                      {fmtDisplayDate(editFrom)} → {fmtDisplayDate(editTo)}
                    </strong>{" "}
                    ({selectedNights} คืน)
                    {excludedNights > 0 && (
                      <span className="text-amber-600 font-bold">
                        {" "}
                        · ตัดออก {excludedNights} คืน
                      </span>
                    )}
                  </p>
                  {updateReason.trim() && (
                    <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-100 dark:border-amber-500/20 rounded-lg p-3">
                      <p className="text-[12.65px] text-amber-700 dark:text-amber-400 font-bold uppercase">
                        เหตุผล
                      </p>
                      <p className="text-[15.18px] text-amber-800 dark:text-amber-300 mt-0.5">
                        {updateReason.trim()}
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div className="bg-[var(--bg-muted)] rounded-2xl p-5 space-y-3 border border-[var(--border-subtle)] shadow-inner">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[var(--text-muted)] font-medium">
                    Recipient:
                  </span>
                  <span className="font-bold text-[var(--text-primary)]">
                    {customerName}
                  </span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[var(--text-muted)] font-medium">
                    Tax ID / Branch:
                  </span>
                  <span className="font-bold text-[var(--text-primary)]">
                    {customerTaxId} (
                    {customerBranch === "00000" ? "HQ" : customerBranch})
                  </span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[var(--text-muted)] font-medium">
                    Target Rooms:
                  </span>
                  <span className="font-bold text-brand-600">
                    {booking?.room_numbers.join(", ") || "-"}
                  </span>
                </div>
                {remark.trim() && (
                  <div className="text-xs">
                    <span className="block text-[var(--text-muted)] font-medium">
                      Remark:
                    </span>
                    <span className="mt-1 block whitespace-pre-wrap font-semibold text-[var(--text-primary)]">
                      {remark.trim()}
                    </span>
                  </div>
                )}
                <div className="pt-3 border-t border-[var(--border-subtle)] flex justify-between items-baseline">
                  <span className="font-black text-[var(--text-primary)] text-sm">
                    Grand Total (Inc. VAT):
                  </span>
                  <div className="text-right">
                    <span className="block text-xl font-black text-brand-600 font-mono tracking-tighter">
                      ฿{fmtMoney(splitCoveragePreview ?? totals.grand_total)}
                    </span>
                    <span className="block text-[10.35px] text-[var(--text-muted)] uppercase tracking-widest font-bold">
                      (ราคาที่แสดง รวม VAT 7% แล้ว)
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[var(--bg-muted)] p-4 flex gap-3 justify-end border-t border-[var(--border-default)]">
              <button
                onClick={() => setShowConfirm(false)}
                disabled={loading}
                className="px-6 py-2 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] text-sm font-bold text-[var(--text-secondary)] hover:bg-[var(--bg-body)] transition"
              >
                Cancel
              </button>
              <button
                onClick={handleIssue}
                disabled={loading}
                className="px-8 py-2 rounded-xl bg-brand-600 text-white text-sm font-extrabold shadow-lg hover:bg-brand-700 transition flex items-center gap-2"
              >
                {loading && (
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                )}
                {mode === "issue" ? "Issue Now" : "Update Now"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
