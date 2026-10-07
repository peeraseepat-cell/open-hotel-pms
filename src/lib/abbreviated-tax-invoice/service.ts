import {
  ABBREVIATED_BOOK_NO_BASE_BE_YEAR,
  ABBREVIATED_MAX_ROWS_PER_HALF_PAGE,
  ABBREVIATED_VAT_RATE,
  type AbbreviatedInvoiceDraft,
  type AbbreviatedLineDraft,
  type AbbreviatedPosPreviewResponse,
  type AbbreviatedPreviewResponse,
  type AbbreviatedSourceType,
  type CarriedFolioInfo,
  type ChannelGroup,
  type ExcludedFolioInfo,
  type GenerateResult,
  type NightOverrideDecision,
  type PosItemDraft,
  type RowShiftBatchInput,
  type RecalculateResult,
  type RowShiftInput,
  type TaxGroup,
} from "@/lib/abbreviated-tax-invoice/types";
import {
  assignSequentialInvoiceNumbers,
  computeAbbreviatedInvoiceNo,
  planAbbreviatedInvoiceRenumbering,
} from "@/lib/abbreviated-tax-invoice/numbering";
import {
  mapCompletedPositivePosItemRows,
  type PosItemRow,
} from "@/lib/abbreviated-tax-invoice/pos-items";
import {
  allocateRoomAndExtraAcrossNights,
  applyCoveredRoomRevenueToNights,
  completeChargedReservationNightsFromAuditTotal,
} from "@/lib/abbreviated-tax-invoice/night-allocation";
import { extractReservationIdsFromBookingSnapshot, getSellerSnapshotFromSettings } from "@/lib/tax-invoice/service";
import { fetchAllRowsComplete } from "@/lib/complete-fetch";
import { normalizeMoney, round2 } from "@/lib/tax-invoice/utils";
import type { BookingSource } from "@/lib/types";
import { loadIssuedFullTaxCoverageMap } from "@/lib/monthly-audit";
import { normalizeBookingSource } from "@/lib/monthly-audit-channel-flag/service";

type SupabaseLike = {
  from: (table: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => any;
};

type AuditPeriodRow = {
  id: string;
  year: number;
  month: number;
  status: string;
};

type AuditEntryRow = {
  id: string;
  period_id: string;
  reservation_id: string;
  source: BookingSource;
  guest_name: string;
  checkin_date: string;
  checkout_date: string;
  room_revenue: number;
  extra_revenue: number;
  total_revenue: number;
  refund_total: number;
  outstanding: number;
};

type ReservationRow = {
  id: string;
  booking_code: string | null;
  guest_name: string;
  source: BookingSource;
  status: string;
  checkin_date: string;
  checkout_date: string;
  is_dayuse: boolean;
};

type NightRow = {
  id: string;
  reservation_id: string;
  room_id: string | null;
  stay_date: string;
  nightly_price: number;
  room_type_code: string | null;
  cancelled_at: string | null;
};

type FolioRow = {
  reservation_id: string;
  tx_type: string;
  amount: number;
  revenue_category: string;
  is_record_only: boolean;
  is_void_reversal: boolean;
  is_correction: boolean;
  void_of: string | null;
};

type RoomGroupMapRow = {
  room_type_code: string;
  tax_group: TaxGroup;
  label_th: string;
  sort_order: number;
};

type ChannelFlagRow = {
  entry_id: string;
  actual_channel: BookingSource;
  tax_invoice_channel: BookingSource;
};

type NightOverrideRow = {
  entry_id: string;
  night_date: string;
  decision: NightOverrideDecision;
};

type ShiftOverrideWorkRow = {
  entry_id: string;
  tax_group: TaxGroup;
  unit_price: number;
  original_date: string;
  target_date: string;
  remaining: number;
};

type SourceNight = {
  entry_id: string;
  reservation_id: string;
  guest_name: string;
  checkin_date: string;
  checkout_date: string;
  issue_date: string;
  stay_date: string;
  channel_group: ChannelGroup | null;
  tax_invoice_channel: BookingSource;
  tax_group: TaxGroup | null;
  label_th: string;
  unit_price: number;
  amount: number;
  shifted_from_date: string | null;
  shift_source: "auto" | "manual" | null;
};

export class AbbreviatedTaxInvoiceError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AbbreviatedTaxInvoiceError";
    this.status = status;
  }
}

