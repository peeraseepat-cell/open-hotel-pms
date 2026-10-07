import { fetchAllRowsComplete } from "@/lib/complete-fetch";
import { getAuthenticatedUser } from "@/lib/server-auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  extractReservationIdsFromBookingSnapshot,
  getRequestingUserRole,
  isAdminRole,
  TaxInvoiceError,
} from "@/lib/tax-invoice/service";
import { normalizeMoney, round2, toInvoiceYearMonthYYMM } from "@/lib/tax-invoice/utils";
import type { TaxInvoiceKind } from "@/lib/tax-invoice/types";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const issueSchema = z.object({
  issue_date: z.string().regex(DATE_RE).optional(),
});

type InvoiceIssueRow = {
  id: string;
  invoice_no: string | null;
  reservation_id: string;
  booking_snapshot?: unknown;
  status: "draft" | "issued" | "cancelled";
  issue_date: string;
  invoice_kind?: TaxInvoiceKind | null;
  split_group_id?: string | null;
  coverage_amount?: number | string | null;
  grand_total?: number | string | null;
  manual_issue_date_reason?: string | null;
  reservations: {
    id: string;
    checkout_date: string | null;
    tax_invoice_requested: boolean | null;
  } | null;
};

function isUniqueViolation(error: { code?: string | null; message?: string | null }, indexName: string): boolean {
  return error.code === "23505" && String(error.message ?? "").includes(indexName);
}

function normalizeInvoiceKind(value: unknown): TaxInvoiceKind {
  const kind = String(value ?? "standard").trim().toLowerCase();
  return kind === "prepayment" || kind === "balance" ? kind : "standard";
}

function strOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function invoiceCoverageAmount(row: Record<string, unknown>): number {
  return round2(normalizeMoney(row.coverage_amount ?? row.grand_total ?? 0));
}

function invoiceRowsOverlap(row: Record<string, unknown>, reservationIds: string[]): boolean {
  const existingReservationIds = extractReservationIdsFromBookingSnapshot(row.booking_snapshot, row.reservation_id as string | null);
  return existingReservationIds.some((reservationId) => reservationIds.includes(reservationId));
}

