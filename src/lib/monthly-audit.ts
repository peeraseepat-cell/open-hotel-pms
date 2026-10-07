import { toBangkokDateString } from "@/lib/audit-utils";
import { fetchAllRowsComplete } from "@/lib/complete-fetch";
import { compareIssuedInvoiceNewestFirst } from "@/lib/issued-invoice-order";
import { extractReservationIdsFromBookingSnapshot } from "@/lib/tax-invoice/service";

type SupabaseLike = {
  from: (table: string) => any;
  rpc?: (fn: string, args?: Record<string, unknown>) => any;
};

export class MonthlyAuditError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "MonthlyAuditError";
    this.status = status;
  }
}

// ============================================================
// Types
// ============================================================

export type MonthlyAuditStatus = "open" | "reviewing" | "audited" | "locked";

export interface MonthlyAuditPeriod {
  id: string;
  year: number;
  month: number;
  status: MonthlyAuditStatus;
  closed_at: string | null;
  closed_by: string | null;
  audited_at: string | null;
  audited_by: string | null;
  summary_json: MonthlyAuditSummary | null;
  note: string | null;
  created_at: string;
}

export interface MonthlyAuditEntry {
  id: string;
  period_id: string;
  reservation_id: string;
  booking_code: string | null;
  guest_name: string;
  source: string;
  checkin_date: string;
  checkout_date: string;
  room_number: string | null;
  room_type_name: string | null;
  total_nights: number;
  room_revenue: number;
  extra_revenue: number;
  pos_revenue: number;
  total_revenue: number;
  paid_cash: number;
  paid_transfer: number;
  paid_credit_card: number;
  paid_other: number;
  total_paid: number;
  refund_total: number;
  outstanding: number;
  tax_invoice_requested: boolean;
  tax_invoice_name: string | null;
  tax_id: string | null;
  nationality: string | null;
  passport_number: string | null;
  id_card_number: string | null;
  guest_count: number;
  full_tax_invoice?: MonthlyAuditFullTaxInvoiceInfo | null;
  channel_flag?: MonthlyAuditEntryChannelFlag | null;
  corrections?: MonthlyAuditCorrection[];
}

export interface MonthlyAuditFullTaxInvoiceInfo {
  id: string;
  invoice_no: string | null;
  issue_date: string | null;
  grand_total: number;
  covered_amount: number;
  covered_room_revenue: number;
  covered_extra_revenue: number;
  residual_amount: number;
  residual_room_revenue: number;
  residual_extra_revenue: number;
  full_tax_paid_cash: number;
  full_tax_paid_transfer: number;
  full_tax_paid_credit_card: number;
  full_tax_paid_other: number;
  full_tax_total_paid: number;
  residual_paid_cash: number;
  residual_paid_transfer: number;
  residual_paid_credit_card: number;
  residual_paid_other: number;
  residual_total_paid: number;
  covered_room_revenue_by_stay_date?: Record<string, number>;
}

export interface MonthlyAuditEntryChannelFlag {
  actual_channel: string;
  tax_invoice_channel: string;
  display_label: string;
  reason: string | null;
  flagged_by_user_id: string | null;
  flagged_at: string | null;
}

export interface MonthlyAuditCorrection {
  id: string;
  entry_id: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  corrected_by: string | null;
  corrected_at: string;
}

export interface MonthlyAuditSummary {
  total_reservations: number;
  by_source: Record<string, SourceSummary>;
  totals: SourceSummary;
  pos_sales: MonthlyAuditPosSalesSummary;
}

export interface MonthlyAuditSplitResult<T extends MonthlyAuditEntry = MonthlyAuditEntry> {
  normalEntries: T[];
  fullTaxInvoiceEntries: T[];
  summary: MonthlyAuditSummary;
  fullTaxInvoiceSummary: MonthlyAuditSummary;
  grandSummary: MonthlyAuditSummary;
}

export interface SourceSummary {
  count: number;
  room_revenue: number;
  extra_revenue: number;
  pos_revenue: number;
  total_revenue: number;
  paid_cash: number;
  paid_transfer: number;
  paid_credit_card: number;
  paid_other: number;
  total_paid: number;
  refund_total: number;
  outstanding: number;
  tax_invoice_count: number;
}

export interface MonthlyAuditPosSalesItem {
  product_id: string | null;
  product_name: string;
  quantity: number;
  walkin_quantity: number;
  walkin_total: number;
  guest_charge_quantity: number;
  guest_charge_total: number;
  total_sales: number;
  order_count: number;
}

export interface MonthlyAuditPosSalesSummary {
  item_count: number;
  order_count: number;
  total_quantity: number;
  walkin_total: number;
  guest_charge_total: number;
  total_sales: number;
  items: MonthlyAuditPosSalesItem[];
}

export interface MonthlyAuditPreviewResult {
  year: number;
  month: number;
  entries: MonthlyAuditEntry[];
  summary: MonthlyAuditSummary;
  available_sources: string[];
  generated_at: string;
}

// Correctable fields in monthly_audit_entries
export const CORRECTABLE_FIELDS = [
  "guest_name",
  "source",
  "room_number",
  "room_type_name",
  "total_nights",
  "room_revenue",
  "extra_revenue",
  "pos_revenue",
  "total_revenue",
  "paid_cash",
  "paid_transfer",
  "paid_credit_card",
  "paid_other",
  "total_paid",
  "refund_total",
  "outstanding",
  "tax_invoice_requested",
  "tax_invoice_name",
  "tax_id",
  "nationality",
  "passport_number",
  "id_card_number",
  "guest_count",
] as const;

export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

// Numeric fields (need parseFloat for comparison)
const NUMERIC_FIELDS = new Set<string>([
  "total_nights",
  "room_revenue",
  "extra_revenue",
  "pos_revenue",
  "total_revenue",
  "paid_cash",
  "paid_transfer",
  "paid_credit_card",
  "paid_other",
  "total_paid",
  "refund_total",
  "outstanding",
  "guest_count",
]);

// ============================================================
// Helpers
// ============================================================

