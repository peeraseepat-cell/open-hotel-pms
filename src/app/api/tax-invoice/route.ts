import { compareInvoiceListNewestFirst } from "./list-order";
import { fetchAllRowsComplete } from "@/lib/complete-fetch";
import { getAuthenticatedUser } from "@/lib/server-auth";
import { getUserRole } from "@/lib/server-auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  prepareCoverageLineItems,
  TaxInvoiceCoverageError,
} from "@/lib/tax-invoice/coverage";
import { collectFullyCoveredReservationIds } from "@/lib/tax-invoice/pending-fully-covered";
import type { TaxInvoiceKind, TaxInvoiceLanguage } from "@/lib/tax-invoice/types";
import {
  buildLineItemsForReservation,
  buildLineItemsForReservations,
  assertReservationsCanCombine,
  canFoEditInvoiceByBusinessDate,
  extractReservationIdsFromBookingSnapshot,
  getBusinessDateFromSettings,
  getSellerSnapshotFromSettings,
  isAdminRole,
  loadReservationInvoiceContexts,
  loadReservationInvoiceContext,
  sanitizeLineItems,
  TaxInvoiceError,
  totalsFromLineItems,
  upsertGuestTaxProfile,
} from "@/lib/tax-invoice/service";
import { normalizeMoney, round2, toBangkokDate } from "@/lib/tax-invoice/utils";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseBooleanParam(value: string | null, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

const listQuerySchema = z.object({
  date_from: z.string().regex(DATE_RE).optional(),
  date_to: z.string().regex(DATE_RE).optional(),
  status: z.enum(["draft", "issued", "cancelled"]).optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(200).optional().default(50),
  include_pending: z.boolean().optional().default(true),
  include_cancelled: z.boolean().optional().default(false),
});

const createSchema = z.object({
  reservation_id: z.string().uuid(),
  reservation_ids: z.array(z.string().uuid()).optional(),
  invoice_kind: z.enum(["standard", "prepayment", "balance"]).optional().default("standard"),
  split_group_id: z.string().uuid().optional().nullable(),
  coverage_amount: z.coerce.number().min(0).max(100000000).optional().nullable(),
  coverage_note: z.string().trim().max(500).optional().nullable(),
  manual_issue_date_reason: z.string().trim().max(1000).optional().nullable(),
  language: z.enum(["th", "en"]).optional().default("th"),
  issue_date: z.string().regex(DATE_RE).optional(),
  discount: z.coerce.number().min(0).max(100000000).optional().default(0),
  customer_name: z.string().trim().min(1).max(255).optional(),
  customer_tax_id: z.string().trim().max(30).optional().nullable(),
  customer_address: z.string().trim().max(2000).optional().nullable(),
  customer_branch: z.string().trim().max(255).optional().nullable(),
  remark: z.string().trim().max(2000).optional().nullable(),
  is_passport: z.boolean().optional().default(false),
  guest_tax_profile_id: z.string().uuid().optional().nullable(),
  line_items: z.array(z.unknown()).optional(),
  save_customer_profile: z.boolean().optional().default(true),
  customer_is_default: z.boolean().optional().default(false),
});

type InvoiceRow = {
  id: string;
  invoice_no: string | null;
  cancelled_invoice_no?: string | null;
  reservation_id: string;
  booking_snapshot?: unknown;
  status: "draft" | "issued" | "cancelled";
  issue_date: string;
  customer_name: string;
  customer_tax_id: string | null;
  remark?: string | null;
  grand_total: number | string;
  invoice_kind?: TaxInvoiceKind | null;
  split_group_id?: string | null;
  coverage_amount?: number | string | null;
  coverage_note?: string | null;
  manual_issue_date_reason?: string | null;
  update_reason?: string | null;
  language?: TaxInvoiceLanguage;
  created_at: string;
  updated_at: string;
};

type ReservationMetaRow = {
  id: string;
  booking_code: string | null;
  guest_name: string | null;
  source: string | null;
  status: string | null;
  checkin_date: string | null;
  checkout_date: string | null;
  tax_invoice_requested: boolean | null;
  booking_group_id?: string | null;
};

function isMissingRelationError(error: { message?: string | null; code?: string | null } | null | undefined, relationName: string): boolean {
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes(`relation "${relationName.toLowerCase()}" does not exist`) ||
    message.includes(`relation '${relationName.toLowerCase()}' does not exist`) ||
    (error?.code === "42P01" && message.includes(relationName.toLowerCase()))
  );
}

function strOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function normalizeTaxIdOrNull(value: unknown, isPassport = false): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (isPassport) return text; // Accept any non-empty string for passport
  const digits = text.replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (!/^\d{13}$/.test(digits)) {
    throw new TaxInvoiceError("customer_tax_id must contain 13 digits.", 400);
  }
  return digits;
}

function toInvoiceListItem(row: InvoiceRow, reservation: ReservationMetaRow | null) {
  return {
    id: String(row.id),
    invoice_no: strOrNull(row.invoice_no ?? row.cancelled_invoice_no),
    reservation_id: String(row.reservation_id),
    status: row.status,
    issue_date: String(row.issue_date),
    customer_name: String(row.customer_name ?? ""),
    customer_tax_id: strOrNull(row.customer_tax_id),
    grand_total: round2(normalizeMoney(row.grand_total)),
    invoice_kind: normalizeInvoiceKind(row.invoice_kind),
    split_group_id: strOrNull(row.split_group_id),
    coverage_amount: row.coverage_amount !== undefined ? round2(normalizeMoney(row.coverage_amount)) : null,
    coverage_note: strOrNull(row.coverage_note),
    manual_issue_date_reason: strOrNull(row.manual_issue_date_reason),
    language: row.language === "en" ? "en" : "th",
    update_reason: strOrNull(row.update_reason),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    reservation: reservation
      ? {
          id: reservation.id,
          booking_code: reservation.booking_code,
          guest_name: reservation.guest_name,
          source: reservation.source,
          status: reservation.status,
          checkin_date: reservation.checkin_date,
          checkout_date: reservation.checkout_date,
          tax_invoice_requested: Boolean(reservation.tax_invoice_requested),
        }
      : null,
  };
}