async function loadInvoiceForIssue(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  invoiceId: string
): Promise<InvoiceIssueRow> {
  const { data, error } = await supabase
    .from("invoices")
    .select("id, invoice_no, reservation_id, booking_snapshot, status, issue_date, invoice_kind, split_group_id, coverage_amount, grand_total, manual_issue_date_reason, reservations:reservation_id(id, checkout_date, tax_invoice_requested)")
    .eq("id", invoiceId)
    .maybeSingle();

  if (error) throw new TaxInvoiceError(error.message, 500);
  if (!data) throw new TaxInvoiceError("Invoice not found.", 404);
  return data as unknown as InvoiceIssueRow;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const invoiceId = String(params.id ?? "").trim();
    if (!invoiceId) {
      return NextResponse.json({ success: false, error: "Missing invoice id." }, { status: 400 });
    }

    const supabase = createServerSupabaseClient();
    const user = await getAuthenticatedUser(supabase, request);
    if (!user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    const role = await getRequestingUserRole(supabase, user.id);
    const isAdmin = isAdminRole(role);

    const body = await request.json().catch(() => null);
    const parsed = issueSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const current = await loadInvoiceForIssue(supabase, invoiceId);
    if (current.status === "cancelled") {
      return NextResponse.json({ success: false, error: "Cancelled invoice cannot be issued." }, { status: 400 });
    }
    const currentKind = normalizeInvoiceKind(current.invoice_kind);
    if (currentKind !== "standard" && !isAdmin) {
      return NextResponse.json(
        { success: false, error: "Only admin can issue split/prepayment tax invoices." },
        { status: 403 }
      );
    }
    if (
      currentKind !== "standard" &&
      parsed.data.issue_date &&
      parsed.data.issue_date !== current.issue_date &&
      !strOrNull(current.manual_issue_date_reason)
    ) {
      return NextResponse.json(
        { success: false, error: "manual_issue_date_reason is required for split invoice manual issue dates." },
        { status: 400 }
      );
    }

    const reservationIds = extractReservationIdsFromBookingSnapshot(current.booking_snapshot, current.reservation_id);
    const { data: reservationRows, error: reservationError } = await supabase
      .from("reservations")
      .select("id, tax_invoice_requested")
      .in("id", reservationIds);

    if (reservationError) {
      return NextResponse.json({ success: false, error: reservationError.message }, { status: 500 });
    }

    if ((reservationRows ?? []).length !== reservationIds.length || (reservationRows ?? []).some((row: any) => !row.tax_invoice_requested)) {
      return NextResponse.json(
        { success: false, error: "Tax invoice must still be requested for every selected reservation." },
        { status: 400 }
      );
    }

    let existingIssuedRows: any[];
    try {
      existingIssuedRows = await fetchAllRowsComplete<any>(
        () =>
          supabase
            .from("invoices")
            .select(
              "id, invoice_no, reservation_id, booking_snapshot, invoice_kind, split_group_id, coverage_amount, grand_total",
              { count: "exact" }
            )
            .eq("status", "issued"),
        { label: "issued invoices" }
      );
    } catch (error) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }

    const overlappingIssuedRows = ((existingIssuedRows ?? []) as Array<Record<string, unknown>>)
      .filter((row) => String(row.id) !== current.id && invoiceRowsOverlap(row, reservationIds));

    const conflictingIssued = overlappingIssuedRows.find((row) => {
      const existingKind = normalizeInvoiceKind(row.invoice_kind);
      if (currentKind === "standard") return true;
      if (existingKind === "standard") return true;
      if (currentKind === "prepayment") return existingKind === "prepayment" || existingKind === "balance";
      return existingKind === "balance";
    });

    if (conflictingIssued) {
      return NextResponse.json(
        {
          success: false,
          error: "One or more selected reservations already have an issued invoice.",
          existing_invoice: conflictingIssued,
        },
        { status: 409 }
      );
    }

    if (currentKind === "balance") {
      const splitGroupId = strOrNull(current.split_group_id);
      const issuedPrepayment = overlappingIssuedRows.find(
        (row) =>
          normalizeInvoiceKind(row.invoice_kind) === "prepayment" &&
          (!splitGroupId || strOrNull(row.split_group_id) === splitGroupId)
      );
      if (!issuedPrepayment) {
        return NextResponse.json(
          { success: false, error: "Issue a prepayment invoice before issuing the balance invoice." },
          { status: 400 }
        );
      }
    }

    if (currentKind !== "standard") {
      const snapshot = current.booking_snapshot && typeof current.booking_snapshot === "object"
        ? (current.booking_snapshot as Record<string, unknown>)
        : {};
      const fullNetTotal = round2(
        normalizeMoney(snapshot.full_net_total ?? current.coverage_amount ?? current.grand_total ?? 0)
      );
      const splitGroupId = strOrNull(current.split_group_id);
      const coveredByOthers = overlappingIssuedRows
        .filter((row) => normalizeInvoiceKind(row.invoice_kind) !== "standard")
        .filter((row) => !splitGroupId || strOrNull(row.split_group_id) === splitGroupId)
        .reduce((sum, row) => sum + invoiceCoverageAmount(row), 0);
      const currentCoverage = invoiceCoverageAmount(current as unknown as Record<string, unknown>);
      if (round2(coveredByOthers + currentCoverage) > fullNetTotal) {
        return NextResponse.json(
          { success: false, error: "Split invoice coverage cannot exceed the discounted net total." },
          { status: 409 }
        );
      }
    }

    if (current.status === "issued" && current.invoice_no) {
      const { data: issuedInvoice } = await supabase
        .from("invoices")
        .select("id, invoice_no, reservation_id, status, issue_date, invoice_kind, split_group_id, coverage_amount, issued_by, updated_at")
        .eq("id", current.id)
        .maybeSingle();
      return NextResponse.json({ success: true, invoice: issuedInvoice, data: issuedInvoice, already_issued: true });
    }

    const issueDate = parsed.data.issue_date ?? current.issue_date;
    const yymm = toInvoiceYearMonthYYMM(issueDate);

    let lastError: string | null = null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { data: nextNo, error: nextNoError } = await supabase.rpc("next_invoice_no", { p_yy: yymm });
      if (nextNoError) {
        return NextResponse.json({ success: false, error: nextNoError.message }, { status: 500 });
      }

      const invoiceNo = String(nextNo ?? "").trim();
      if (!invoiceNo) {
        return NextResponse.json({ success: false, error: "Unable to generate invoice number." }, { status: 500 });
      }

      const { data: updated, error: updateError } = await supabase
        .from("invoices")
        .update({
          invoice_no: invoiceNo,
          status: "issued",
          issue_date: issueDate,
          issued_by: user.id,
          updated_by: user.id,
        })
        .eq("id", invoiceId)
        .eq("status", "draft")
        .select("id, invoice_no, reservation_id, status, issue_date, invoice_kind, split_group_id, coverage_amount, issued_by, updated_at")
        .maybeSingle();

      if (!updateError && updated) {
        return NextResponse.json({ success: true, invoice: updated, data: updated });
      }

      if (updateError) {
        if (isUniqueViolation(updateError, "idx_invoices_invoice_no_unique")) {
          lastError = updateError.message;
          continue;
        }
        if (isUniqueViolation(updateError, "idx_invoices_reservation_issued_unique")) {
          const { data: existingIssued } = await supabase
            .from("invoices")
            .select("id, invoice_no, reservation_id, status, issue_date, invoice_kind, split_group_id, coverage_amount, issued_by, updated_at")
            .eq("reservation_id", current.reservation_id)
            .eq("status", "issued")
            .maybeSingle();

          return NextResponse.json(
            {
              success: false,
              error: "This reservation already has an issued invoice.",
              existing_invoice: existingIssued ?? null,
            },
            { status: 409 }
          );
        }

        return NextResponse.json({ success: false, error: updateError.message }, { status: 500 });
      }

      const refreshed = await loadInvoiceForIssue(supabase, invoiceId);
      if (refreshed.status === "issued" && refreshed.invoice_no) {
        const { data: issuedInvoice } = await supabase
          .from("invoices")
          .select("id, invoice_no, reservation_id, status, issue_date, invoice_kind, split_group_id, coverage_amount, issued_by, updated_at")
          .eq("id", refreshed.id)
          .maybeSingle();
        return NextResponse.json({ success: true, invoice: issuedInvoice, data: issuedInvoice, already_issued: true });
      }
    }

    return NextResponse.json(
      { success: false, error: lastError ?? "Unable to issue invoice after retries." },
      { status: 500 }
    );
  } catch (err) {
    if (err instanceof TaxInvoiceError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