function monthDateRange(year: number, month: number): { from: string; to: string } {
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function str(value: unknown): string {
  return String(value ?? "").trim();
}

type MonthlyFolioAgg = {
  room_revenue: number;
  extra_revenue: number;
  pos_revenue: number;
  paid_cash: number;
  paid_transfer: number;
  paid_credit_card: number;
  paid_other: number;
  refund_total: number;
};

function emptyFolioAgg(): MonthlyFolioAgg {
  return {
    room_revenue: 0,
    extra_revenue: 0,
    pos_revenue: 0,
    paid_cash: 0,
    paid_transfer: 0,
    paid_credit_card: 0,
    paid_other: 0,
    refund_total: 0,
  };
}

function applyRevenueByCategory(agg: MonthlyFolioAgg, category: string, amount: number): void {
  if (category === "room_revenue" || category === "dayuse_revenue") agg.room_revenue += amount;
  else if (category === "extra_charge" || category === "no_show_fee") agg.extra_revenue += amount;
  else if (category === "pos_revenue") agg.pos_revenue += amount;
}

function applyFolioPaymentRow(agg: MonthlyFolioAgg, row: Record<string, unknown>): void {
  const amount = num(row.amount);
  const txType = str(row.tx_type).toLowerCase();
  const category = str(row.revenue_category).toLowerCase();
  const method = str(row.method).toLowerCase();

  if (txType === "refund") {
    if (category === "deposit") return;
    agg.refund_total += amount;
    applyRevenueByCategory(agg, category, -amount);
    return;
  }

  if (txType !== "payment") return;

  // This table stores both revenue category and payment method on payment rows.
  // Refund rows reverse both the collected money and the revenue category above,
  // so void/replacement payment flows settle back to zero outstanding.
  applyRevenueByCategory(agg, category, amount);

  // Payment method breakdown (only for non-deposit)
  if (category !== "deposit") {
    if (method === "cash") agg.paid_cash += amount;
    else if (method === "transfer") agg.paid_transfer += amount;
    else if (method === "credit_card") agg.paid_credit_card += amount;
    else agg.paid_other += amount;
  }
}

function emptySourceSummary(): SourceSummary {
  return {
    count: 0,
    room_revenue: 0,
    extra_revenue: 0,
    pos_revenue: 0,
    total_revenue: 0,
    paid_cash: 0,
    paid_transfer: 0,
    paid_credit_card: 0,
    paid_other: 0,
    total_paid: 0,
    refund_total: 0,
    outstanding: 0,
    tax_invoice_count: 0,
  };
}

function addToSummary(summary: SourceSummary, entry: MonthlyAuditEntry): void {
  summary.count += 1;
  summary.room_revenue += entry.room_revenue;
  summary.extra_revenue += entry.extra_revenue;
  summary.pos_revenue += entry.pos_revenue;
  summary.total_revenue += entry.total_revenue;
  summary.paid_cash += entry.paid_cash;
  summary.paid_transfer += entry.paid_transfer;
  summary.paid_credit_card += entry.paid_credit_card;
  summary.paid_other += entry.paid_other;
  summary.total_paid += entry.total_paid;
  summary.refund_total += entry.refund_total;
  summary.outstanding += entry.outstanding;
  if (entry.tax_invoice_requested || entry.full_tax_invoice) summary.tax_invoice_count += 1;
}

export function getMonthlyAuditTaxChannel(entry: Pick<MonthlyAuditEntry, "source" | "channel_flag">): string {
  return str(entry.channel_flag?.tax_invoice_channel || entry.source || "unknown").toLowerCase();
}

function addSourceSummary(target: SourceSummary, source: SourceSummary): void {
  target.count += source.count;
  target.room_revenue += source.room_revenue;
  target.extra_revenue += source.extra_revenue;
  target.pos_revenue += source.pos_revenue;
  target.total_revenue += source.total_revenue;
  target.paid_cash += source.paid_cash;
  target.paid_transfer += source.paid_transfer;
  target.paid_credit_card += source.paid_credit_card;
  target.paid_other += source.paid_other;
  target.total_paid += source.total_paid;
  target.refund_total += source.refund_total;
  target.outstanding += source.outstanding;
  target.tax_invoice_count += source.tax_invoice_count;
}

function emptyPosSalesSummary(): MonthlyAuditPosSalesSummary {
  return {
    item_count: 0,
    order_count: 0,
    total_quantity: 0,
    walkin_total: 0,
    guest_charge_total: 0,
    total_sales: 0,
    items: [],
  };
}

export function computeSummary(
  entries: MonthlyAuditEntry[],
  posSales: MonthlyAuditPosSalesSummary = emptyPosSalesSummary()
): MonthlyAuditSummary {
  const bySource: Record<string, SourceSummary> = {};
  const totals = emptySourceSummary();

  for (const entry of entries) {
    const src = getMonthlyAuditTaxChannel(entry);
    if (!bySource[src]) bySource[src] = emptySourceSummary();
    addToSummary(bySource[src], entry);
    addToSummary(totals, entry);
  }

  return {
    total_reservations: entries.length,
    by_source: bySource,
    totals,
    pos_sales: posSales,
  };
}

export function combineMonthlyAuditSummaries(
  left: MonthlyAuditSummary,
  right: MonthlyAuditSummary
): MonthlyAuditSummary {
  const bySource: Record<string, SourceSummary> = {};
  for (const [source, row] of Object.entries(left.by_source)) {
    bySource[source] = { ...row };
  }
  for (const [source, row] of Object.entries(right.by_source)) {
    if (!bySource[source]) bySource[source] = emptySourceSummary();
    addSourceSummary(bySource[source], row);
  }

  const totals = emptySourceSummary();
  addSourceSummary(totals, left.totals);
  addSourceSummary(totals, right.totals);

  return {
    total_reservations: left.total_reservations + right.total_reservations,
    by_source: bySource,
    totals,
    pos_sales: left.pos_sales,
  };
}

// `compareIssuedInvoiceNewestFirst` restores `issue_date DESC, id ASC` after a
// keyset fetch — the pager orders by its cursor column (`id`) because keyset paging
// requires the cursor to be the primary sort, so any consumer that depended on the
// old SQL ordering has to re-apply it here. Both callers below do depend on it, in
// ways that change reported money rather than just presentation.
//
// It lives in ./issued-invoice-order.ts rather than here so the ORDER can be tested
// against fixtures. While it was a private function, the only available assertion
// was that a sort was called: a review flipped its direction and made it
// inert, and the full suite stayed green both times.

export async function loadIssuedFullTaxInvoiceMap(
  supabase: SupabaseLike,
  reservationIds: string[]
): Promise<Map<string, MonthlyAuditFullTaxInvoiceInfo>> {
  const ids = Array.from(new Set(reservationIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  const map = new Map<string, MonthlyAuditFullTaxInvoiceInfo>();
  if (ids.length === 0) return map;

  let rows: any[];
  try {
    rows = await fetchAllRowsComplete<any>(
      () =>
        supabase
          .from("invoices")
          .select("id, reservation_id, invoice_no, issue_date, grand_total, status, booking_snapshot", {
            count: "exact",
          })
          .eq("status", "issued"),
      { label: "issued full tax invoices" }
    );
  } catch (error) {
    throw new MonthlyAuditError(
      `Failed to load full tax invoices: ${error instanceof Error ? error.message : String(error)}`,
      500
    );
  }

  // LOAD-BEARING, not cosmetic. The loop below is first-write-wins
  // (`map.has(reservationId)` → skip), so when a reservation carries more than one
  // issued invoice, whichever row arrives FIRST supplies the grand_total reported
  // as covering it. Leaving the rows in keyset (id) order would hand the
  // reservation to a different invoice and change audited money.
  rows.sort(compareIssuedInvoiceNewestFirst);

  for (const row of rows) {
    const invoiceReservationIds = extractReservationIdsFromBookingSnapshot(
      row.booking_snapshot,
      row.reservation_id
    );

    for (const reservationId of invoiceReservationIds) {
      if (!ids.includes(reservationId) || map.has(reservationId)) continue;
      map.set(reservationId, {
        id: String(row.id),
        invoice_no: row.invoice_no ?? null,
        issue_date: row.issue_date ?? null,
        grand_total: num(row.grand_total),
        covered_amount: num(row.grand_total),
        covered_room_revenue: num(row.grand_total),
        covered_extra_revenue: 0,
        residual_amount: 0,
        residual_room_revenue: 0,
        residual_extra_revenue: 0,
        full_tax_paid_cash: 0,
        full_tax_paid_transfer: 0,
        full_tax_paid_credit_card: 0,
        full_tax_paid_other: 0,
        full_tax_total_paid: 0,
        residual_paid_cash: 0,
        residual_paid_transfer: 0,
        residual_paid_credit_card: 0,
        residual_paid_other: 0,
        residual_total_paid: 0,
      });
    }
  }

  return map;
}

function scaleAmount(value: number, ratio: number): number {
  return num(value * ratio);
}

function validStayDates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => str(item))
        .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item))
    )
  ).sort();
}

function addCoveredRoomRevenueByStayDate(
  map: Map<string, Map<string, number>>,
  reservationId: string,
  stayDates: unknown,
  amount: number
): void {
  const dates = validStayDates(stayDates);
  const total = Math.max(0, num(amount));
  if (!reservationId || dates.length === 0 || total <= 0) return;

  const byDate = map.get(reservationId) ?? new Map<string, number>();
  const base = num(total / dates.length);
  let allocated = 0;
  dates.forEach((stayDate, index) => {
    const share = index === dates.length - 1 ? num(total - allocated) : base;
    allocated = num(allocated + share);
    byDate.set(stayDate, num((byDate.get(stayDate) ?? 0) + share));
  });
  map.set(reservationId, byDate);
}