function monthDateRange(year: number, month: number): { from: string; to: string } {
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

function monthIssueDate(year: number, month: number): string {
  return monthDateRange(year, month).to;
}

function addDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00+07:00`);
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function str(value: unknown): string {
  return String(value ?? "").trim();
}

function sourceIds(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => str(value)).filter(Boolean)));
}

export function mapActualChannelToGroup(channel: BookingSource): ChannelGroup {
  return channel === "ota" || channel === "agent" ? "ota" : "walkin_direct";
}

export function computeBookNo(issueDate: string): number {
  const year = Number(issueDate.slice(0, 4));
  const beYear = year + 543;
  return beYear - ABBREVIATED_BOOK_NO_BASE_BE_YEAR;
}
export { assignSequentialInvoiceNumbers, computeAbbreviatedInvoiceNo };

export function computeAbbreviatedStayRange(issueDate: string): { from: string; to: string } {
  return {
    from: addDays(issueDate, -1),
    to: issueDate,
  };
}

export function computeMonthlyStayRange(year: number, month: number): { from: string; to: string } {
  return monthDateRange(year, month);
}

export function computeVatBreakdown(
  incVatAmount: number,
  vatRate = ABBREVIATED_VAT_RATE
): { ex: number; vat: number; inc: number } {
  const inc = round2(Math.max(0, normalizeMoney(incVatAmount)));
  const divisor = 1 + vatRate / 100;
  const ex = round2(inc / divisor);
  return { ex, vat: round2(inc - ex), inc };
}

function isValidTaxGroup(value: unknown): value is TaxGroup {
  return value === "A" || value === "B" || value === "C" || value === "D" || value === "E";
}

async function loadAuditPeriod(supabase: SupabaseLike, year: number, month: number): Promise<AuditPeriodRow> {
  const { data, error } = await supabase
    .from("monthly_audit_periods")
    .select("id, year, month, status")
    .eq("year", year)
    .eq("month", month)
    .maybeSingle();

  if (error) throw new AbbreviatedTaxInvoiceError(error.message, 500);
  if (!data) {
    throw new AbbreviatedTaxInvoiceError(
      `No monthly audit period found for ${year}-${String(month).padStart(2, "0")}.`,
      404
    );
  }

  return {
    id: String((data as any).id),
    year: Number((data as any).year),
    month: Number((data as any).month),
    status: str((data as any).status),
  };
}

async function ensureAuditPeriodExists(
  supabase: SupabaseLike,
  year: number,
  month: number
): Promise<AuditPeriodRow> {
  const { data: existing, error: existingError } = await supabase
    .from("monthly_audit_periods")
    .select("id, year, month, status")
    .eq("year", year)
    .eq("month", month)
    .maybeSingle();

  if (existingError) throw new AbbreviatedTaxInvoiceError(existingError.message, 500);
  if (existing) {
    return {
      id: String((existing as any).id),
      year: Number((existing as any).year),
      month: Number((existing as any).month),
      status: str((existing as any).status),
    };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("monthly_audit_periods")
    .insert({
      year,
      month,
      status: "open",
    })
    .select("id, year, month, status")
    .single();

  if (insertError) {
    const { data: retry, error: retryError } = await supabase
      .from("monthly_audit_periods")
      .select("id, year, month, status")
      .eq("year", year)
      .eq("month", month)
      .maybeSingle();

    if (retryError) throw new AbbreviatedTaxInvoiceError(retryError.message, 500);
    if (!retry) throw new AbbreviatedTaxInvoiceError(insertError.message, 500);

    return {
      id: String((retry as any).id),
      year: Number((retry as any).year),
      month: Number((retry as any).month),
      status: str((retry as any).status),
    };
  }

  return {
    id: String((inserted as any).id),
    year: Number((inserted as any).year),
    month: Number((inserted as any).month),
    status: str((inserted as any).status),
  };
}

async function loadAuditEntries(supabase: SupabaseLike, periodId: string): Promise<AuditEntryRow[]> {
  // Every audit entry for the period feeds the abbreviated tax invoice build, so
  // a truncated read silently under-reports the month's tax.
  let data: any[];
  try {
    data = await fetchAllRowsComplete<any>(
      () =>
        supabase
          .from("monthly_audit_entries")
          .select(
            "id, period_id, reservation_id, source, guest_name, checkin_date, checkout_date, room_revenue, extra_revenue, total_revenue, refund_total, outstanding",
            { count: "exact" }
          )
          .eq("period_id", periodId),
      { label: "monthly audit entries" }
    );
  } catch (error) {
    throw new AbbreviatedTaxInvoiceError(
      error instanceof Error ? error.message : String(error),
      500
    );
  }

  return ((data ?? []) as any[]).map((row) => ({
    id: String(row.id),
    period_id: String(row.period_id),
    reservation_id: String(row.reservation_id),
    source: normalizeBookingSource(row.source),
    guest_name: str(row.guest_name),
    checkin_date: str(row.checkin_date),
    checkout_date: str(row.checkout_date),
    room_revenue: normalizeMoney(row.room_revenue),
    extra_revenue: normalizeMoney(row.extra_revenue),
    total_revenue: normalizeMoney(row.total_revenue ?? Number(row.room_revenue ?? 0) + Number(row.extra_revenue ?? 0)),
    refund_total: normalizeMoney(row.refund_total),
    outstanding: normalizeMoney(row.outstanding),
  }));
}

async function loadReservations(
  supabase: SupabaseLike,
  dateFrom: string,
  dateTo: string,
  auditEntries: AuditEntryRow[]
): Promise<ReservationRow[]> {
  const auditReservationIds = sourceIds(auditEntries.map((entry) => entry.reservation_id));
  const byId = new Map<string, ReservationRow>();

  if (auditReservationIds.length > 0) {
    const { data, error } = await supabase
      .from("reservations")
      .select("id, booking_code, guest_name, source, status, checkin_date, checkout_date, is_dayuse")
      .in("id", auditReservationIds);

    if (error) throw new AbbreviatedTaxInvoiceError(error.message, 500);
    for (const row of (data ?? []) as any[]) byId.set(String(row.id), shapeReservation(row));
  }

  let overlapping: any[];
  try {
    overlapping = await fetchAllRowsComplete<any>(
      () =>
        supabase
          .from("reservations")
          .select("id, booking_code, guest_name, source, status, checkin_date, checkout_date, is_dayuse", {
            count: "exact",
          })
          .lte("checkin_date", dateTo)
          .gt("checkout_date", dateFrom)
          .neq("status", "cancelled")
          .neq("status", "no_show"),
      { label: "overlapping reservations" }
    );
  } catch (error) {
    throw new AbbreviatedTaxInvoiceError(
      error instanceof Error ? error.message : String(error),
      500
    );
  }
  for (const row of overlapping) byId.set(String(row.id), shapeReservation(row));

  return Array.from(byId.values()).sort((a, b) => a.checkout_date.localeCompare(b.checkout_date));
}

function shapeReservation(row: any): ReservationRow {
  return {
    id: String(row.id),
    booking_code: row.booking_code ?? null,
    guest_name: str(row.guest_name),
    source: normalizeBookingSource(row.source),
    status: str(row.status),
    checkin_date: str(row.checkin_date),
    checkout_date: str(row.checkout_date),
    is_dayuse: Boolean(row.is_dayuse),
  };
}

async function loadNights(
  supabase: SupabaseLike,
  reservationIds: string[]
): Promise<NightRow[]> {
  if (reservationIds.length === 0) return [];

  // Keyset by `id`, not offset. This used to page by offset under
  // `.order("stay_date")`, which LOOKS safe and is not: stay_date is NOT unique on
  // reservation_nights — its only unique indexes are the (room, day) composites —
  // so it is not a total order. Nights tying on a stay_date could be returned in
  // any order between pages, duplicating and skipping across the boundary exactly
  // as an unordered pager does. A non-total ORDER BY does not make offset paging
  // safe; it only makes the defect harder to see, which is why this one outlived
  // the read that had no order at all.
  //
  // Dropping the stay_date order costs nothing downstream: every consumer re-sorts
  // by stay_date itself (buildRoomPreview and night-allocation both do).
  let rows: any[];
  try {
    rows = await fetchAllRowsComplete<any>(
      () =>
        supabase
          .from("reservation_nights")
          .select(
            "id, reservation_id, room_id, stay_date, nightly_price, cancelled_at, rooms(id, room_type_id, room_types(code, name_en))",
            { count: "exact" }
          )
          .in("reservation_id", reservationIds),
      { label: "invoice nights" }
    );
  } catch (error) {
    throw new AbbreviatedTaxInvoiceError(
      error instanceof Error ? error.message : String(error),
      500
    );
  }

  return rows.map((row) => {
    const room = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
    const roomType = room?.room_types
      ? (Array.isArray(room.room_types) ? room.room_types[0] : room.room_types)
      : null;
    return {
      id: String(row.id),
      reservation_id: String(row.reservation_id),
      room_id: row.room_id ? String(row.room_id) : null,
      stay_date: str(row.stay_date),
      nightly_price: normalizeMoney(row.nightly_price),
      room_type_code: str(roomType?.code) || null,
      cancelled_at: row.cancelled_at ? String(row.cancelled_at) : null,
    };
  });
}

async function loadFolioRows(supabase: SupabaseLike, reservationIds: string[]): Promise<FolioRow[]> {
  if (reservationIds.length === 0) return [];

  const { data, error } = await supabase
    .from("folio_payments")
    .select("reservation_id, tx_type, amount, revenue_category, is_record_only, is_void_reversal, is_correction, void_of")
    .in("reservation_id", reservationIds);

  if (error) throw new AbbreviatedTaxInvoiceError(error.message, 500);

  return ((data ?? []) as any[]).map((row) => ({
    reservation_id: String(row.reservation_id),
    tx_type: str(row.tx_type).toLowerCase(),
    amount: normalizeMoney(row.amount),
    revenue_category: str(row.revenue_category).toLowerCase(),
    is_record_only: Boolean(row.is_record_only),
    is_void_reversal: Boolean(row.is_void_reversal),
    is_correction: Boolean(row.is_correction),
    void_of: row.void_of ? String(row.void_of) : null,
  }));
}

async function loadDayUseReservationsForMonth(
  supabase: SupabaseLike,
  year: number,
  month: number
): Promise<ReservationRow[]> {
  const { from: dateFrom, to: dateTo } = monthDateRange(year, month);
  const { data, error } = await supabase
    .from("reservations")
    .select("id, booking_code, guest_name, source, status, checkin_date, checkout_date, is_dayuse")
    .eq("status", "checked_out")
    .eq("is_dayuse", true)
    .gte("checkout_date", dateFrom)
    .lte("checkout_date", dateTo)
    .order("checkout_date", { ascending: true });

  if (error) throw new AbbreviatedTaxInvoiceError(error.message, 500);
  return ((data ?? []) as any[]).map(shapeReservation);
}

export async function loadPosItemsForDay(
  supabase: SupabaseLike,
  date: string
): Promise<PosItemRow[]> {
  const { data, error } = await supabase
    .from("pos_order_items")
    .select(
      "order_id, product_id, quantity, unit_price, line_total, pos_orders!inner(id, order_number, order_date, order_type, status), products!inner(id, name, name_th, pos_abbreviated_enabled)"
    )
    .eq("pos_orders.order_date", date)
    .eq("pos_orders.status", "completed")
    .gt("line_total", 0)
    .eq("products.pos_abbreviated_enabled", true)
    .order("order_id", { ascending: true });

  if (error) throw new AbbreviatedTaxInvoiceError(error.message, 500);
  return mapCompletedPositivePosItemRows(data ?? []);
}

async function loadRoomGroupMap(supabase: SupabaseLike): Promise<Map<string, RoomGroupMapRow>> {
  const { data, error } = await supabase
    .from("tax_invoice_room_group_map")
    .select("room_type_code, tax_group, label_th, sort_order")
    .order("sort_order", { ascending: true });

  if (error) throw new AbbreviatedTaxInvoiceError(error.message, 500);

  const map = new Map<string, RoomGroupMapRow>();
  for (const row of (data ?? []) as any[]) {
    if (!isValidTaxGroup(row.tax_group)) continue;
    map.set(str(row.room_type_code).toUpperCase(), {
      room_type_code: str(row.room_type_code).toUpperCase(),
      tax_group: row.tax_group,
      label_th: str(row.label_th) || `ห้องพักแบบ ${row.tax_group}`,
      sort_order: Number(row.sort_order ?? 999),
    });
  }
  return map;
}

async function loadIssuedFullTaxReservationIds(
  supabase: SupabaseLike,
  reservationIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (reservationIds.length === 0) return map;

  let rows: any[];
  try {
    rows = await fetchAllRowsComplete<any>(
      () =>
        supabase
          .from("invoices")
          .select("id, reservation_id, booking_snapshot", { count: "exact" })
          .eq("status", "issued")
          .is("cancelled_at", null),
      { label: "issued full tax invoices" }
    );
  } catch (error) {
    throw new AbbreviatedTaxInvoiceError(
      error instanceof Error ? error.message : String(error),
      500
    );
  }

  const wanted = new Set(reservationIds);
  for (const row of rows) {
    const ids = extractReservationIdsFromBookingSnapshot(row.booking_snapshot, row.reservation_id);
    for (const reservationId of ids) {
      if (wanted.has(reservationId)) map.set(reservationId, String(row.id));
    }
  }
  return map;
}

function groupByReservation<T extends { reservation_id: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const current = map.get(row.reservation_id) ?? [];
    current.push(row);
    map.set(row.reservation_id, current);
  }
  return map;
}

function shiftOverrideKey(
  entryId: string,
  originalDate: string,
  taxGroup: TaxGroup,
  unitPrice: number
): string {
  return `${entryId}::${originalDate}::${taxGroup}::${round2(unitPrice).toFixed(2)}`;
}

function distributeExtra(total: number, count: number, index: number): number {
  if (total <= 0 || count <= 0) return 0;
  const base = round2(total / count);
  if (index < count - 1) return base;
  return round2(total - base * (count - 1));
}

function buildDraftSummary(drafts: AbbreviatedInvoiceDraft[]) {
  return drafts.reduce(
    (acc, draft) => {
      acc.total_invoices += 1;
      if (draft.channel_group === "ota") acc.ota_count += 1;
      else acc.walkin_direct_count += 1;
      acc.grand_total_inc_vat = round2(acc.grand_total_inc_vat + draft.subtotal_inc_vat);
      acc.grand_total_ex_vat = round2(acc.grand_total_ex_vat + draft.subtotal_ex_vat);
      acc.vat_total = round2(acc.vat_total + draft.vat_amount);
      return acc;
    },
    {
      total_invoices: 0,
      ota_count: 0,
      walkin_direct_count: 0,
      grand_total_inc_vat: 0,
      grand_total_ex_vat: 0,
      vat_total: 0,
    }
  );
}

function buildPosLines(posItems: PosItemDraft[]): AbbreviatedLineDraft[] {
  return sortDraftLines(
    posItems.map((item) => ({
      tax_group: null,
      label_th: item.label_th,
      quantity: item.quantity,
      unit_price: item.unit_price,
      amount: item.amount,
      source_entry_ids: sourceIds(item.source_order_ids),
      source_entries: item.source_orders.map((order) => ({
        entry_id: order.order_id,
        guest_name: order.order_number,
        checkin_date: order.order_date,
        checkout_date: order.order_date,
        quantity: order.quantity,
      })),
      shifted_from_date: null,
      shift_source: null,
    }))
  );
}

function buildDayUseLines(rows: Array<{
  entry_id: string;
  guest_name: string;
  checkin_date: string;
  checkout_date: string;
  unit_price: number;
}>): AbbreviatedLineDraft[] {
  const grouped = new Map<string, AbbreviatedLineDraft>();

  for (const row of rows) {
    const key = row.unit_price.toFixed(2);
    const current = grouped.get(key) ?? {
      tax_group: null,
      label_th: "Day Use",
      quantity: 0,
      unit_price: row.unit_price,
      amount: 0,
      source_entry_ids: [],
      source_entries: [],
      shifted_from_date: null,
      shift_source: null,
    };
    current.quantity += 1;
    current.amount = round2(current.amount + row.unit_price);
    current.source_entry_ids = sourceIds([...current.source_entry_ids, row.entry_id]);
    current.source_entries.push({
      entry_id: row.entry_id,
      guest_name: row.guest_name,
      checkin_date: row.checkin_date,
      checkout_date: row.checkout_date,
      quantity: 1,
    });
    grouped.set(key, current);
  }

  return sortDraftLines(Array.from(grouped.values()));
}

function sortDraftLines(lines: AbbreviatedLineDraft[]): AbbreviatedLineDraft[] {
  return [...lines].sort((a, b) => {
    // Phase 71: tax_group is NULL for dayuse/pos. NULL-first keeps those lines
    // stable under their own (single-source-type) draft — Phase 70 rooms are
    // always non-null so this branch is inert for room drafts.
    const aKey = a.tax_group ?? "";
    const bKey = b.tax_group ?? "";
    if (aKey !== bKey) return aKey.localeCompare(bKey);
    return a.unit_price - b.unit_price;
  });
}

export function groupLinesForDay(entries: SourceNight[]): AbbreviatedLineDraft[] {
  const grouped = new Map<string, AbbreviatedLineDraft>();

  for (const entry of entries) {
    const key = `${entry.tax_group}::${entry.unit_price.toFixed(2)}`;
    const current = grouped.get(key) ?? {
      tax_group: entry.tax_group,
      label_th: entry.label_th,
      quantity: 0,
      unit_price: entry.unit_price,
      amount: 0,
      source_entry_ids: [],
      source_entries: [],
      shifted_from_date: entry.shifted_from_date,
      shift_source: entry.shift_source,
    };
    current.quantity += 1;
    current.amount = round2(current.amount + entry.amount);
    current.source_entry_ids = sourceIds([...current.source_entry_ids, entry.entry_id]);
    const sourceEntry = current.source_entries.find((source) => source.entry_id === entry.entry_id);
    if (sourceEntry) {
      sourceEntry.quantity += 1;
    } else {
      current.source_entries.push({
        entry_id: entry.entry_id,
        guest_name: entry.guest_name,
        checkin_date: entry.checkin_date,
        checkout_date: entry.checkout_date,
        quantity: 1,
      });
    }
    if (current.shifted_from_date !== entry.shifted_from_date) current.shifted_from_date = null;
    if (!current.shift_source && entry.shift_source) current.shift_source = entry.shift_source;
    grouped.set(key, current);
  }

  return sortDraftLines(
    Array.from(grouped.values()).map((line) => ({
      ...line,
      amount: round2(line.amount),
      source_entries: [...line.source_entries].sort(
        (a, b) =>
          a.checkin_date.localeCompare(b.checkin_date) ||
          a.checkout_date.localeCompare(b.checkout_date) ||
          a.guest_name.localeCompare(b.guest_name) ||
          a.entry_id.localeCompare(b.entry_id)
      ),
    }))
  );
}

function buildDraftsFromNights(
  sourceNights: SourceNight[],
  period: AuditPeriodRow
): AbbreviatedInvoiceDraft[] {
  const grouped = new Map<string, SourceNight[]>();
  for (const night of sourceNights) {
    const key = `${night.issue_date}::${night.channel_group}`;
    const rows = grouped.get(key) ?? [];
    rows.push(night);
    grouped.set(key, rows);
  }

  return Array.from(grouped.entries())
    .map(([key, rows]) => {
      const [issueDate, channelGroupRaw] = key.split("::");
      const channelGroup = channelGroupRaw as ChannelGroup;
      const lines = groupLinesForDay(rows);
      const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
      const vat = computeVatBreakdown(subtotal);
      const stayRange = computeAbbreviatedStayRange(issueDate);
      const draft: AbbreviatedInvoiceDraft = {
        // Phase 71: Phase 70 room path — populate discriminators
        source_type: "room",
        render_mode: "full_a4",
        issue_date: issueDate,
        stay_date_from: stayRange.from,
        stay_date_to: stayRange.to,
        channel_group: channelGroup,
        tax_invoice_channel: channelGroup === "ota" ? ("ota" as const) : ("walkin" as const),
        predicted_invoice_no: computeAbbreviatedInvoiceNo(issueDate, channelGroup, "room"),
        book_no: computeBookNo(issueDate),
        lines,
        subtotal_inc_vat: vat.inc,
        subtotal_ex_vat: vat.ex,
        vat_rate: ABBREVIATED_VAT_RATE,
        vat_amount: vat.vat,
        warning: period.status !== "audited" ? `Audit period is ${period.status}; generation requires audited status.` : undefined,
      };
      return draft;
    })
    .sort(
      (a, b) =>
        a.issue_date.localeCompare(b.issue_date) ||
        // Phase 71: channel_group is nullable in the type, but Phase 70 room
        // drafts are always non-null here (grouping key is `issue::channel`).
        (a.channel_group ?? "").localeCompare(b.channel_group ?? "")
    );
}

export function computeAutoShift(drafts: AbbreviatedInvoiceDraft[]): AbbreviatedInvoiceDraft[] {
  const byKey = new Map<string, AbbreviatedInvoiceDraft>();
  for (const draft of drafts) byKey.set(`${draft.issue_date}::${draft.channel_group}`, { ...draft, lines: [...draft.lines] });

  const sortedKeys = Array.from(byKey.keys()).sort();
  const warnings = new Map<string, string>();

  for (const key of sortedKeys) {
    const draft = byKey.get(key);
    if (!draft) continue;
    draft.lines = sortDraftLines(draft.lines);
    while (draft.lines.length > ABBREVIATED_MAX_ROWS_PER_HALF_PAGE) {
      const overflow = draft.lines.pop();
      if (!overflow) break;
      const nextDate = addDays(draft.issue_date, 1);
      const targetKey = `${nextDate}::${draft.channel_group}`;
      const stayRange =
        draft.source_type === "room"
          ? computeAbbreviatedStayRange(nextDate)
          : { from: nextDate, to: nextDate };
      const target = byKey.get(targetKey) ?? {
        ...draft,
        issue_date: nextDate,
        predicted_invoice_no: computeAbbreviatedInvoiceNo(nextDate, draft.channel_group, draft.source_type),
        book_no: computeBookNo(nextDate),
        stay_date_from: stayRange.from,
        stay_date_to: stayRange.to,
        lines: [],
        subtotal_inc_vat: 0,
        subtotal_ex_vat: 0,
        vat_amount: 0,
      };
      target.lines.push({
        ...overflow,
        shifted_from_date: overflow.shifted_from_date ?? draft.issue_date,
        shift_source: overflow.shift_source ?? "auto",
      });
      warnings.set(targetKey, `Auto-shifted overflow row from ${draft.issue_date}.`);
      byKey.set(targetKey, target);
    }
  }

  return Array.from(byKey.values())
    .map((draft) => {
      const subtotal = draft.lines.reduce((sum, line) => sum + line.amount, 0);
      const vat = computeVatBreakdown(subtotal);
      return {
        ...draft,
        lines: sortDraftLines(draft.lines),
        subtotal_inc_vat: vat.inc,
        subtotal_ex_vat: vat.ex,
        vat_amount: vat.vat,
        warning: warnings.get(`${draft.issue_date}::${draft.channel_group}`) ?? draft.warning,
      };
    })
    .filter((draft) => draft.lines.length > 0)
    .sort(
      (a, b) =>
        a.issue_date.localeCompare(b.issue_date) ||
        // Phase 71: channel_group is nullable in the type; room drafts here are non-null.
        (a.channel_group ?? "").localeCompare(b.channel_group ?? "")
    );
}

export async function getNextInvoiceNumber(
  supabase: SupabaseLike,
  issueDate: string,
  sourceType: AbbreviatedSourceType,
  channelGroup: ChannelGroup | null = null
): Promise<string> {
  const { data, error } = await supabase.rpc("next_abbreviated_invoice_no", {
    p_date: issueDate,
    p_channel_group: channelGroup,
    p_source_type: sourceType,
  });
  if (error) throw new AbbreviatedTaxInvoiceError(error.message, 409);
  return String(data ?? "").trim();
}

async function buildRoomPreview(
  supabase: SupabaseLike,
  period: AuditPeriodRow
): Promise<AbbreviatedPreviewResponse> {
  const { from: dateFrom, to: dateTo } = monthDateRange(period.year, period.month);
  const auditEntries = await loadAuditEntries(supabase, period.id);
  const entryByReservationId = new Map(auditEntries.map((entry) => [entry.reservation_id, entry]));
  const reservations = await loadReservations(supabase, dateFrom, dateTo, auditEntries);
  const reservationIds = reservations.map((reservation) => reservation.id);
  const nightsByReservationId = groupByReservation(await loadNights(supabase, reservationIds));
  const roomGroupMap = await loadRoomGroupMap(supabase);
  const fullTaxInvoiceByReservationId = await loadIssuedFullTaxCoverageMap(
    supabase as any,
    auditEntries.map((entry) => ({
      ...entry,
      booking_code: null,
      room_number: null,
      room_type_name: null,
      total_nights: 0,
      pos_revenue: 0,
      paid_cash: 0,
      paid_transfer: 0,
      paid_credit_card: 0,
      paid_other: 0,
      total_paid: 0,
      refund_total: 0,
      tax_invoice_requested: false,
      tax_invoice_name: null,
      tax_id: null,
      nationality: null,
      passport_number: null,
      id_card_number: null,
      guest_count: 1,
    }))
  );

  const { data: flagRows, error: flagError } = await supabase
    .from("monthly_audit_channel_flag")
    .select("*")
    .eq("audit_period_id", period.id);
  if (flagError) throw new AbbreviatedTaxInvoiceError(flagError.message, 500);
  const flagByEntryId = new Map<string, ChannelFlagRow>(
    ((flagRows ?? []) as any[]).map((row: any) => [
      String(row.entry_id),
      {
        entry_id: String(row.entry_id),
        actual_channel: normalizeBookingSource(row.actual_channel),
        tax_invoice_channel: normalizeBookingSource(row.tax_invoice_channel),
      },
    ])
  );

  const { data: overrideRows, error: overrideError } = await supabase
    .from("abbreviated_invoice_override")
    .select("*")
    .eq("audit_period_id", period.id);
  if (overrideError) throw new AbbreviatedTaxInvoiceError(overrideError.message, 500);
  const overrideByEntryDate = new Map<string, NightOverrideRow>(
    ((overrideRows ?? []) as any[]).map((row: any) => [
      `${row.entry_id}::${row.night_date}`,
      {
        entry_id: String(row.entry_id),
        night_date: String(row.night_date),
        decision: row.decision as NightOverrideDecision,
      },
    ])
  );

  const { data: shiftRows, error: shiftError } = await supabase
    .from("abbreviated_row_shift_override")
    .select("*")
    .eq("audit_period_id", period.id)
    .order("set_at", { ascending: true });
  if (shiftError) throw new AbbreviatedTaxInvoiceError(shiftError.message, 500);
  const shiftByKey = new Map<string, ShiftOverrideWorkRow[]>();
  for (const row of (shiftRows ?? []) as any[]) {
    if (!isValidTaxGroup(row.tax_group)) continue;
    const item: ShiftOverrideWorkRow = {
      entry_id: String(row.entry_id),
      tax_group: row.tax_group,
      unit_price: round2(Number(row.unit_price ?? 0)),
      original_date: str(row.original_date),
      target_date: str(row.target_date),
      remaining: Math.max(0, Number(row.quantity ?? 0)),
    };
    if (item.remaining <= 0) continue;
    const key = shiftOverrideKey(item.entry_id, item.original_date, item.tax_group, item.unit_price);
    const rows = shiftByKey.get(key) ?? [];
    rows.push(item);
    shiftByKey.set(key, rows);
  }

  const sourceNights: SourceNight[] = [];
  const carried: CarriedFolioInfo[] = [];
  const excluded: ExcludedFolioInfo[] = [];

  for (const reservation of reservations) {
    const entry = entryByReservationId.get(reservation.id);
    if (!entry) continue;

    const entryId = entry?.id ?? reservation.id;
    const guestName = entry?.guest_name || reservation.guest_name;
    const loadedNights = (nightsByReservationId.get(reservation.id) ?? []).sort((a, b) => a.stay_date.localeCompare(b.stay_date));
    if (loadedNights.length === 0) continue;

    if (reservation.is_dayuse) {
      excluded.push({
        entry_id: entryId,
        reservation_id: reservation.id,
        guest_name: guestName,
        reason: "dayuse",
      });
      continue;
    }

    const fullTaxInvoice = fullTaxInvoiceByReservationId.get(reservation.id);
    if (fullTaxInvoice && fullTaxInvoice.residual_amount <= 0) {
      excluded.push({
        entry_id: entryId,
        reservation_id: reservation.id,
        guest_name: guestName,
        reason: "full_tax_invoice_issued",
        full_tax_invoice_id: fullTaxInvoice.id,
      });
      continue;
    }

    const outstanding = entry.outstanding;
    const flag = entry ? flagByEntryId.get(entry.id) : null;
    const actualChannel = normalizeBookingSource(flag?.actual_channel ?? entry?.source ?? reservation.source);
    const taxInvoiceChannel = normalizeBookingSource(flag?.tax_invoice_channel ?? actualChannel);
    const channelGroup = mapActualChannelToGroup(taxInvoiceChannel);
    const checksOutThisMonth = reservation.checkout_date >= dateFrom && reservation.checkout_date <= dateTo;
    const roomAuditTotal = fullTaxInvoice
      ? round2(Math.max(0, fullTaxInvoice.residual_room_revenue))
      : round2(Math.max(0, entry.room_revenue));
    const extraAuditTotal = fullTaxInvoice
      ? round2(Math.max(0, fullTaxInvoice.residual_extra_revenue))
      : round2(Math.max(0, entry.extra_revenue));
    const completedNights = completeChargedReservationNightsFromAuditTotal(
      reservation,
      loadedNights,
      roomAuditTotal,
      entry.refund_total
    );
    const coveredByStayDate = fullTaxInvoice?.covered_room_revenue_by_stay_date ?? {};
    const nights = fullTaxInvoice
      ? applyCoveredRoomRevenueToNights(completedNights, coveredByStayDate)
      : completedNights;

    const includedNights = nights.filter((night) => {
      const override = overrideByEntryDate.get(`${entryId}::${night.stay_date}`);
      if (override?.decision === "include_this_month") return true;
      if (override?.decision === "carry_to_next" || override?.decision === "excluded_full_tax") return false;
      if (outstanding > 0) return false;
      if (checksOutThisMonth) return true;
      return night.stay_date >= dateFrom && night.stay_date <= dateTo;
    });
    const carriedNightDates = nights
      .filter((night) => !includedNights.some((includedNight) => includedNight.id === night.id))
      .map((night) => night.stay_date);

    const carriedCount = nights.length - includedNights.length;
    if (carriedCount > 0) {
      const reason = outstanding > 0 ? "outstanding" : reservation.checkout_date > dateTo ? "cross_month" : "manual";
      carried.push({
        entry_id: entryId,
        reservation_id: reservation.id,
        guest_name: guestName,
        checkin_date: reservation.checkin_date,
        checkout_date: reservation.checkout_date,
        nights_carried: carriedCount,
        night_dates: carriedNightDates,
        reason,
      });
    }

    const allocation = allocateRoomAndExtraAcrossNights({
      roomAuditTotal,
      extraAuditTotal,
      includedNights,
      capRoomToIncludedNightTotal: fullTaxInvoice ? Object.keys(coveredByStayDate).length > 0 : false,
    });
    const auditTotal = round2(allocation.amounts.reduce((sum, amount) => sum + amount, 0));

    if (auditTotal <= 0 || includedNights.length === 0) continue;

    const distributedNightAmounts = allocation.amounts;
    for (const [includedIndex, night] of includedNights.entries()) {
      const roomGroup = night.room_type_code ? roomGroupMap.get(night.room_type_code.toUpperCase()) : null;
      if (!roomGroup) {
        throw new AbbreviatedTaxInvoiceError(
          `Missing tax invoice room group mapping for room type ${night.room_type_code ?? "(unknown)"}.`,
          409
        );
      }

      const unitPrice = distributedNightAmounts[includedIndex] ?? distributeExtra(auditTotal, includedNights.length, includedIndex);
      let issueDate = checksOutThisMonth ? reservation.checkout_date : night.stay_date;
      let shiftedFromDate: string | null = null;
      let shiftSource: "auto" | "manual" | null = null;

      const shiftKey = shiftOverrideKey(entryId, night.stay_date, roomGroup.tax_group, unitPrice);
      const shift = (shiftByKey.get(shiftKey) ?? []).find((row) => row.remaining > 0);
      if (shift) {
        shift.remaining -= 1;
        issueDate = shift.target_date;
        shiftedFromDate = night.stay_date;
        shiftSource = "manual";
      }

      sourceNights.push({
        entry_id: entryId,
        reservation_id: reservation.id,
        guest_name: guestName,
        checkin_date: reservation.checkin_date,
        checkout_date: reservation.checkout_date,
        issue_date: issueDate,
        stay_date: night.stay_date,
        channel_group: channelGroup,
        tax_invoice_channel: taxInvoiceChannel,
        tax_group: roomGroup.tax_group,
        label_th: roomGroup.label_th,
        unit_price: unitPrice,
        amount: unitPrice,
        shifted_from_date: shiftedFromDate,
        shift_source: shiftSource,
      });
    }
  }

  const drafts = assignSequentialInvoiceNumbers(computeAutoShift(buildDraftsFromNights(sourceNights, period)));

  return {
    period: { year: period.year, month: period.month, audit_period_id: period.id },
    drafts,
    carried,
    excluded,
    summary: buildDraftSummary(drafts),
  };
}

async function buildDayUsePreview(
  supabase: SupabaseLike,
  period: AuditPeriodRow
): Promise<AbbreviatedPreviewResponse> {
  const reservations = await loadDayUseReservationsForMonth(supabase, period.year, period.month);
  const reservationIds = reservations.map((reservation) => reservation.id);
  const auditEntries = await loadAuditEntries(supabase, period.id);
  const entryByReservationId = new Map(auditEntries.map((entry) => [entry.reservation_id, entry]));
  const folioByReservationId = groupByReservation(await loadFolioRows(supabase, reservationIds));
  const fullTaxInvoiceByReservationId = await loadIssuedFullTaxReservationIds(supabase, reservationIds);
  const stayRange = computeMonthlyStayRange(period.year, period.month);
  const issueDate = monthIssueDate(period.year, period.month);

  const lineSourceRows: Array<{
    entry_id: string;
    guest_name: string;
    checkin_date: string;
    checkout_date: string;
    unit_price: number;
  }> = [];
  const excluded: ExcludedFolioInfo[] = [];

  for (const reservation of reservations) {
    const entry = entryByReservationId.get(reservation.id);
    const entryId = entry?.id ?? reservation.id;
    const fullTaxInvoiceId = fullTaxInvoiceByReservationId.get(reservation.id);
    if (fullTaxInvoiceId) {
      excluded.push({
        entry_id: entryId,
        reservation_id: reservation.id,
        guest_name: reservation.guest_name,
        reason: "full_tax_invoice_issued",
        full_tax_invoice_id: fullTaxInvoiceId,
      });
      continue;
    }

    const folioRows = folioByReservationId.get(reservation.id) ?? [];
    const dayUseRevenue = round2(
      folioRows.reduce((sum, row) => {
        if (row.is_record_only || row.is_void_reversal || row.is_correction || row.void_of) return sum;
        if (row.tx_type !== "payment" || row.amount <= 0) return sum;
        if (row.revenue_category !== "dayuse_revenue") return sum;
        return sum + row.amount;
      }, 0)
    );

    if (dayUseRevenue <= 0) continue;

    lineSourceRows.push({
      entry_id: entryId,
      guest_name: reservation.guest_name,
      checkin_date: reservation.checkin_date,
      checkout_date: reservation.checkout_date,
      unit_price: dayUseRevenue,
    });
  }

  const lines = buildDayUseLines(lineSourceRows);
  const subtotal = round2(lines.reduce((sum, line) => sum + line.amount, 0));
  const vat = computeVatBreakdown(subtotal);
  const drafts: AbbreviatedInvoiceDraft[] =
    lines.length === 0
      ? []
      : [
          {
            source_type: "dayuse",
            render_mode: "half_a4",
            issue_date: issueDate,
            stay_date_from: stayRange.from,
            stay_date_to: stayRange.to,
            channel_group: null,
            tax_invoice_channel: "walkin",
            predicted_invoice_no: computeAbbreviatedInvoiceNo(issueDate, null, "dayuse"),
            book_no: computeBookNo(issueDate),
            lines,
            subtotal_inc_vat: vat.inc,
            subtotal_ex_vat: vat.ex,
            vat_rate: ABBREVIATED_VAT_RATE,
            vat_amount: vat.vat,
            warning: period.status !== "audited" ? `Audit period is ${period.status}; generation requires audited status.` : undefined,
          },
        ];

  return {
    period: { year: period.year, month: period.month, audit_period_id: period.id },
    drafts,
    carried: [],
    excluded,
    summary: buildDraftSummary(drafts),
  };
}

async function buildPosPreview(
  supabase: SupabaseLike,
  period: AuditPeriodRow
): Promise<AbbreviatedPreviewResponse> {
  const { from: dateFrom, to: dateTo } = monthDateRange(period.year, period.month);
  const days: string[] = [];
  for (let current = dateFrom; current <= dateTo; current = addDays(current, 1)) {
    days.push(current);
  }

  const drafts: AbbreviatedInvoiceDraft[] = [];

  for (const day of days) {
    const rows = await loadPosItemsForDay(supabase, day);
    if (rows.length === 0) continue;

    const grouped = new Map<string, PosItemDraft>();
    for (const row of rows) {
      const key = `${row.product_id}::${row.unit_price.toFixed(2)}`;
      const current = grouped.get(key) ?? {
        product_id: row.product_id,
        label_th: row.label_th,
        quantity: 0,
        unit_price: row.unit_price,
        amount: 0,
        source_order_ids: [],
        source_orders: [],
      };
      current.quantity += row.quantity;
      current.amount = round2(current.amount + row.amount);
      current.source_order_ids = sourceIds([...current.source_order_ids, row.order_id]);
      current.source_orders.push({
        order_id: row.order_id,
        order_number: row.order_number,
        order_date: row.order_date,
        quantity: row.quantity,
      });
      grouped.set(key, current);
    }

    const posItems = Array.from(grouped.values()).sort(
      (a, b) => a.label_th.localeCompare(b.label_th) || a.unit_price - b.unit_price
    );
    const lines = buildPosLines(posItems);
    const subtotal = round2(lines.reduce((sum, line) => sum + line.amount, 0));
    const vat = computeVatBreakdown(subtotal);
    drafts.push({
      source_type: "pos",
      render_mode: "full_a4",
      issue_date: day,
      stay_date_from: day,
      stay_date_to: day,
      channel_group: null,
      tax_invoice_channel: "walkin",
      predicted_invoice_no: computeAbbreviatedInvoiceNo(day, null, "pos"),
      book_no: computeBookNo(day),
      lines,
      pos_items: posItems,
      subtotal_inc_vat: vat.inc,
      subtotal_ex_vat: vat.ex,
      vat_rate: ABBREVIATED_VAT_RATE,
      vat_amount: vat.vat,
      warning: undefined,
    });
  }

  const shiftedDrafts = assignSequentialInvoiceNumbers(computeAutoShift(drafts));
  return {
    period: { year: period.year, month: period.month, audit_period_id: period.id },
    drafts: shiftedDrafts,
    carried: [],
    excluded: [],
    summary: buildDraftSummary(shiftedDrafts),
  };
}

export async function buildPosPreviewForDate(
  supabase: SupabaseLike,
  date: string
): Promise<AbbreviatedPosPreviewResponse> {
  const rows = await loadPosItemsForDay(supabase, date);
  if (rows.length === 0) {
    return {
      date,
      draft: null,
      summary: {
        total_orders: 0,
        total_items: 0,
        grand_total_inc_vat: 0,
        grand_total_ex_vat: 0,
        vat_total: 0,
      },
    };
  }

  const grouped = new Map<string, PosItemDraft>();
  for (const row of rows) {
    const key = `${row.product_id}::${row.unit_price.toFixed(2)}`;
    const current = grouped.get(key) ?? {
      product_id: row.product_id,
      label_th: row.label_th,
      quantity: 0,
      unit_price: row.unit_price,
      amount: 0,
      source_order_ids: [],
      source_orders: [],
    };
    current.quantity += row.quantity;
    current.amount = round2(current.amount + row.amount);
    current.source_order_ids = sourceIds([...current.source_order_ids, row.order_id]);
    current.source_orders.push({
      order_id: row.order_id,
      order_number: row.order_number,
      order_date: row.order_date,
      quantity: row.quantity,
    });
    grouped.set(key, current);
  }

  const posItems = Array.from(grouped.values()).sort(
    (a, b) => a.label_th.localeCompare(b.label_th) || a.unit_price - b.unit_price
  );
  const lines = buildPosLines(posItems);
  const subtotal = round2(lines.reduce((sum, line) => sum + line.amount, 0));
  const vat = computeVatBreakdown(subtotal);
  const draft: AbbreviatedInvoiceDraft = {
    source_type: "pos",
    render_mode: "full_a4",
    issue_date: date,
    stay_date_from: date,
    stay_date_to: date,
    channel_group: null,
    tax_invoice_channel: "walkin",
    predicted_invoice_no: computeAbbreviatedInvoiceNo(date, null, "pos"),
    book_no: computeBookNo(date),
    lines,
    pos_items: posItems,
    subtotal_inc_vat: vat.inc,
    subtotal_ex_vat: vat.ex,
    vat_rate: ABBREVIATED_VAT_RATE,
    vat_amount: vat.vat,
  };

  return {
    date,
    draft,
    summary: {
      total_orders: sourceIds(rows.map((row) => row.order_id)).length,
      total_items: lines.length,
      grand_total_inc_vat: draft.subtotal_inc_vat,
      grand_total_ex_vat: draft.subtotal_ex_vat,
      vat_total: draft.vat_amount,
    },
  };
}

export async function buildAbbreviatedPreview(
  supabase: SupabaseLike,
  year: number,
  month: number,
  source: AbbreviatedSourceType = "room"
): Promise<AbbreviatedPreviewResponse> {
  const period = await loadAuditPeriod(supabase, year, month);
  if (source === "dayuse") return buildDayUsePreview(supabase, period);
  if (source === "pos") return buildPosPreview(supabase, period);
  return buildRoomPreview(supabase, period);
}

function buildPersistedLineRows(invoiceId: string, draft: AbbreviatedInvoiceDraft) {
  return draft.lines.map((line, index) => ({
    invoice_id: invoiceId,
    line_order: index + 1,
    tax_group: line.tax_group,
    label_th: line.label_th,
    quantity: line.quantity,
    unit_price: line.unit_price,
    amount: line.amount,
    source_entry_ids: line.source_entry_ids,
    shifted_from_date: line.shifted_from_date,
    shifted_reason: line.shift_source ? `${line.shift_source}_shift` : null,
  }));
}

async function refreshPersistedAbbreviatedInvoice(
  supabase: SupabaseLike,
  invoiceId: string,
  draft: AbbreviatedInvoiceDraft,
  seller: unknown,
  userId: string | null
) {
  const { error: updateError } = await supabase
    .from("abbreviated_tax_invoice")
    .update({
      invoice_no: draft.predicted_invoice_no,
      source_type: draft.source_type,
      channel_group: draft.channel_group,
      tax_invoice_channel: draft.tax_invoice_channel,
      book_no: draft.book_no,
      stay_date_from: draft.stay_date_from,
      stay_date_to: draft.stay_date_to,
      subtotal_inc_vat: draft.subtotal_inc_vat,
      subtotal_ex_vat: draft.subtotal_ex_vat,
      vat_rate: draft.vat_rate,
      vat_amount: draft.vat_amount,
      seller_snapshot: seller,
      generated_by_user_id: userId,
      generated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);

  if (updateError) throw new AbbreviatedTaxInvoiceError(updateError.message, 500);

  const { error: deleteLineError } = await supabase
    .from("abbreviated_tax_invoice_line")
    .delete()
    .eq("invoice_id", invoiceId);
  if (deleteLineError) throw new AbbreviatedTaxInvoiceError(deleteLineError.message, 500);

  const lineRows = buildPersistedLineRows(invoiceId, draft);
  if (lineRows.length > 0) {
    const { error: insertLineError } = await supabase
      .from("abbreviated_tax_invoice_line")
      .insert(lineRows);
    if (insertLineError) throw new AbbreviatedTaxInvoiceError(insertLineError.message, 500);
  }
}

async function preparePersistedAbbreviatedInvoiceNumbers(
  supabase: SupabaseLike,
  periodId: string,
  sourceType: AbbreviatedSourceType,
  preview: AbbreviatedPreviewResponse
): Promise<string[]> {
  const { data: existingRows, error: existingError } = await supabase
    .from("abbreviated_tax_invoice")
    .select("id, issue_date, source_type, channel_group")
    .eq("audit_period_id", periodId)
    .eq("source_type", sourceType)
    .neq("status", "cancelled");
  if (existingError) throw new AbbreviatedTaxInvoiceError(existingError.message, 500);

  const plan = planAbbreviatedInvoiceRenumbering(
    ((existingRows ?? []) as any[]).map((row) => ({
      id: String(row.id),
      source_type: row.source_type as AbbreviatedSourceType,
      issue_date: String(row.issue_date),
      channel_group: (row.channel_group ?? null) as ChannelGroup | null,
    })),
    preview.drafts
  );

  if (plan.assignments.length === 0 && plan.stale_ids.length === 0) return [];

  const { error: renumberError } = await supabase.rpc("renumber_abbreviated_invoices", {
    p_audit_period_id: periodId,
    p_source_type: sourceType,
    p_assignments: plan.assignments,
    p_stale_ids: plan.stale_ids,
  });
  if (renumberError) throw new AbbreviatedTaxInvoiceError(renumberError.message, 500);

  return plan.stale_ids;
}

export async function generateAbbreviatedInvoices(
  supabase: SupabaseLike,
  year: number,
  month: number,
  userId: string | null,
  sourceType: AbbreviatedSourceType = "room"
): Promise<GenerateResult> {
  const period =
    sourceType === "pos"
      ? await ensureAuditPeriodExists(supabase, year, month)
      : await loadAuditPeriod(supabase, year, month);
  if (sourceType !== "pos" && period.status !== "audited") {
    throw new AbbreviatedTaxInvoiceError("Abbreviated invoices can be generated only after monthly audit is audited.", 409);
  }

  const preview = await buildAbbreviatedPreview(supabase, year, month, sourceType);
  const seller = await getSellerSnapshotFromSettings(supabase as any);
  const invoiceIds: string[] = [];
  const warnings: string[] = [];
  let createdCount = 0;
  let updatedCount = 0;
  let cancelledCount = 0;

  const cancelledInvoiceIds = await preparePersistedAbbreviatedInvoiceNumbers(
    supabase,
    period.id,
    sourceType,
    preview
  );
  cancelledCount = cancelledInvoiceIds.length;

  for (const draft of preview.drafts) {
    let existingQuery = supabase
      .from("abbreviated_tax_invoice")
      .select("id, invoice_no")
      .eq("source_type", draft.source_type)
      .neq("status", "cancelled");

    if (draft.source_type === "room") {
      existingQuery = existingQuery
        .eq("audit_period_id", period.id)
        .eq("issue_date", draft.issue_date)
        .eq("channel_group", draft.channel_group);
    } else if (draft.source_type === "dayuse") {
      existingQuery = existingQuery.eq("audit_period_id", period.id);
    } else {
      existingQuery = existingQuery.eq("issue_date", draft.issue_date);
    }

    const { data: existing, error: existingError } = await existingQuery.maybeSingle();

    if (existingError) throw new AbbreviatedTaxInvoiceError(existingError.message, 500);
    if (existing) {
      const invoiceId = String((existing as any).id);
      await refreshPersistedAbbreviatedInvoice(supabase, invoiceId, draft, seller, userId);
      invoiceIds.push(invoiceId);
      updatedCount += 1;
      warnings.push(`Updated existing invoice ${(existing as any).invoice_no}.`);
      continue;
    }

    const invoiceNo = draft.predicted_invoice_no || await getNextInvoiceNumber(supabase, draft.issue_date, draft.source_type, draft.channel_group);
    const { data: invoice, error: invoiceError } = await supabase
      .from("abbreviated_tax_invoice")
      .insert({
        invoice_no: invoiceNo,
        book_no: draft.book_no,
        issue_date: draft.issue_date,
        source_type: draft.source_type,
        channel_group: draft.channel_group,
        tax_invoice_channel: draft.tax_invoice_channel,
        audit_period_id: period.id,
        stay_date_from: draft.stay_date_from,
        stay_date_to: draft.stay_date_to,
        subtotal_inc_vat: draft.subtotal_inc_vat,
        subtotal_ex_vat: draft.subtotal_ex_vat,
        vat_rate: draft.vat_rate,
        vat_amount: draft.vat_amount,
        seller_snapshot: seller,
        status: "issued",
        generated_by_user_id: userId,
      })
      .select("id")
      .single();

    if (invoiceError) throw new AbbreviatedTaxInvoiceError(invoiceError.message, 500);
    const invoiceId = String((invoice as any).id);

    const lineRows = buildPersistedLineRows(invoiceId, draft);

    if (lineRows.length > 0) {
      const { error: lineError } = await supabase.from("abbreviated_tax_invoice_line").insert(lineRows);
      if (lineError) throw new AbbreviatedTaxInvoiceError(lineError.message, 500);
    }

    createdCount += 1;
    invoiceIds.push(invoiceId);
  }

  if (cancelledCount > 0) warnings.push(`Cancelled ${cancelledCount} stale invoice(s) without current draft.`);

  return {
    invoices_created: createdCount,
    invoices_updated: updatedCount,
    invoices_cancelled: cancelledCount,
    invoice_ids: invoiceIds,
    warnings,
  };
}

export async function recalculateAbbreviated(
  supabase: SupabaseLike,
  auditPeriodId: string,
  _userId: string | null,
  sourceType: AbbreviatedSourceType = "room"
): Promise<RecalculateResult> {
  const { data: period, error } = await supabase
    .from("monthly_audit_periods")
    .select("id, year, month, status")
    .eq("id", auditPeriodId)
    .maybeSingle();
  if (error) throw new AbbreviatedTaxInvoiceError(error.message, 500);
  if (!period) throw new AbbreviatedTaxInvoiceError("Audit period not found.", 404);

  const preview = await buildAbbreviatedPreview(
    supabase,
    Number((period as any).year),
    Number((period as any).month),
    sourceType
  );
  const seller = await getSellerSnapshotFromSettings(supabase as any);
  const changedInvoiceIds: string[] = [];

  const cancelledInvoiceIds = await preparePersistedAbbreviatedInvoiceNumbers(
    supabase,
    String((period as any).id),
    sourceType,
    preview
  );

  for (const draft of preview.drafts) {
    let existingQuery = supabase
      .from("abbreviated_tax_invoice")
      .select("id")
      .eq("source_type", draft.source_type)
      .neq("status", "cancelled");

    if (draft.source_type === "room") {
      existingQuery = existingQuery
        .eq("audit_period_id", auditPeriodId)
        .eq("issue_date", draft.issue_date)
        .eq("channel_group", draft.channel_group);
    } else if (draft.source_type === "dayuse") {
      existingQuery = existingQuery.eq("audit_period_id", auditPeriodId);
    } else {
      existingQuery = existingQuery.eq("issue_date", draft.issue_date);
    }

    const { data: existing, error: existingError } = await existingQuery.maybeSingle();

    if (existingError) throw new AbbreviatedTaxInvoiceError(existingError.message, 500);
    if (!existing) continue;

    const invoiceId = String((existing as any).id);
    await refreshPersistedAbbreviatedInvoice(supabase, invoiceId, draft, seller, _userId);

    changedInvoiceIds.push(invoiceId);
  }

  const { data: existingRows, error: existingError } = await supabase
    .from("abbreviated_tax_invoice")
    .select("id")
    .eq("audit_period_id", auditPeriodId)
    .eq("source_type", sourceType)
    .neq("status", "cancelled");
  if (existingError) throw new AbbreviatedTaxInvoiceError(existingError.message, 500);

  const existingIds = new Set(((existingRows ?? []) as any[]).map((row) => String(row.id)));

  return {
    drafts_changed: preview.drafts.length,
    new_total_inc_vat: preview.summary.grand_total_inc_vat,
    changed_invoice_ids: changedInvoiceIds.filter((id) => existingIds.has(id)),
    cancelled_invoice_ids: cancelledInvoiceIds,
  };
}

export async function shiftRow(
  supabase: SupabaseLike,
  input: RowShiftInput,
  userId: string | null
) {
  const [row] = await shiftRows(supabase, { shifts: [input] }, userId);
  return row;
}

export async function shiftRows(
  supabase: SupabaseLike,
  input: RowShiftBatchInput,
  userId: string | null
) {
  if (input.shifts.length === 0) {
    throw new AbbreviatedTaxInvoiceError("At least one row shift is required.", 400);
  }

  const entryIds = sourceIds(input.shifts.map((shift) => shift.entry_id));
  const { data: entries, error: entryError } = await supabase
    .from("monthly_audit_entries")
    .select("id, period_id")
    .in("id", entryIds);
  if (entryError) throw new AbbreviatedTaxInvoiceError(entryError.message, 500);
  const periodByEntryId = new Map<string, string>(
    ((entries ?? []) as any[]).map((entry) => [String(entry.id), String(entry.period_id)])
  );
  if (periodByEntryId.size !== entryIds.length) {
    throw new AbbreviatedTaxInvoiceError("Monthly audit entry not found.", 404);
  }

  const periodIds = sourceIds(Array.from(periodByEntryId.values()));
  if (periodIds.length !== 1) {
    throw new AbbreviatedTaxInvoiceError("All row shifts must belong to the same audit period.", 400);
  }

  const rows = input.shifts.map((shift) => ({
    audit_period_id: periodByEntryId.get(shift.entry_id),
    entry_id: shift.entry_id,
    tax_group: shift.tax_group,
    unit_price: shift.unit_price,
    quantity: shift.quantity,
    original_date: shift.original_date,
    target_date: shift.target_date,
    reason: shift.reason ?? null,
    set_by_user_id: userId,
  }));

  const { data, error } = await supabase
    .from("abbreviated_row_shift_override")
    .insert(rows)
    .select("*")
    .order("set_at", { ascending: true });
  if (error) throw new AbbreviatedTaxInvoiceError(error.message, 500);
  return data ?? [];
}

export async function shiftGeneratedLine(
  supabase: SupabaseLike,
  lineId: string,
  targetDate: string,
  userId: string | null
) {
  const { data: line, error: lineError } = await supabase
    .from("abbreviated_tax_invoice_line")
    .select("*, abbreviated_tax_invoice!inner(id, audit_period_id, issue_date, channel_group, status)")
    .eq("id", lineId)
    .maybeSingle();
  if (lineError) throw new AbbreviatedTaxInvoiceError(lineError.message, 500);
  if (!line) throw new AbbreviatedTaxInvoiceError("Invoice line not found.", 404);

  const invoice = Array.isArray((line as any).abbreviated_tax_invoice)
    ? (line as any).abbreviated_tax_invoice[0]
    : (line as any).abbreviated_tax_invoice;
  if (String(invoice?.status) === "cancelled") {
    throw new AbbreviatedTaxInvoiceError("Cannot shift a cancelled invoice line.", 409);
  }

  const { data: target, error: targetError } = await supabase
    .from("abbreviated_tax_invoice")
    .select("id")
    .eq("audit_period_id", String(invoice.audit_period_id))
    .eq("issue_date", targetDate)
    .eq("channel_group", String(invoice.channel_group))
    .neq("status", "cancelled")
    .maybeSingle();
  if (targetError) throw new AbbreviatedTaxInvoiceError(targetError.message, 500);
  if (!target) throw new AbbreviatedTaxInvoiceError("Target invoice for this date/channel does not exist.", 404);

  const { data, error } = await supabase
    .from("abbreviated_tax_invoice_line")
    .update({
      invoice_id: String((target as any).id),
      shifted_from_date: String(invoice.issue_date),
      shifted_reason: `manual_post_generate:${userId ?? "unknown"}`,
    })
    .eq("id", lineId)
    .select("*")
    .single();
  if (error) throw new AbbreviatedTaxInvoiceError(error.message, 500);
  return data;
}

export async function setNightOverride(
  supabase: SupabaseLike,
  params: {
    entryId: string;
    nightDate: string;
    decision: NightOverrideDecision;
    reason?: string | null;
    userId: string | null;
  }
) {
  const { data: entry, error: entryError } = await supabase
    .from("monthly_audit_entries")
    .select("id, period_id")
    .eq("id", params.entryId)
    .maybeSingle();
  if (entryError) throw new AbbreviatedTaxInvoiceError(entryError.message, 500);
  if (!entry) throw new AbbreviatedTaxInvoiceError("Monthly audit entry not found.", 404);

  const { data, error } = await supabase
    .from("abbreviated_invoice_override")
    .upsert(
      {
        audit_period_id: String((entry as any).period_id),
        entry_id: params.entryId,
        night_date: params.nightDate,
        decision: params.decision,
        reason: params.reason ?? null,
        set_by_user_id: params.userId,
        set_at: new Date().toISOString(),
      },
      { onConflict: "entry_id,night_date" }
    )
    .select("*")
    .single();
  if (error) throw new AbbreviatedTaxInvoiceError(error.message, 500);
  return data;
}

export async function setNightOverridesBatch(
  supabase: SupabaseLike,
  params: {
    entryId: string;
    nights: {
      date: string;
      decision: NightOverrideDecision;
      reason?: string | null;
    }[];
    userId: string | null;
  }
) {
  if (params.nights.length === 0) {
    throw new AbbreviatedTaxInvoiceError("At least one night override is required.", 400);
  }

  const { data: entry, error: entryError } = await supabase
    .from("monthly_audit_entries")
    .select("id, period_id")
    .eq("id", params.entryId)
    .maybeSingle();
  if (entryError) throw new AbbreviatedTaxInvoiceError(entryError.message, 500);
  if (!entry) throw new AbbreviatedTaxInvoiceError("Monthly audit entry not found.", 404);

  const rows = params.nights.map((night) => ({
    audit_period_id: String((entry as any).period_id),
    entry_id: params.entryId,
    night_date: night.date,
    decision: night.decision,
    reason: night.reason ?? null,
    set_by_user_id: params.userId,
    set_at: new Date().toISOString(),
  }));

  const { data, error } = await supabase
    .from("abbreviated_invoice_override")
    .upsert(rows, { onConflict: "entry_id,night_date" })
    .select("*")
    .order("night_date", { ascending: true });
  if (error) throw new AbbreviatedTaxInvoiceError(error.message, 500);
  return data ?? [];
}