function normalizeReservationIds(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

function normalizeInvoiceKind(value: unknown): TaxInvoiceKind {
  const kind = String(value ?? "standard").trim().toLowerCase();
  return kind === "prepayment" || kind === "balance" ? kind : "standard";
}

function invoiceCoverageAmount(row: Record<string, unknown>): number {
  return round2(normalizeMoney(row.coverage_amount ?? row.grand_total ?? 0));
}

function invoiceRowsOverlap(row: Record<string, unknown>, reservationIds: string[]): boolean {
  const existingReservationIds = extractReservationIdsFromBookingSnapshot(row.booking_snapshot, row.reservation_id as string | null);
  return existingReservationIds.some((reservationId) => reservationIds.includes(reservationId));
}

function compareRowRooms(left: string[], right: string[]): number {
  return left.join(",").localeCompare(right.join(","), undefined, { numeric: true, sensitivity: "base" });
}

export async function GET(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const user = await getAuthenticatedUser(supabase, request);
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    const viewerRole = await getUserRole(supabase, user.id).catch(() => null);
    const viewerIsAdmin = isAdminRole(viewerRole);
    const businessDate = await getBusinessDateFromSettings(supabase);

    const parsed = listQuerySchema.safeParse({
      date_from: request.nextUrl.searchParams.get("date_from") ?? undefined,
      date_to: request.nextUrl.searchParams.get("date_to") ?? undefined,
      status: request.nextUrl.searchParams.get("status") ?? undefined,
      search: request.nextUrl.searchParams.get("search") ?? undefined,
      page: request.nextUrl.searchParams.get("page") ?? undefined,
      per_page: request.nextUrl.searchParams.get("per_page") ?? undefined,
      include_pending: parseBooleanParam(request.nextUrl.searchParams.get("include_pending"), true),
      include_cancelled: parseBooleanParam(request.nextUrl.searchParams.get("include_cancelled"), false),
    });

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid query.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const queryInput = parsed.data;
    const dateFrom = queryInput.date_from ?? "2025-01-01";
    const dateTo = queryInput.date_to ?? "2099-12-31";

    if (dateFrom > dateTo) {
      return NextResponse.json(
        { success: false, error: "date_from must be <= date_to." },
        { status: 400 }
      );
    }

    // Rebuilt per page: a PostgREST builder cannot be re-ranged once awaited.
    const buildInvoiceQuery = () => {
      let invoiceQuery = supabase
        .from("invoices")
        .select("id, invoice_no, cancelled_invoice_no, reservation_id, status, issue_date, language, customer_name, customer_tax_id, grand_total, invoice_kind, split_group_id, coverage_amount, coverage_note, manual_issue_date_reason, update_reason, created_at, updated_at, booking_snapshot", { count: "exact" })
        .gte("issue_date", dateFrom)
        .lte("issue_date", dateTo);

      if (queryInput.status) {
        invoiceQuery = invoiceQuery.eq("status", queryInput.status);
      }
      if (!viewerIsAdmin || !queryInput.include_cancelled) {
        invoiceQuery = invoiceQuery.neq("status", "cancelled");
      }
      return invoiceQuery;
    };

    let invoiceRowsRaw: any[] = [];
    try {
      invoiceRowsRaw = await fetchAllRowsComplete<any>(buildInvoiceQuery, { label: "invoices" });
    } catch (error) {
      const raw = ((error as { cause?: { message?: string | null; code?: string | null } }).cause ?? {
        message: error instanceof Error ? error.message : String(error),
      }) as { message?: string | null; code?: string | null };
      if (!isMissingRelationError(raw, "invoices")) {
        return NextResponse.json(
          { success: false, error: raw.message ?? "Failed to load invoices." },
          { status: 500 }
        );
      }
    }

    // The pager orders by its keyset cursor (`id`), so the list order this
    // endpoint has always returned is restored here. This one IS the response
    // order — `listRows` is built by mapping `invoiceRows` straight through — so
    // dropping it would silently reorder the invoice list in the UI.
    // The comparator lives in ./list-order.ts so the ORDER is testable against
    // fixtures (list-order.test.mts). As an inline arrow the only thing a contract
    // test could assert was that both sides of each key appeared in its body, which
    // Review mutants walked straight through: flipping issue_date left the full
    // suite green.
    const invoiceRows = ((invoiceRowsRaw ?? []) as InvoiceRow[]).sort(compareInvoiceListNewestFirst);
    const reservationIds = Array.from(new Set(invoiceRows.map((row) => String(row.reservation_id))))
      .filter(Boolean);

    const reservationMap = new Map<string, ReservationMetaRow>();
    if (reservationIds.length > 0) {
      const { data: reservationRows, error: reservationError } = await supabase
        .from("reservations")
        .select("id, booking_code, guest_name, source, status, checkin_date, checkout_date, tax_invoice_requested, booking_group_id")
        .in("id", reservationIds);

      if (reservationError) {
        return NextResponse.json({ success: false, error: reservationError.message }, { status: 500 });
      }

      (reservationRows ?? []).forEach((row: any) => {
        reservationMap.set(String(row.id), {
          id: String(row.id),
          booking_code: strOrNull(row.booking_code),
          guest_name: strOrNull(row.guest_name),
          source: strOrNull(row.source),
          status: strOrNull(row.status),
          checkin_date: strOrNull(row.checkin_date),
          checkout_date: strOrNull(row.checkout_date),
          tax_invoice_requested: Boolean(row.tax_invoice_requested ?? false),
          booking_group_id: strOrNull(row.booking_group_id),
        });
      });
    }

    const numberedRows = invoiceRows.filter((row) => strOrNull(row.invoice_no));
    const latestIssuedNumberedInvoiceId = numberedRows
      .sort((a, b) => String(b.invoice_no ?? "").localeCompare(String(a.invoice_no ?? ""), undefined, { numeric: true, sensitivity: "base" }))[0]
      ?.id ?? null;

    let editedInvoiceIds = new Set<string>();
    if (viewerIsAdmin && invoiceRows.length > 0) {
      const { data: auditRows, error: auditError } = await supabase
        .from("audit_logs")
        .select("entity_id")
        .eq("entity_type", "tax_invoice")
        .eq("action", "tax_invoice_updated")
        .in("entity_id", invoiceRows.map((row) => String(row.id)));

      if (!auditError) {
        editedInvoiceIds = new Set((auditRows ?? []).map((row: any) => String(row.entity_id)));
      }
    }

    const listRows = invoiceRows.map((row) => ({
      ...toInvoiceListItem(row, reservationMap.get(String(row.reservation_id)) ?? null),
      can_edit:
        row.status !== "cancelled" &&
        (viewerIsAdmin ||
          canFoEditInvoiceByBusinessDate(
            businessDate,
            reservationMap.get(String(row.reservation_id))?.checkout_date ?? null
          )),
      can_reuse_invoice_no:
        row.status === "issued" &&
        Boolean(strOrNull(row.invoice_no)) &&
        String(row.id) === latestIssuedNumberedInvoiceId,
      has_edit_log: Boolean(strOrNull(row.update_reason)) || editedInvoiceIds.has(String(row.id)),
    }));

    const search = String(queryInput.search ?? "").trim().toLowerCase();
    const searched = search
      ? listRows.filter((row) => {
          const bag = [
            row.invoice_no ?? "",
            row.customer_name,
            row.customer_tax_id ?? "",
            row.reservation?.booking_code ?? "",
            row.reservation?.guest_name ?? "",
          ]
            .join(" ")
            .toLowerCase();
          return bag.includes(search);
        })
      : listRows;

    const page = queryInput.page;
    const perPage = queryInput.per_page;
    const total = searched.length;
    const offset = (page - 1) * perPage;
    const data = searched.slice(offset, offset + perPage);

    let pendingReservations: Array<Record<string, unknown>> = [];
    if (queryInput.include_pending) {
      let pendingRows: any[];
      try {
        pendingRows = await fetchAllRowsComplete<any>(
          () =>
            supabase
              .from("reservations")
              .select(
                "id, booking_code, guest_name, source, status, checkin_date, checkout_date, tax_invoice_requested, total_price, booking_group_id",
                { count: "exact" }
              )
              .eq("tax_invoice_requested", true)
              .neq("status", "cancelled"),
          { label: "pending tax-invoice reservations" }
        );
      } catch (error) {
        return NextResponse.json(
          { success: false, error: error instanceof Error ? error.message : String(error) },
          { status: 500 }
        );
      }

      // A missing `invoices` relation stays tolerated, as before — but a
      // truncated or failed read must not silently widen the pending list.
      let issuedRows: any[] = [];
      try {
        issuedRows = await fetchAllRowsComplete<any>(
          () =>
            supabase
              .from("invoices")
              .select("id, reservation_id, booking_snapshot, invoice_kind, coverage_amount, grand_total", { count: "exact" })
              .eq("status", "issued"),
          { label: "issued invoices" }
        );
      } catch (error) {
        const raw = ((error as { cause?: { message?: string | null; code?: string | null } }).cause ?? {
          message: error instanceof Error ? error.message : String(error),
        }) as { message?: string | null; code?: string | null };
        if (!isMissingRelationError(raw, "invoices")) {
          return NextResponse.json(
            { success: false, error: raw.message ?? "Failed to load issued invoices." },
            { status: 500 }
          );
        }
      }

      const fullyCoveredSet = collectFullyCoveredReservationIds(issuedRows ?? []);
      const pendingFiltered = (pendingRows ?? []).filter((row: any) => !fullyCoveredSet.has(String(row.id)));
      const pendingIds = pendingFiltered.map((row: any) => String(row.id));

      const roomNumbersByReservation = new Map<string, string[]>();
      if (pendingIds.length > 0) {
        const { data: nightRows, error: nightError } = await supabase
          .from("reservation_nights")
          .select("reservation_id, rooms:room_id(room_number)")
          .in("reservation_id", pendingIds)
          .is("cancelled_at", null);

        if (nightError) {
          return NextResponse.json({ success: false, error: nightError.message }, { status: 500 });
        }

        (nightRows ?? []).forEach((row: any) => {
          const reservationId = String(row.reservation_id ?? "");
          if (!reservationId) return;
          const roomRef = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
          const roomNumber = strOrNull(roomRef?.room_number);
          if (!roomNumber) return;
          const current = roomNumbersByReservation.get(reservationId) ?? [];
          if (!current.includes(roomNumber)) current.push(roomNumber);
          roomNumbersByReservation.set(reservationId, current);
        });
      }

      const pendingBaseRows = pendingFiltered.map((row: any) => {
        const reservationId = String(row.id);
        const roomNumbers = (roomNumbersByReservation.get(reservationId) ?? []).sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
        );

        return {
          id: reservationId,
          reservation_id: reservationId,
          reservation_ids: [reservationId],
          booking_code: strOrNull(row.booking_code),
          guest_name: strOrNull(row.guest_name),
          source: strOrNull(row.source),
          status: strOrNull(row.status),
          checkin_date: strOrNull(row.checkin_date),
          checkout_date: strOrNull(row.checkout_date),
          tax_invoice_requested: Boolean(row.tax_invoice_requested ?? false),
          total_amount: round2(normalizeMoney(row.total_price)),
          room_numbers: roomNumbers,
          booking_group_id: strOrNull(row.booking_group_id),
          member_reservations: [
            {
              reservation_id: reservationId,
              booking_code: strOrNull(row.booking_code),
              guest_name: strOrNull(row.guest_name),
              room_numbers: roomNumbers,
              total_amount: round2(normalizeMoney(row.total_price)),
            },
          ],
          combine_eligible: false,
        };
      });

      const groups = new Map<string, typeof pendingBaseRows>();
      const standaloneRows: typeof pendingBaseRows = [];

      for (const row of pendingBaseRows) {
        if (!row.booking_group_id) {
          standaloneRows.push(row);
          continue;
        }
        const current = groups.get(row.booking_group_id) ?? [];
        current.push(row);
        groups.set(row.booking_group_id, current);
      }

      pendingReservations = [...standaloneRows];
      groups.forEach((groupRows) => {
        const sameStayWindow = new Set(groupRows.map((row) => `${row.checkin_date}|${row.checkout_date}`)).size === 1;
        if (groupRows.length <= 1 || !sameStayWindow) {
          pendingReservations.push(...groupRows);
          return;
        }

        const sortedGroupRows = [...groupRows].sort((a, b) => compareRowRooms(a.room_numbers, b.room_numbers));
        pendingReservations.push({
          id: sortedGroupRows[0].reservation_id,
          reservation_id: sortedGroupRows[0].reservation_id,
          reservation_ids: sortedGroupRows.map((row) => row.reservation_id),
          booking_code: sortedGroupRows.map((row) => row.booking_code).filter(Boolean).join(", "),
          guest_name: sortedGroupRows[0].guest_name,
          source: sortedGroupRows[0].source,
          status: sortedGroupRows[0].status,
          checkin_date: sortedGroupRows[0].checkin_date,
          checkout_date: sortedGroupRows[0].checkout_date,
          tax_invoice_requested: true,
          total_amount: round2(sortedGroupRows.reduce((sum, row) => sum + normalizeMoney(row.total_amount), 0)),
          room_numbers: Array.from(new Set(sortedGroupRows.flatMap((row) => row.room_numbers))).sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
          ),
          booking_group_id: sortedGroupRows[0].booking_group_id,
          member_reservations: sortedGroupRows.map((row) => row.member_reservations[0]),
          combine_eligible: true,
        });
      });

      pendingReservations.sort((a, b) => String(a.checkout_date ?? "").localeCompare(String(b.checkout_date ?? "")) || compareRowRooms(a.room_numbers as string[], b.room_numbers as string[]));
    }

    return NextResponse.json({
      success: true,
      data,
      items: data,
      pending_reservations: pendingReservations,
      viewer_role: viewerRole,
      viewer_is_admin: viewerIsAdmin,
      viewer_business_date: businessDate,
      pagination: {
        page,
        per_page: perPage,
        total,
        total_pages: total > 0 ? Math.ceil(total / perPage) : 0,
      },
    });
  } catch (err) {
    if (err instanceof TaxInvoiceCoverageError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    if (err instanceof TaxInvoiceError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const user = await getAuthenticatedUser(supabase, request);
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    const viewerRole = await getUserRole(supabase, user.id).catch(() => null);
    const viewerIsAdmin = isAdminRole(viewerRole);

    const body = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const input = parsed.data;
    const invoiceKind = normalizeInvoiceKind(input.invoice_kind);
    if (invoiceKind !== "standard" && !viewerIsAdmin) {
      return NextResponse.json(
        { success: false, error: "Only admin can create split/prepayment tax invoices." },
        { status: 403 }
      );
    }
    if (invoiceKind !== "standard" && input.issue_date && !strOrNull(input.manual_issue_date_reason)) {
      return NextResponse.json(
        { success: false, error: "manual_issue_date_reason is required for split invoice manual issue dates." },
        { status: 400 }
      );
    }
    const reservationIds = normalizeReservationIds([input.reservation_id, ...(input.reservation_ids ?? [])]);
    const reservations = reservationIds.length > 1
      ? await loadReservationInvoiceContexts(supabase, reservationIds)
      : [await loadReservationInvoiceContext(supabase, input.reservation_id)];
    const reservation = reservations[0];

    if (reservationIds.length > 1) {
      assertReservationsCanCombine(reservations);
    } else if (!reservation.tax_invoice_requested) {
      return NextResponse.json(
        { success: false, error: "Tax invoice is not requested for this reservation." },
        { status: 400 }
      );
    }

    let existingRows: any[];
    try {
      existingRows = await fetchAllRowsComplete<any>(
        () =>
          supabase
            .from("invoices")
            .select(
              "id, invoice_no, reservation_id, status, booking_snapshot, invoice_kind, split_group_id, coverage_amount, grand_total",
              { count: "exact" }
            )
            .neq("status", "cancelled"),
        { label: "existing invoices" }
      );
    } catch (error) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }

    const overlappingExistingRows = ((existingRows ?? []) as Array<Record<string, unknown>>)
      .filter((row) => invoiceRowsOverlap(row, reservationIds));
    const overlappingIssuedRows = overlappingExistingRows.filter((row) => row.status === "issued");

    const standardOrBalanceIssued = overlappingIssuedRows.find(
      (row) => normalizeInvoiceKind(row.invoice_kind) !== "prepayment"
    );
    if (invoiceKind === "standard" && overlappingIssuedRows.length > 0) {
      const issuedExists = overlappingIssuedRows[0] as any;
      return NextResponse.json(
        {
          success: false,
          error: "One or more selected reservations already have an issued invoice.",
          issued_invoice_id: issuedExists.id,
          issued_invoice_no: issuedExists.invoice_no,
        },
        { status: 409 }
      );
    }

    if (invoiceKind !== "standard" && standardOrBalanceIssued) {
      return NextResponse.json(
        {
          success: false,
          error: "One or more selected reservations already have a full/balance issued invoice.",
          issued_invoice_id: standardOrBalanceIssued.id,
          issued_invoice_no: standardOrBalanceIssued.invoice_no,
        },
        { status: 409 }
      );
    }

    const built = reservationIds.length > 1
      ? await buildLineItemsForReservations(supabase, reservationIds)
      : await buildLineItemsForReservation(supabase, input.reservation_id);
    const baseLineItems = input.line_items ? sanitizeLineItems(input.line_items) : built.line_items;
    if (baseLineItems.length === 0) {
      return NextResponse.json({ success: false, error: "Line items cannot be empty." }, { status: 400 });
    }

    let splitGroupId = strOrNull(input.split_group_id);
    let alreadyCoveredAmount = 0;
    if (invoiceKind === "prepayment") {
      const existingBalance = overlappingExistingRows.find(
        (row) => normalizeInvoiceKind(row.invoice_kind) === "balance"
      );
      if (existingBalance) {
        return NextResponse.json(
          {
            success: false,
            error: "This reservation already has an active balance invoice.",
            existing_invoice: existingBalance,
          },
          { status: 409 }
        );
      }
      const existingPrepayment = overlappingExistingRows.find(
        (row) => normalizeInvoiceKind(row.invoice_kind) === "prepayment"
      );
      if (existingPrepayment) {
        return NextResponse.json(
          {
            success: false,
            error: "This reservation already has an active prepayment invoice.",
            existing_invoice: existingPrepayment,
          },
          { status: 409 }
        );
      }
      splitGroupId = splitGroupId ?? randomUUID();
    } else if (invoiceKind === "balance") {
      const existingBalance = overlappingExistingRows.find(
        (row) => normalizeInvoiceKind(row.invoice_kind) === "balance"
      );
      if (existingBalance) {
        return NextResponse.json(
          {
            success: false,
            error: "This reservation already has an active balance invoice.",
            existing_invoice: existingBalance,
          },
          { status: 409 }
        );
      }

      const prepaymentRows = overlappingExistingRows.filter(
        (row) =>
          normalizeInvoiceKind(row.invoice_kind) === "prepayment" &&
          row.status === "issued" &&
          (!splitGroupId || strOrNull(row.split_group_id) === splitGroupId)
      );
      if (prepaymentRows.length === 0) {
        return NextResponse.json(
          { success: false, error: "Create a prepayment invoice before issuing the balance invoice." },
          { status: 400 }
        );
      }

      splitGroupId = splitGroupId ?? strOrNull(prepaymentRows[0]?.split_group_id) ?? randomUUID();
      alreadyCoveredAmount = round2(
        prepaymentRows.reduce((sum, row) => sum + invoiceCoverageAmount(row), 0)
      );
    }

    const coverage = prepareCoverageLineItems(baseLineItems, {
      invoiceKind,
      coverageAmount: input.coverage_amount,
      alreadyCoveredAmount,
    });
    const lineItems = coverage.lineItems;

    let selectedTaxProfile: {
      id: string;
      tax_id: string;
      company_name: string;
      address: string | null;
      branch: string | null;
    } | null = null;

    if (input.guest_tax_profile_id) {
      const { data: profileRow, error: profileError } = await supabase
        .from("guest_tax_profiles")
        .select("id, tax_id, company_name, address, branch")
        .eq("id", input.guest_tax_profile_id)
        .maybeSingle();

      if (profileError) {
        return NextResponse.json({ success: false, error: profileError.message }, { status: 500 });
      }
      if (profileRow) {
        selectedTaxProfile = {
          id: String(profileRow.id),
          tax_id: String(profileRow.tax_id),
          company_name: String(profileRow.company_name),
          address: strOrNull(profileRow.address),
          branch: strOrNull(profileRow.branch),
        };
      }
    }

    const customerName =
      strOrNull(input.customer_name) ??
      selectedTaxProfile?.company_name ??
      built.reservation.guest_name ??
      "Guest";

    const customerTaxId = normalizeTaxIdOrNull(input.customer_tax_id ?? selectedTaxProfile?.tax_id ?? null, input.is_passport);
    const customerAddress =
      strOrNull(input.customer_address) ?? selectedTaxProfile?.address ?? null;
    const customerBranch =
      strOrNull(input.customer_branch) ?? selectedTaxProfile?.branch ?? "สำนักงานใหญ่";

    const discount = round2(normalizeMoney(input.discount));
    const totals = totalsFromLineItems(lineItems, discount);
    const bookingSnapshot = {
      ...built.booking_snapshot,
      invoice_kind: invoiceKind,
      split_group_id: splitGroupId,
      coverage_amount: coverage.coverageAmount,
      coverage_note: strOrNull(input.coverage_note),
      full_net_total: coverage.fullNetTotal,
    };

    const savedProfile =
      input.save_customer_profile && customerTaxId && customerName
        ? await upsertGuestTaxProfile(supabase, {
            id: input.guest_tax_profile_id,
            guest_profile_id: reservation.guest_profile_id,
            tax_id: customerTaxId,
            company_name: customerName,
            address: customerAddress,
            branch: customerBranch,
            is_default: input.customer_is_default,
            is_passport: input.is_passport,
          })
        : null;

    const sellerSnapshot = await getSellerSnapshotFromSettings(supabase);

    const { data: inserted, error: insertError } = await supabase
      .from("invoices")
      .insert({
        reservation_id: reservation.id,
        invoice_no: null,
        status: "draft",
        language: input.language,
        issue_date: input.issue_date ?? toBangkokDate(),
        customer_name: customerName,
        customer_tax_id: customerTaxId,
        customer_address: customerAddress,
        customer_branch: customerBranch,
        remark: strOrNull(input.remark),
        is_passport: input.is_passport,
        guest_tax_profile_id: savedProfile?.id ?? input.guest_tax_profile_id ?? selectedTaxProfile?.id ?? null,
        booking_snapshot: bookingSnapshot,
        line_items: lineItems,
        subtotal: totals.subtotal,
        vat_rate: totals.vat_rate,
        vat_amount: totals.vat_amount,
        grand_total: totals.grand_total,
        discount: totals.discount,
        invoice_kind: invoiceKind,
        split_group_id: splitGroupId,
        coverage_amount: coverage.coverageAmount,
        coverage_note: strOrNull(input.coverage_note),
        manual_issue_date_reason: strOrNull(input.manual_issue_date_reason),
        seller_snapshot: sellerSnapshot,
        updated_by: user.id,
      })
      .select("id, invoice_no, reservation_id, status, issue_date, invoice_kind, split_group_id, coverage_amount, coverage_note, manual_issue_date_reason, customer_name, customer_tax_id, customer_address, customer_branch, remark, guest_tax_profile_id, booking_snapshot, line_items, subtotal, vat_rate, vat_amount, grand_total, discount, seller_snapshot, created_at, updated_at")
      .maybeSingle();

    if (insertError) {
      return NextResponse.json({ success: false, error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, invoice: inserted, data: inserted }, { status: 201 });
  } catch (err) {
    if (err instanceof TaxInvoiceCoverageError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    if (err instanceof TaxInvoiceError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