function scaleCoveredRoomRevenueByStayDate(
  map: Map<string, Map<string, number>>,
  ratio: number
): void {
  for (const [reservationId, byDate] of map.entries()) {
    const scaled = new Map<string, number>();
    for (const [stayDate, amount] of byDate.entries()) {
      const nextAmount = scaleAmount(amount, ratio);
      if (nextAmount > 0) scaled.set(stayDate, nextAmount);
    }
    map.set(reservationId, scaled);
  }
}

function mergeCoveredRoomRevenueByStayDate(
  previous: Record<string, number> | undefined,
  current: Map<string, number> | undefined
): Record<string, number> {
  const merged = new Map<string, number>();
  for (const [stayDate, amount] of Object.entries(previous ?? {})) {
    const normalized = num(amount);
    if (normalized > 0) merged.set(stayDate, normalized);
  }
  for (const [stayDate, amount] of current?.entries() ?? []) {
    const normalized = num(amount);
    if (normalized > 0) merged.set(stayDate, num((merged.get(stayDate) ?? 0) + normalized));
  }
  return Object.fromEntries([...merged.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export async function loadIssuedFullTaxCoverageMap<T extends MonthlyAuditEntry>(
  supabase: SupabaseLike,
  entries: T[]
): Promise<Map<string, MonthlyAuditFullTaxInvoiceInfo>> {
  const reservationIds = Array.from(new Set(entries.map((entry) => entry.reservation_id).filter(Boolean)));
  const entryByReservationId = new Map(entries.map((entry) => [entry.reservation_id, entry]));
  const map = new Map<string, MonthlyAuditFullTaxInvoiceInfo>();
  if (reservationIds.length === 0) return map;

  let rows: any[];
  try {
    rows = await fetchAllRowsComplete<any>(
      () =>
        supabase
          .from("invoices")
          .select(
            "id, reservation_id, invoice_no, issue_date, grand_total, status, line_items, booking_snapshot",
            { count: "exact" }
          )
          .eq("status", "issued"),
      { label: "issued full tax invoice coverage" }
    );
  } catch (error) {
    throw new MonthlyAuditError(
      `Failed to load full tax invoice coverage: ${error instanceof Error ? error.message : String(error)}`,
      500
    );
  }

  // LOAD-BEARING for a different reason than loadIssuedFullTaxInvoiceMap: this
  // loop ACCUMULATES across rows rather than taking the first. `id` and
  // `invoice_no` are comma-joined in row order, and `issue_date` is
  // `previous?.issue_date ?? row.issue_date` — first row wins. So row order
  // decides both the reported invoice-number string and which issue_date is
  // shown. Keyset (id) order would reorder both.
  rows.sort(compareIssuedInvoiceNewestFirst);

  const wanted = new Set(reservationIds);
  for (const row of rows) {
    // NOT replaced with extractReservationIdsFromBookingSnapshot on purpose: this
    // order is load-bearing. The `metadataTotal <= 0` branch below distributes
    // invoiceTotal greedily across relatedEntries in array order, so the direct
    // reservation_id must stay FIRST. The shared parser returns snapshot ids
    // first, which would silently re-allocate money on group invoices.
    const directReservationId = str(row.reservation_id);
    const snapshotReservationIds = Array.isArray(row.booking_snapshot?.reservation_ids)
      ? row.booking_snapshot.reservation_ids.map((id: unknown) => str(id)).filter(Boolean)
      : [];
    const invoiceReservationIds = Array.from(new Set([directReservationId, ...snapshotReservationIds].filter(Boolean)))
      .filter((id) => wanted.has(id));
    if (invoiceReservationIds.length === 0) continue;

    const relatedEntries = invoiceReservationIds
      .map((id) => entryByReservationId.get(id))
      .filter((entry): entry is T => Boolean(entry));
    if (relatedEntries.length === 0) continue;

    const invoiceTotal = Math.max(0, num(row.grand_total));
    const allocated = new Map<string, { room: number; extra: number }>();
    const coveredByStayDate = new Map<string, Map<string, number>>();
    const lineItems = Array.isArray(row.line_items) ? row.line_items : [];

    for (const item of lineItems) {
      const mergedSources = Array.isArray((item as any)?.merged_line_sources)
        ? (item as any).merged_line_sources as any[]
        : [];
      if (mergedSources.length > 0) {
        for (const source of mergedSources) {
          const sourceReservationId = str(source?.reservation_id);
          if (!sourceReservationId || !wanted.has(sourceReservationId) || !entryByReservationId.has(sourceReservationId)) {
            continue;
          }
          const sourceAmount = Math.max(0, num(source?.amount));
          if (sourceAmount <= 0) continue;
          const current = allocated.get(sourceReservationId) ?? { room: 0, extra: 0 };
          current.room = num(current.room + sourceAmount);
          allocated.set(sourceReservationId, current);
          addCoveredRoomRevenueByStayDate(coveredByStayDate, sourceReservationId, (item as any)?.stay_dates, sourceAmount);
        }
        continue;
      }

      const itemReservationId = str((item as any)?.reservation_id);
      if (!itemReservationId || !wanted.has(itemReservationId) || !entryByReservationId.has(itemReservationId)) {
        continue;
      }
      const lineAmount = Math.max(0, num((item as any)?.amount));
      if (lineAmount <= 0) continue;

      const mergedExtra = Math.min(lineAmount, Math.max(0, num((item as any)?.merged_extra_charge_total)));
      const current = allocated.get(itemReservationId) ?? { room: 0, extra: 0 };
      const roomAmount = Math.max(0, lineAmount - mergedExtra);
      current.room = num(current.room + roomAmount);
      current.extra = num(current.extra + mergedExtra);
      allocated.set(itemReservationId, current);
      addCoveredRoomRevenueByStayDate(coveredByStayDate, itemReservationId, (item as any)?.stay_dates, roomAmount);
    }

    const metadataTotal = Array.from(allocated.values()).reduce(
      (sum, value) => num(sum + value.room + value.extra),
      0
    );

    if (metadataTotal > 0 && metadataTotal !== invoiceTotal) {
      const ratio = invoiceTotal > 0 ? invoiceTotal / metadataTotal : 0;
      for (const [reservationId, value] of allocated.entries()) {
        allocated.set(reservationId, {
          room: scaleAmount(value.room, ratio),
          extra: scaleAmount(value.extra, ratio),
        });
      }
      scaleCoveredRoomRevenueByStayDate(coveredByStayDate, ratio);
    }

    if (metadataTotal <= 0) {
      let remaining = invoiceTotal;
      for (const entry of relatedEntries) {
        const amount = Math.min(remaining, Math.max(0, num(entry.room_revenue)));
        allocated.set(entry.reservation_id, { room: amount, extra: 0 });
        remaining = num(remaining - amount);
      }

      if (remaining > 0) {
        for (const entry of relatedEntries) {
          if (remaining <= 0) break;
          const current = allocated.get(entry.reservation_id) ?? { room: 0, extra: 0 };
          const amount = Math.min(remaining, Math.max(0, num(entry.extra_revenue)));
          current.extra = amount;
          allocated.set(entry.reservation_id, current);
          remaining = num(remaining - amount);
        }
      }
    }

    for (const entry of relatedEntries) {
      const previous = map.get(entry.reservation_id) ?? null;
      const current = allocated.get(entry.reservation_id) ?? { room: 0, extra: 0 };
      const coveredRoom = Math.min(
        num(entry.room_revenue),
        num((previous?.covered_room_revenue ?? 0) + current.room)
      );
      const coveredExtra = Math.min(
        num(entry.extra_revenue),
        num((previous?.covered_extra_revenue ?? 0) + current.extra)
      );
      const covered = Math.min(num(entry.total_revenue), num(coveredRoom + coveredExtra));
      const residualRoom = Math.max(0, num(entry.room_revenue - coveredRoom));
      const residualExtra = Math.max(0, num(entry.extra_revenue - coveredExtra));
      const residual = Math.max(0, num(entry.total_revenue - covered));
      const ratio = entry.total_revenue > 0 ? Math.min(1, covered / entry.total_revenue) : 0;

      const fullTaxPaidCash = scaleAmount(entry.paid_cash, ratio);
      const fullTaxPaidTransfer = scaleAmount(entry.paid_transfer, ratio);
      const fullTaxPaidCreditCard = scaleAmount(entry.paid_credit_card, ratio);
      const fullTaxPaidOther = scaleAmount(entry.paid_other, ratio);
      const invoiceNo = [previous?.invoice_no, row.invoice_no ?? null]
        .filter((value, index, values) => value && values.indexOf(value) === index)
        .join(", ") || null;

      map.set(entry.reservation_id, {
        id: previous?.id ? `${previous.id},${String(row.id)}` : String(row.id),
        invoice_no: invoiceNo,
        issue_date: previous?.issue_date ?? row.issue_date ?? null,
        grand_total: covered,
        covered_amount: covered,
        covered_room_revenue: coveredRoom,
        covered_extra_revenue: coveredExtra,
        residual_amount: residual,
        residual_room_revenue: residualRoom,
        residual_extra_revenue: residualExtra,
        full_tax_paid_cash: fullTaxPaidCash,
        full_tax_paid_transfer: fullTaxPaidTransfer,
        full_tax_paid_credit_card: fullTaxPaidCreditCard,
        full_tax_paid_other: fullTaxPaidOther,
        full_tax_total_paid: num(fullTaxPaidCash + fullTaxPaidTransfer + fullTaxPaidCreditCard + fullTaxPaidOther),
        residual_paid_cash: num(entry.paid_cash - fullTaxPaidCash),
        residual_paid_transfer: num(entry.paid_transfer - fullTaxPaidTransfer),
        residual_paid_credit_card: num(entry.paid_credit_card - fullTaxPaidCreditCard),
        residual_paid_other: num(entry.paid_other - fullTaxPaidOther),
        residual_total_paid: num(entry.total_paid - (fullTaxPaidCash + fullTaxPaidTransfer + fullTaxPaidCreditCard + fullTaxPaidOther)),
        covered_room_revenue_by_stay_date: mergeCoveredRoomRevenueByStayDate(
          previous?.covered_room_revenue_by_stay_date,
          coveredByStayDate.get(entry.reservation_id)
        ),
      });
    }
  }

  return map;
}

export function attachFullTaxInvoiceInfo<T extends MonthlyAuditEntry>(
  entries: T[],
  issuedInvoiceMap: Map<string, MonthlyAuditFullTaxInvoiceInfo>
): T[] {
  return entries.map((entry) => ({
    ...entry,
    full_tax_invoice: issuedInvoiceMap.get(entry.reservation_id) ?? null,
  }));
}

export function splitMonthlyAuditEntries<T extends MonthlyAuditEntry>(
  entries: T[],
  posSales: MonthlyAuditPosSalesSummary = emptyPosSalesSummary()
): MonthlyAuditSplitResult<T> {
  const normalEntries = entries.flatMap((entry) => {
    if (!entry.full_tax_invoice) return [entry];
    if (entry.full_tax_invoice.residual_amount <= 0) return [];
    return [{
      ...entry,
      room_revenue: entry.full_tax_invoice.residual_room_revenue,
      extra_revenue: entry.full_tax_invoice.residual_extra_revenue,
      total_revenue: entry.full_tax_invoice.residual_amount,
      paid_cash: entry.full_tax_invoice.residual_paid_cash,
      paid_transfer: entry.full_tax_invoice.residual_paid_transfer,
      paid_credit_card: entry.full_tax_invoice.residual_paid_credit_card,
      paid_other: entry.full_tax_invoice.residual_paid_other,
      total_paid: entry.full_tax_invoice.residual_total_paid,
      outstanding: 0,
    } as T];
  });
  const fullTaxInvoiceEntries = entries
    .filter((entry) => Boolean(entry.full_tax_invoice))
    .map((entry) => ({
      ...entry,
      room_revenue: entry.full_tax_invoice?.covered_room_revenue ?? 0,
      extra_revenue: entry.full_tax_invoice?.covered_extra_revenue ?? 0,
      total_revenue: entry.full_tax_invoice?.covered_amount ?? 0,
      paid_cash: entry.full_tax_invoice?.full_tax_paid_cash ?? 0,
      paid_transfer: entry.full_tax_invoice?.full_tax_paid_transfer ?? 0,
      paid_credit_card: entry.full_tax_invoice?.full_tax_paid_credit_card ?? 0,
      paid_other: entry.full_tax_invoice?.full_tax_paid_other ?? 0,
      total_paid: entry.full_tax_invoice?.full_tax_total_paid ?? 0,
      outstanding: 0,
    } as T));
  const summary = computeSummary(normalEntries, posSales);
  const fullTaxInvoiceSummary = computeSummary(fullTaxInvoiceEntries, emptyPosSalesSummary());
  const grandSummary = combineMonthlyAuditSummaries(summary, fullTaxInvoiceSummary);
  return { normalEntries, fullTaxInvoiceEntries, summary, fullTaxInvoiceSummary, grandSummary };
}

export async function loadMonthlyPosSalesSummary(params: {
  supabase: SupabaseLike;
  year: number;
  month: number;
}): Promise<MonthlyAuditPosSalesSummary> {
  const { supabase, year, month } = params;
  const { from: dateFrom, to: dateTo } = monthDateRange(year, month);

  const rows: any[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from("pos_order_items")
      .select(
        "order_id, product_id, product_name, quantity, line_total, pos_orders!inner(id, order_date, order_type, status)"
      )
      .gte("pos_orders.order_date", dateFrom)
      .lte("pos_orders.order_date", dateTo)
      .eq("pos_orders.status", "completed")
      .range(offset, offset + pageSize - 1);

    if (error) {
      throw new MonthlyAuditError(`Failed to load POS sales summary: ${error.message}`, 500);
    }

    rows.push(...((data ?? []) as any[]));
    if (!data || data.length < pageSize) break;
  }

  const byProduct = new Map<string, MonthlyAuditPosSalesItem & { order_ids: Set<string> }>();
  const allOrderIds = new Set<string>();

  for (const row of rows) {
    const order = Array.isArray(row.pos_orders) ? row.pos_orders[0] : row.pos_orders;
    const orderId = str(row.order_id || order?.id);
    const orderType = str(order?.order_type).toLowerCase();
    const productId = row.product_id ? String(row.product_id) : null;
    const productName = str(row.product_name) || "Unknown item";
    const productKey = productId || productName.toLowerCase();
    const quantity = num(row.quantity);
    const lineTotal = num(row.line_total);

    if (!byProduct.has(productKey)) {
      byProduct.set(productKey, {
        product_id: productId,
        product_name: productName,
        quantity: 0,
        walkin_quantity: 0,
        walkin_total: 0,
        guest_charge_quantity: 0,
        guest_charge_total: 0,
        total_sales: 0,
        order_count: 0,
        order_ids: new Set<string>(),
      });
    }

    const item = byProduct.get(productKey)!;
    item.quantity += quantity;
    item.total_sales = num(item.total_sales + lineTotal);

    if (orderType === "guest_charge") {
      item.guest_charge_quantity += quantity;
      item.guest_charge_total = num(item.guest_charge_total + lineTotal);
    } else {
      item.walkin_quantity += quantity;
      item.walkin_total = num(item.walkin_total + lineTotal);
    }

    if (orderId) {
      item.order_ids.add(orderId);
      allOrderIds.add(orderId);
    }
  }

  const items = Array.from(byProduct.values())
    .map(({ order_ids, ...item }) => ({
      ...item,
      quantity: num(item.quantity),
      walkin_quantity: num(item.walkin_quantity),
      guest_charge_quantity: num(item.guest_charge_quantity),
      order_count: order_ids.size,
    }))
    .sort((a, b) => {
      if (b.total_sales !== a.total_sales) return b.total_sales - a.total_sales;
      return a.product_name.localeCompare(b.product_name);
    });

  return {
    item_count: items.length,
    order_count: allOrderIds.size,
    total_quantity: num(items.reduce((sum, item) => sum + item.quantity, 0)),
    walkin_total: num(items.reduce((sum, item) => sum + item.walkin_total, 0)),
    guest_charge_total: num(items.reduce((sum, item) => sum + item.guest_charge_total, 0)),
    total_sales: num(items.reduce((sum, item) => sum + item.total_sales, 0)),
    items,
  };
}

// ============================================================
// Close Month — Generate Snapshot
// ============================================================

export async function closeMonth(params: {
  supabase: SupabaseLike;
  year: number;
  month: number;
  closedByUserId: string | null;
  filterDayuse?: "only" | "exclude";
}): Promise<{ period: MonthlyAuditPeriod; entries: MonthlyAuditEntry[]; summary: MonthlyAuditSummary }> {
  const { supabase, year, month, closedByUserId, filterDayuse } = params;

  // 1. Check existing period state
  const { data: existing, error: existingError } = await supabase
    .from("monthly_audit_periods")
    .select("id, status")
    .eq("year", year)
    .eq("month", month)
    .maybeSingle();

  if (existingError) {
    throw new MonthlyAuditError(existingError.message, 500);
  }
  if (existing) {
    // Allow re-snapshot from open/reviewing for operational retest.
    // Keep audited/locked protected.
    if (existing.status === "locked") {
      throw new MonthlyAuditError(
        `Month ${year}-${String(month).padStart(2, "0")} is locked and cannot be regenerated.`,
        409
      );
    }
    if (existing.status === "audited") {
      throw new MonthlyAuditError(
        `Month ${year}-${String(month).padStart(2, "0")} is audited. Reopen it first before regenerating snapshot.`,
        409
      );
    }

    const { data: activeAbbreviatedInvoices, error: activeAbbreviatedError } = await supabase
      .from("abbreviated_tax_invoice")
      .select("id, invoice_no, source_type, status")
      .eq("audit_period_id", existing.id)
      .in("source_type", ["room", "dayuse"])
      .neq("status", "cancelled")
      .limit(1);

    if (activeAbbreviatedError) {
      throw new MonthlyAuditError(
        `Failed to verify abbreviated tax invoices before re-snapshot: ${activeAbbreviatedError.message}`,
        500
      );
    }
    if ((activeAbbreviatedInvoices ?? []).length > 0) {
      const invoiceNo = str((activeAbbreviatedInvoices as any[])[0]?.invoice_no) || "existing abbreviated tax invoice";
      const sourceType = str((activeAbbreviatedInvoices as any[])[0]?.source_type) || "room";
      throw new MonthlyAuditError(
        `Cannot re-generate snapshot because ${invoiceNo} (${sourceType}) is already active. Cancel or resolve abbreviated tax invoices first.`,
        409
      );
    }

    // Re-snapshot returns to operational source truth. Deleting entries cascades
    // corrections, channel flags, and pre-generate abbreviated invoice overrides.
    await supabase.from("rr3_row_overrides").delete().eq("period_id", existing.id);
    await supabase.from("monthly_audit_entries").delete().eq("period_id", existing.id);
  }

  const { from: dateFrom, to: dateTo } = monthDateRange(year, month);
  const posSales = await loadMonthlyPosSalesSummary({ supabase, year, month });

  // 2. Load checked-out reservations in this month
  const { data: reservations, error: resError } = await supabase
    .from("reservations")
    .select(
      "id, booking_code, guest_name, source, checkin_date, checkout_date, total_price, tax_invoice_requested, guest_profile_id, is_dayuse"
    )
    .eq("status", "checked_out")
    .gte("checkout_date", dateFrom)
    .lte("checkout_date", dateTo)
    .order("checkout_date", { ascending: true });

  if (resError) {
    throw new MonthlyAuditError(`Failed to load reservations: ${resError.message}`, 500);
  }

  const reservationRows = ((reservations ?? []) as any[]).filter((row) => {
    if (filterDayuse === "only") return Boolean(row.is_dayuse);
    if (filterDayuse === "exclude") return !Boolean(row.is_dayuse);
    return true;
  });
  if (reservationRows.length === 0) {
    throw new MonthlyAuditError(
      `No checked-out reservations found for ${year}-${String(month).padStart(2, "0")}.`,
      404
    );
  }

  const reservationIds = reservationRows.map((r: any) => String(r.id));

  // 3. Load folio payments for all reservations (batched)
  const { data: folioRows, error: folioError } = await supabase
    .from("folio_payments")
    .select("reservation_id, tx_type, method, amount, revenue_category, is_record_only")
    .in("reservation_id", reservationIds)
    .eq("is_record_only", false);

  if (folioError) {
    throw new MonthlyAuditError(`Failed to load folio data: ${folioError.message}`, 500);
  }

  // 4. Load room assignments (latest night per reservation for room number)
  const { data: nightRows, error: nightError } = await supabase
    .from("reservation_nights")
    .select("reservation_id, room_id, rooms(room_number, room_type_id, room_types(name_en))")
    .in("reservation_id", reservationIds)
    .is("cancelled_at", null)
    .order("stay_date", { ascending: false });

  if (nightError) {
    throw new MonthlyAuditError(`Failed to load room assignments: ${nightError.message}`, 500);
  }

  // 5. Load guest profiles for identity data
  const guestProfileIds = reservationRows
    .map((r: any) => r.guest_profile_id)
    .filter(Boolean);

  let guestProfileMap = new Map<string, any>();
  if (guestProfileIds.length > 0) {
    const { data: profiles } = await supabase
      .from("guest_profiles")
      .select("id, nationality, passport_number, id_card_number")
      .in("id", guestProfileIds);

    if (profiles) {
      guestProfileMap = new Map(
        (profiles as any[]).map((p: any) => [String(p.id), p])
      );
    }
  }

  // 6. Build lookup maps
  // Folio: group by reservation_id
  const folioMap = new Map<string, MonthlyFolioAgg>();
  for (const row of (folioRows ?? []) as any[]) {
    const resId = String(row.reservation_id);
    if (!folioMap.has(resId)) {
      folioMap.set(resId, emptyFolioAgg());
    }
    const agg = folioMap.get(resId)!;
    applyFolioPaymentRow(agg, row);
  }

  // Room: first occurrence per reservation (sorted desc by stay_date, so first = latest)
  const roomMap = new Map<string, { room_number: string; room_type_name: string }>();
  for (const row of (nightRows ?? []) as any[]) {
    const resId = String(row.reservation_id);
    if (roomMap.has(resId)) continue; // already have latest
    const roomObj = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
    const typeObj = roomObj?.room_types
      ? (Array.isArray(roomObj.room_types) ? roomObj.room_types[0] : roomObj.room_types)
      : null;
    roomMap.set(resId, {
      room_number: str(roomObj?.room_number),
      room_type_name: str(typeObj?.name_en),
    });
  }

  // Night count per reservation
  const nightCountMap = new Map<string, number>();
  for (const row of (nightRows ?? []) as any[]) {
    const resId = String(row.reservation_id);
    nightCountMap.set(resId, (nightCountMap.get(resId) ?? 0) + 1);
  }

  // 7. Create or refresh period
  const now = new Date().toISOString();
  const periodMutation = existing
    ? supabase
        .from("monthly_audit_periods")
        .update({
          status: "reviewing",
          closed_at: now,
          closed_by: closedByUserId,
          audited_at: null,
          audited_by: null,
          summary_json: null,
          updated_at: now,
        })
        .eq("id", existing.id)
    : supabase
        .from("monthly_audit_periods")
        .insert({
          year,
          month,
          status: "reviewing",
          closed_at: now,
          closed_by: closedByUserId,
        });

  const { data: period, error: periodError } = await periodMutation
    .select("*")
    .single();

  if (periodError) {
    throw new MonthlyAuditError(`Failed to create audit period: ${periodError.message}`, 500);
  }

  // 8. Build entries
  const entries: MonthlyAuditEntry[] = [];
  const insertRows: any[] = [];

  for (const res of reservationRows) {
    const resId = String(res.id);
    const folio = folioMap.get(resId) ?? emptyFolioAgg();
    const room = roomMap.get(resId) ?? { room_number: "", room_type_name: "" };
    const profile = guestProfileMap.get(String(res.guest_profile_id ?? ""));
    const nightCount = nightCountMap.get(resId) ?? 1;

    const totalRevenue = num(folio.room_revenue + folio.extra_revenue + folio.pos_revenue);
    const totalPaid = num(folio.paid_cash + folio.paid_transfer + folio.paid_credit_card + folio.paid_other);
    const outstanding = num(totalRevenue - totalPaid + folio.refund_total);

    const entry: MonthlyAuditEntry = {
      id: "", // will be set after insert
      period_id: String(period.id),
      reservation_id: resId,
      booking_code: str(res.booking_code) || null,
      guest_name: str(res.guest_name),
      source: str(res.source),
      checkin_date: str(res.checkin_date),
      checkout_date: str(res.checkout_date),
      room_number: room.room_number || null,
      room_type_name: room.room_type_name || null,
      total_nights: nightCount,
      room_revenue: num(folio.room_revenue),
      extra_revenue: num(folio.extra_revenue),
      pos_revenue: num(folio.pos_revenue),
      total_revenue: totalRevenue,
      paid_cash: num(folio.paid_cash),
      paid_transfer: num(folio.paid_transfer),
      paid_credit_card: num(folio.paid_credit_card),
      paid_other: num(folio.paid_other),
      total_paid: totalPaid,
      refund_total: num(folio.refund_total),
      outstanding,
      tax_invoice_requested: Boolean(res.tax_invoice_requested),
      tax_invoice_name: null,
      tax_id: null,
      nationality: str(profile?.nationality) || null,
      passport_number: str(profile?.passport_number) || null,
      id_card_number: str(profile?.id_card_number) || null,
      guest_count: 1,
    };
    entries.push(entry);

    insertRows.push({
      period_id: entry.period_id,
      reservation_id: entry.reservation_id,
      booking_code: entry.booking_code,
      guest_name: entry.guest_name,
      source: entry.source,
      checkin_date: entry.checkin_date,
      checkout_date: entry.checkout_date,
      room_number: entry.room_number,
      room_type_name: entry.room_type_name,
      total_nights: entry.total_nights,
      room_revenue: entry.room_revenue,
      extra_revenue: entry.extra_revenue,
      pos_revenue: entry.pos_revenue,
      total_revenue: entry.total_revenue,
      paid_cash: entry.paid_cash,
      paid_transfer: entry.paid_transfer,
      paid_credit_card: entry.paid_credit_card,
      paid_other: entry.paid_other,
      total_paid: entry.total_paid,
      refund_total: entry.refund_total,
      outstanding: entry.outstanding,
      tax_invoice_requested: entry.tax_invoice_requested,
      tax_invoice_name: entry.tax_invoice_name,
      tax_id: entry.tax_id,
      nationality: entry.nationality,
      passport_number: entry.passport_number,
      id_card_number: entry.id_card_number,
      guest_count: entry.guest_count,
      raw_snapshot_json: {
        reservation: res,
        folio,
        room,
        profile: profile ?? null,
      },
    });
  }

  // 9. Bulk insert entries
  if (insertRows.length > 0) {
    const { error: insertError } = await supabase
      .from("monthly_audit_entries")
      .insert(insertRows);

    if (insertError) {
      // Cleanup period on failure
      await supabase.from("monthly_audit_periods").delete().eq("id", period.id);
      throw new MonthlyAuditError(`Failed to insert audit entries: ${insertError.message}`, 500);
    }
  }

  // 10. Compute and save summary. Full tax invoices are reported in their own
  // section and excluded from the editable/abbreviated audit totals.
  const issuedFullTaxInvoiceMap = await loadIssuedFullTaxCoverageMap(supabase, entries);
  const entriesWithFullTax = attachFullTaxInvoiceInfo(entries, issuedFullTaxInvoiceMap);
  const split = splitMonthlyAuditEntries(entriesWithFullTax, posSales);
  const summary = split.summary;

  const { error: summaryError } = await supabase
    .from("monthly_audit_periods")
    .update({ summary_json: summary })
    .eq("id", period.id);

  if (summaryError) {
    console.error("Failed to save monthly summary_json:", summaryError.message);
    // Non-fatal: period + entries already persisted; summary can be recomputed.
  }

  // 11. Audit log
  try {
    await supabase.from("audit_logs").insert({
      actor_user_id: closedByUserId,
      action: "monthly_audit_closed",
      entity_type: "monthly_audit",
      entity_id: String(period.id),
      after_json: {
        year,
        month,
        total_reservations: entries.length,
        total_revenue: summary.totals.total_revenue,
      },
      business_date: toBangkokDateString(),
      source: "manual",
    });
  } catch {
    // non-blocking
  }

  return {
    period: {
      id: String(period.id),
      year: Number(period.year),
      month: Number(period.month),
      status: "reviewing",
      closed_at: String(period.closed_at ?? ""),
      closed_by: closedByUserId,
      audited_at: null,
      audited_by: null,
      summary_json: summary,
      note: null,
      created_at: String(period.created_at),
    },
    entries: entriesWithFullTax,
    summary,
  };
}

// ============================================================
// Preview Month — Live read-only (no DB writes)
// ============================================================

export async function previewMonth(params: {
  supabase: SupabaseLike;
  year: number;
  month: number;
  filterDayuse?: "only" | "exclude";
}): Promise<MonthlyAuditPreviewResult> {
  const { supabase, year, month, filterDayuse } = params;
  const { from: dateFrom, to: dateTo } = monthDateRange(year, month);
  const posSales = await loadMonthlyPosSalesSummary({ supabase, year, month });

  // 1) Load checked-out reservations in this month
  const { data: reservations, error: resError } = await supabase
    .from("reservations")
    .select(
      "id, booking_code, guest_name, source, checkin_date, checkout_date, total_price, tax_invoice_requested, guest_profile_id, is_dayuse"
    )
    .eq("status", "checked_out")
    .gte("checkout_date", dateFrom)
    .lte("checkout_date", dateTo)
    .order("checkout_date", { ascending: true });

  if (resError) {
    throw new MonthlyAuditError(`Failed to load reservations: ${resError.message}`, 500);
  }

  const reservationRows = ((reservations ?? []) as any[]).filter((row) => {
    if (filterDayuse === "only") return Boolean(row.is_dayuse);
    if (filterDayuse === "exclude") return !Boolean(row.is_dayuse);
    return true;
  });
  if (reservationRows.length === 0) {
    return {
      year,
      month,
      entries: [],
      summary: computeSummary([], posSales),
      available_sources: [],
      generated_at: new Date().toISOString(),
    };
  }

  const reservationIds = reservationRows.map((r: any) => String(r.id));

  // 2) Load folio data
  const { data: folioRows, error: folioError } = await supabase
    .from("folio_payments")
    .select("reservation_id, tx_type, method, amount, revenue_category, is_record_only")
    .in("reservation_id", reservationIds)
    .eq("is_record_only", false);

  if (folioError) {
    throw new MonthlyAuditError(`Failed to load folio data: ${folioError.message}`, 500);
  }

  // 3) Load room assignments (latest night per reservation for room number)
  const { data: nightRows, error: nightError } = await supabase
    .from("reservation_nights")
    .select("reservation_id, room_id, rooms(room_number, room_type_id, room_types(name_en))")
    .in("reservation_id", reservationIds)
    .is("cancelled_at", null)
    .order("stay_date", { ascending: false });

  if (nightError) {
    throw new MonthlyAuditError(`Failed to load room assignments: ${nightError.message}`, 500);
  }

  // 4) Load guest profiles for identity data
  const guestProfileIds = reservationRows.map((r: any) => r.guest_profile_id).filter(Boolean);
  let guestProfileMap = new Map<string, any>();
  if (guestProfileIds.length > 0) {
    const { data: profiles } = await supabase
      .from("guest_profiles")
      .select("id, nationality, passport_number, id_card_number")
      .in("id", guestProfileIds);

    if (profiles) {
      guestProfileMap = new Map((profiles as any[]).map((p: any) => [String(p.id), p]));
    }
  }

  // 5) Build lookup maps
  const folioMap = new Map<string, MonthlyFolioAgg>();
  for (const row of (folioRows ?? []) as any[]) {
    const resId = String(row.reservation_id);
    if (!folioMap.has(resId)) {
      folioMap.set(resId, emptyFolioAgg());
    }
    const agg = folioMap.get(resId)!;
    applyFolioPaymentRow(agg, row);
  }

  const roomMap = new Map<string, { room_number: string; room_type_name: string }>();
  for (const row of (nightRows ?? []) as any[]) {
    const resId = String(row.reservation_id);
    if (roomMap.has(resId)) continue;
    const roomObj = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
    const typeObj = roomObj?.room_types
      ? (Array.isArray(roomObj.room_types) ? roomObj.room_types[0] : roomObj.room_types)
      : null;
    roomMap.set(resId, {
      room_number: str(roomObj?.room_number),
      room_type_name: str(typeObj?.name_en),
    });
  }

  const nightCountMap = new Map<string, number>();
  for (const row of (nightRows ?? []) as any[]) {
    const resId = String(row.reservation_id);
    nightCountMap.set(resId, (nightCountMap.get(resId) ?? 0) + 1);
  }

  // 6) Build in-memory entries only (no inserts)
  const entries: MonthlyAuditEntry[] = [];

  for (const res of reservationRows) {
    const resId = String(res.id);
    const folio = folioMap.get(resId) ?? emptyFolioAgg();
    const room = roomMap.get(resId) ?? { room_number: "", room_type_name: "" };
    const profile = guestProfileMap.get(String(res.guest_profile_id ?? ""));
    const nightCount = nightCountMap.get(resId) ?? 1;

    const totalRevenue = num(folio.room_revenue + folio.extra_revenue + folio.pos_revenue);
    const totalPaid = num(folio.paid_cash + folio.paid_transfer + folio.paid_credit_card + folio.paid_other);
    const outstanding = num(totalRevenue - totalPaid + folio.refund_total);

    entries.push({
      id: `preview-${resId}`,
      period_id: "preview",
      reservation_id: resId,
      booking_code: str(res.booking_code) || null,
      guest_name: str(res.guest_name),
      source: str(res.source),
      checkin_date: str(res.checkin_date),
      checkout_date: str(res.checkout_date),
      room_number: room.room_number || null,
      room_type_name: room.room_type_name || null,
      total_nights: nightCount,
      room_revenue: num(folio.room_revenue),
      extra_revenue: num(folio.extra_revenue),
      pos_revenue: num(folio.pos_revenue),
      total_revenue: totalRevenue,
      paid_cash: num(folio.paid_cash),
      paid_transfer: num(folio.paid_transfer),
      paid_credit_card: num(folio.paid_credit_card),
      paid_other: num(folio.paid_other),
      total_paid: totalPaid,
      refund_total: num(folio.refund_total),
      outstanding,
      tax_invoice_requested: Boolean(res.tax_invoice_requested),
      tax_invoice_name: null,
      tax_id: null,
      nationality: str(profile?.nationality) || null,
      passport_number: str(profile?.passport_number) || null,
      id_card_number: str(profile?.id_card_number) || null,
      guest_count: 1,
      corrections: [],
    });
  }

  const issuedFullTaxInvoiceMap = await loadIssuedFullTaxCoverageMap(supabase, entries);
  const entriesWithFullTax = attachFullTaxInvoiceInfo(entries, issuedFullTaxInvoiceMap);
  const split = splitMonthlyAuditEntries(entriesWithFullTax, posSales);
  const availableSources = Array.from(new Set(entriesWithFullTax.map((e) => e.source).filter(Boolean))).sort();

  return {
    year,
    month,
    entries: entriesWithFullTax,
    summary: split.summary,
    available_sources: availableSources,
    generated_at: new Date().toISOString(),
  };
}

// ============================================================
// Apply Correction
// ============================================================

export async function applyCorrection(params: {
  supabase: SupabaseLike;
  entryId: string;
  fieldName: string;
  newValue: string;
  reason?: string;
  correctedByUserId: string | null;
}): Promise<MonthlyAuditCorrection> {
  const { supabase, entryId, fieldName, newValue, reason, correctedByUserId } = params;

  // Validate field name
  if (!(CORRECTABLE_FIELDS as readonly string[]).includes(fieldName)) {
    throw new MonthlyAuditError(`Field "${fieldName}" is not correctable.`);
  }

  // Load entry + check period status
  const { data: entry, error: entryError } = await supabase
    .from("monthly_audit_entries")
    .select("*, monthly_audit_periods!inner(status)")
    .eq("id", entryId)
    .maybeSingle();

  if (entryError) throw new MonthlyAuditError(entryError.message, 500);
  if (!entry) throw new MonthlyAuditError("Audit entry not found.", 404);

  const periodStatus = (entry as any).monthly_audit_periods?.status;
  if (periodStatus !== "reviewing") {
    throw new MonthlyAuditError(
      `Cannot correct entries in "${periodStatus}" period. Only "reviewing" periods allow corrections.`,
      409
    );
  }

  const issuedFullTaxInvoiceMap = await loadIssuedFullTaxInvoiceMap(supabase, [String((entry as any).reservation_id)]);
  if (issuedFullTaxInvoiceMap.has(String((entry as any).reservation_id))) {
    throw new MonthlyAuditError(
      "This booking has an issued full tax invoice. Edit it from Booking > Tax Invoice, then re-generate Monthly Audit.",
      409
    );
  }

  // Get old value
  const oldValue = String((entry as any)[fieldName] ?? "");

  // Prepare updated value
  const updatePayload: Record<string, unknown> = {};
  let numericNewValue: number | null = null;
  if (NUMERIC_FIELDS.has(fieldName)) {
    const parsedNumeric = Number(newValue);
    if (!Number.isFinite(parsedNumeric)) {
      throw new MonthlyAuditError(
        `Invalid numeric value for "${fieldName}": "${newValue}"`,
        400
      );
    }
    numericNewValue = Math.round(parsedNumeric * 100) / 100;
    updatePayload[fieldName] = numericNewValue;
  } else if (fieldName === "tax_invoice_requested") {
    updatePayload[fieldName] = newValue === "true";
  } else {
    updatePayload[fieldName] = newValue;
  }

  // Recalculate totals if a revenue or payment field changed
  const recalcFields = new Set([
    "room_revenue", "extra_revenue", "pos_revenue",
    "paid_cash", "paid_transfer", "paid_credit_card", "paid_other",
    "refund_total",
  ]);

  if (recalcFields.has(fieldName)) {
    const current = entry as any;
    const get = (f: string) => {
      if (f === fieldName) return numericNewValue ?? num(newValue);
      return num(current[f]);
    };

    const totalRevenue = get("room_revenue") + get("extra_revenue") + get("pos_revenue");
    const totalPaid = get("paid_cash") + get("paid_transfer") + get("paid_credit_card") + get("paid_other");
    const outstanding = totalRevenue - totalPaid + get("refund_total");

    updatePayload.total_revenue = num(totalRevenue);
    updatePayload.total_paid = num(totalPaid);
    updatePayload.outstanding = num(outstanding);
  }

  // Insert correction first (source of truth), then update entry (derived state).
  const { data: correction, error: correctionError } = await supabase
    .from("monthly_audit_corrections")
    .insert({
      entry_id: entryId,
      field_name: fieldName,
      old_value: oldValue,
      new_value: newValue,
      reason: reason || null,
      corrected_by: correctedByUserId,
    })
    .select("*")
    .single();

  if (correctionError) {
    throw new MonthlyAuditError(`Failed to record correction: ${correctionError.message}`, 500);
  }

  const { error: updateError } = await supabase
    .from("monthly_audit_entries")
    .update(updatePayload)
    .eq("id", entryId);

  if (updateError) {
    throw new MonthlyAuditError(
      `Correction logged but entry update failed: ${updateError.message}. Correction ID: ${correction.id}`,
      500
    );
  }

  return {
    id: String(correction.id),
    entry_id: String(correction.entry_id),
    field_name: String(correction.field_name),
    old_value: correction.old_value ?? null,
    new_value: correction.new_value ?? null,
    reason: correction.reason ?? null,
    corrected_by: correction.corrected_by ?? null,
    corrected_at: String(correction.corrected_at),
  };
}

// ============================================================
// Approve Month
// ============================================================

export async function approveMonth(params: {
  supabase: SupabaseLike;
  year: number;
  month: number;
  auditedByUserId: string | null;
}): Promise<MonthlyAuditPeriod> {
  const { supabase, year, month, auditedByUserId } = params;

  const { data: period, error: periodError } = await supabase
    .from("monthly_audit_periods")
    .select("*")
    .eq("year", year)
    .eq("month", month)
    .maybeSingle();

  if (periodError) throw new MonthlyAuditError(periodError.message, 500);
  if (!period) throw new MonthlyAuditError("Audit period not found.", 404);

  if (period.status !== "reviewing") {
    throw new MonthlyAuditError(
      `Cannot approve period in "${period.status}" status. Must be "reviewing".`,
      409
    );
  }

  // Recompute summary with corrected values
  const { data: entries, error: entriesError } = await supabase
    .from("monthly_audit_entries")
    .select("*")
    .eq("period_id", period.id);

  if (entriesError) throw new MonthlyAuditError(entriesError.message, 500);

  const shapedEntries: MonthlyAuditEntry[] = ((entries ?? []) as any[]).map((e: any) => ({
    id: String(e.id),
    period_id: String(e.period_id),
    reservation_id: String(e.reservation_id),
    booking_code: e.booking_code ?? null,
    guest_name: str(e.guest_name),
    source: str(e.source),
    checkin_date: str(e.checkin_date),
    checkout_date: str(e.checkout_date),
    room_number: e.room_number ?? null,
    room_type_name: e.room_type_name ?? null,
    total_nights: Number(e.total_nights ?? 1),
    room_revenue: num(e.room_revenue),
    extra_revenue: num(e.extra_revenue),
    pos_revenue: num(e.pos_revenue),
    total_revenue: num(e.total_revenue),
    paid_cash: num(e.paid_cash),
    paid_transfer: num(e.paid_transfer),
    paid_credit_card: num(e.paid_credit_card),
    paid_other: num(e.paid_other),
    total_paid: num(e.total_paid),
    refund_total: num(e.refund_total),
    outstanding: num(e.outstanding),
    tax_invoice_requested: Boolean(e.tax_invoice_requested),
    tax_invoice_name: e.tax_invoice_name ?? null,
    tax_id: e.tax_id ?? null,
    nationality: e.nationality ?? null,
    passport_number: e.passport_number ?? null,
    id_card_number: e.id_card_number ?? null,
    guest_count: Number(e.guest_count ?? 1),
  }));

  const savedPosSales = (period.summary_json as any)?.pos_sales;
  const posSales = savedPosSales ?? await loadMonthlyPosSalesSummary({ supabase, year, month });
  const issuedFullTaxInvoiceMap = await loadIssuedFullTaxCoverageMap(supabase, shapedEntries);
  const split = splitMonthlyAuditEntries(
    attachFullTaxInvoiceInfo(shapedEntries, issuedFullTaxInvoiceMap),
    posSales
  );
  const summary = split.summary;
  const now = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("monthly_audit_periods")
    .update({
      status: "audited",
      audited_at: now,
      audited_by: auditedByUserId,
      summary_json: summary,
      updated_at: now,
    })
    .eq("id", period.id);

  if (updateError) {
    throw new MonthlyAuditError(`Failed to approve period: ${updateError.message}`, 500);
  }

  // Audit log
  try {
    await supabase.from("audit_logs").insert({
      actor_user_id: auditedByUserId,
      action: "monthly_audit_approved",
      entity_type: "monthly_audit",
      entity_id: String(period.id),
      after_json: { year, month, total_revenue: summary.totals.total_revenue },
      business_date: toBangkokDateString(),
      source: "manual",
    });
  } catch {
    // non-blocking
  }

  return {
    id: String(period.id),
    year,
    month,
    status: "audited",
    closed_at: period.closed_at ?? null,
    closed_by: period.closed_by ?? null,
    audited_at: now,
    audited_by: auditedByUserId,
    summary_json: summary,
    note: period.note ?? null,
    created_at: String(period.created_at),
  };
}

// ============================================================
// Reopen month — admin or supervisor only (same permission as approve)
// ============================================================

export async function reopenMonth(params: {
  supabase: SupabaseLike;
  year: number;
  month: number;
  userId: string | null;
}): Promise<void> {
  const { supabase, year, month, userId } = params;

  const { data: period, error } = await supabase
    .from("monthly_audit_periods")
    .select("id, status")
    .eq("year", year)
    .eq("month", month)
    .maybeSingle();

  if (error) throw new MonthlyAuditError(error.message, 500);
  if (!period) throw new MonthlyAuditError("Audit period not found.", 404);

  if (period.status === "locked") {
    throw new MonthlyAuditError("Locked periods cannot be reopened. Reports have been generated.", 409);
  }
  if (period.status === "open") {
    throw new MonthlyAuditError("Period is already open.", 409);
  }

  await supabase
    .from("monthly_audit_periods")
    .update({
      status: "reviewing",
      audited_at: null,
      audited_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", period.id);

  try {
    await supabase.from("audit_logs").insert({
      actor_user_id: userId,
      action: "monthly_audit_reopened",
      entity_type: "monthly_audit",
      entity_id: String(period.id),
      after_json: { year, month },
      business_date: toBangkokDateString(),
      source: "manual",
    });
  } catch {
    // non-blocking
  }
}
