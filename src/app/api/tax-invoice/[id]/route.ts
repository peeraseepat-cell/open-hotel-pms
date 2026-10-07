import { fetchAllRowsComplete } from "@/lib/complete-fetch";
import { getAuthenticatedUser } from "@/lib/server-auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  prepareEditedCoverageLineItems,
  TaxInvoiceCoverageError,
} from "@/lib/tax-invoice/coverage";
import {
  canFoEditInvoiceByBusinessDate,
  getBusinessDateFromSettings,
  getRequestingUserRole,
  getSellerSnapshotFromSettings,
  isAdminRole,
  sanitizeLineItems,
  TaxInvoiceError,
  totalsFromLineItems,
  upsertGuestTaxProfile,
} from "@/lib/tax-invoice/service";
import type { TaxInvoiceKind } from "@/lib/tax-invoice/types";
import { normalizeMoney, round2 } from "@/lib/tax-invoice/utils";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const patchSchema = z.object({
  language: z.enum(["th", "en"]).optional(),
  issue_date: z.string().regex(DATE_RE).optional(),
  customer_name: z.string().trim().min(1).max(255).optional(),
  customer_tax_id: z.string().trim().max(30).optional().nullable(),
  customer_address: z.string().trim().max(2000).optional().nullable(),
  customer_branch: z.string().trim().max(255).optional().nullable(),
  remark: z.string().trim().max(2000).optional().nullable(),
  is_passport: z.boolean().optional(),
  guest_tax_profile_id: z.string().uuid().optional().nullable(),
  line_items: z.array(z.unknown()).optional(),
  discount: z.coerce.number().min(0).max(100000000).optional(),
  coverage_amount: z.coerce.number().min(0).max(100000000).optional().nullable(),
  coverage_note: z.string().trim().max(500).optional().nullable(),
  manual_issue_date_reason: z.string().trim().max(1000).optional().nullable(),
  update_reason: z.string().trim().max(1000).optional().nullable(),
});

const cancelSchema = z.object({
  cancel_reason: z.string().trim().min(3).max(1000),
  reuse_invoice_no: z.boolean().optional().default(false),
});

type InvoiceWithReservation = {
  id: string;
  reservation_id: string;
  invoice_no: string | null;
  cancelled_invoice_no?: string | null;
  status: "draft" | "issued" | "cancelled";
  issue_date: string;
  language: "th" | "en";
  customer_name: string;
  customer_tax_id: string | null;
  customer_address: string | null;
  customer_branch: string | null;
  remark: string | null;
  guest_tax_profile_id: string | null;
  line_items: unknown;
  discount: number | string;
  subtotal: number | string;
  vat_rate: number | string;
  vat_amount: number | string;
  grand_total: number | string;
  invoice_kind?: TaxInvoiceKind | null;
  split_group_id?: string | null;
  coverage_amount?: number | string | null;
  coverage_note?: string | null;
  manual_issue_date_reason?: string | null;
  booking_snapshot: unknown;
  seller_snapshot: unknown;
  issued_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  updated_by: string | null;
  update_reason: string | null;
  created_at: string;
  updated_at: string;
  reservations: {
    id: string;
    booking_code: string | null;
    guest_name: string | null;
    source: string | null;
    status: string | null;
    checkin_date: string | null;
    checkout_date: string | null;
    guest_profile_id: string | null;
    tax_invoice_requested: boolean | null;
  } | null;
};

function strOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function normalizeInvoiceKind(value: unknown): TaxInvoiceKind {
  const kind = String(value ?? "standard").trim().toLowerCase();
  return kind === "prepayment" || kind === "balance" ? kind : "standard";
}

const SELLER_SNAPSHOT_KEYS = [
  "hotel_name",
  "company_name",
  "company_name_en",
  "company_tax_id",
  "company_address",
  "company_address_en",
  "company_branch",
  "company_phone",
] as const;

function sellerSnapshotNeedsFallback(snapshot: Record<string, unknown>) {
  return SELLER_SNAPSHOT_KEYS.some((key) => !strOrNull(snapshot[key]));
}

function mergeSellerSnapshotWithLiveSettings(
  snapshot: Record<string, unknown>,
  liveSeller: Awaited<ReturnType<typeof getSellerSnapshotFromSettings>>
) {
  const merged: Record<string, unknown> = { ...snapshot };
  for (const key of SELLER_SNAPSHOT_KEYS) {
    if (!strOrNull(merged[key]) && strOrNull(liveSeller[key])) {
      merged[key] = liveSeller[key];
    }
  }
  return merged;
}

function normalizeTaxIdOrNull(value: unknown, isPassport = false): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (isPassport) return text;
  const digits = text.replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (!/^\d{13}$/.test(digits)) {
    throw new TaxInvoiceError("customer_tax_id must contain 13 digits.", 400);
  }
  return digits;
}

function toAuditInvoiceSnapshot(invoice: InvoiceWithReservation | Record<string, unknown>) {
  return {
    invoice_no: strOrNull((invoice as any).invoice_no) ?? strOrNull((invoice as any).cancelled_invoice_no),
    status: strOrNull((invoice as any).status),
    language: strOrNull((invoice as any).language),
    issue_date: strOrNull((invoice as any).issue_date),
    customer_name: strOrNull((invoice as any).customer_name),
    customer_tax_id: strOrNull((invoice as any).customer_tax_id),
    customer_address: strOrNull((invoice as any).customer_address),
    customer_branch: strOrNull((invoice as any).customer_branch),
    remark: strOrNull((invoice as any).remark),
    line_items: (invoice as any).line_items ?? null,
    discount: normalizeMoney((invoice as any).discount ?? 0),
    invoice_kind: normalizeInvoiceKind((invoice as any).invoice_kind),
    split_group_id: strOrNull((invoice as any).split_group_id),
    coverage_amount: normalizeMoney((invoice as any).coverage_amount ?? (invoice as any).grand_total ?? 0),
    coverage_note: strOrNull((invoice as any).coverage_note),
    manual_issue_date_reason: strOrNull((invoice as any).manual_issue_date_reason),
    subtotal: normalizeMoney((invoice as any).subtotal ?? 0),
    vat_rate: normalizeMoney((invoice as any).vat_rate ?? 0),
    vat_amount: normalizeMoney((invoice as any).vat_amount ?? 0),
    grand_total: normalizeMoney((invoice as any).grand_total ?? 0),
  };
}

async function loadInvoiceOr404(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  invoiceId: string
): Promise<InvoiceWithReservation> {
  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, reservation_id, invoice_no, cancelled_invoice_no, status, issue_date, language, customer_name, customer_tax_id, customer_address, customer_branch, remark, guest_tax_profile_id, line_items, discount, subtotal, vat_rate, vat_amount, grand_total, invoice_kind, split_group_id, coverage_amount, coverage_note, manual_issue_date_reason, booking_snapshot, seller_snapshot, issued_by, cancelled_at, cancelled_by, cancel_reason, updated_by, update_reason, created_at, updated_at, reservations:reservation_id(id, booking_code, guest_name, source, status, checkin_date, checkout_date, guest_profile_id, tax_invoice_requested)"
    )
    .eq("id", invoiceId)
    .maybeSingle();

  if (error) throw new TaxInvoiceError(error.message, 500);
  if (!data) throw new TaxInvoiceError("Invoice not found.", 404);

  return data as unknown as InvoiceWithReservation;
}

async function canReuseInvoiceNumber(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  invoice: InvoiceWithReservation
): Promise<boolean> {
  const currentInvoiceNo = strOrNull(invoice.invoice_no);
  if (!currentInvoiceNo || invoice.status !== "issued") return false;

  // The JS numeric sort below is deliberately kept instead of an
  // `ORDER BY invoice_no DESC LIMIT 1`: invoice_no is text with a
  // variable-width sequence (next_invoice_no => 'IV' || YY || LPAD(seq, max(3,
  // len(seq)))), so text collation ranks IV69999 above IV691000 and would pick
  // the wrong "latest" once a year-series passes 999. What was broken here was
  // the truncated READ, not the comparison.
  let data: Array<{ id: string; invoice_no: string | null }>;
  try {
    data = await fetchAllRowsComplete<{ id: string; invoice_no: string | null }>(
      () =>
        supabase
          .from("invoices")
          .select("id, invoice_no", { count: "exact" })
          .eq("status", "issued")
          .not("invoice_no", "is", null),
      { label: "issued invoice numbers" }
    );
  } catch (error) {
    throw new TaxInvoiceError(error instanceof Error ? error.message : String(error), 500);
  }

  const latest = (data ?? [])
    .filter((row: any) => strOrNull(row.invoice_no))
    .sort((a: any, b: any) => String(b.invoice_no ?? "").localeCompare(String(a.invoice_no ?? ""), undefined, { numeric: true, sensitivity: "base" }))[0];

  return String(latest?.id ?? "") === invoice.id;
}

export async function GET(
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

    const invoice = await loadInvoiceOr404(supabase, invoiceId);
    const role = await getRequestingUserRole(supabase, user.id);
    if (invoice.status === "cancelled" && !isAdminRole(role)) {
      return NextResponse.json({ success: false, error: "Only admin can view cancelled invoices." }, { status: 403 });
    }
    const invoiceForResponse = {
      ...invoice,
      invoice_no: invoice.invoice_no ?? invoice.cancelled_invoice_no ?? null,
    };

    // Merge current seller settings into incomplete seller snapshots for old invoices.
    const rawSnapshot = invoice.seller_snapshot as Record<string, unknown> | null ?? {};
    if (sellerSnapshotNeedsFallback(rawSnapshot)) {
      const liveSeller = await getSellerSnapshotFromSettings(supabase);
      const merged = mergeSellerSnapshotWithLiveSettings(rawSnapshot, liveSeller);
      const enriched = { ...invoiceForResponse, seller_snapshot: merged };
      return NextResponse.json({
        success: true,
        invoice: enriched,
        data: enriched,
        viewer_role: role,
        viewer_is_admin: isAdminRole(role),
      });
    }

    return NextResponse.json({
      success: true,
      invoice: invoiceForResponse,
      data: invoiceForResponse,
      viewer_role: role,
      viewer_is_admin: isAdminRole(role),
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

export async function PATCH(
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

    const body = await request.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const input = parsed.data;
    if (Object.keys(input).length === 0) {
      return NextResponse.json({ success: false, error: "No fields to update." }, { status: 400 });
    }

    const invoice = await loadInvoiceOr404(supabase, invoiceId);
    if (invoice.status === "cancelled") {
      return NextResponse.json({ success: false, error: "Cancelled invoice cannot be edited." }, { status: 400 });
    }

    const role = await getRequestingUserRole(supabase, user.id);
    const isAdmin = isAdminRole(role);
    const invoiceKind = normalizeInvoiceKind(invoice.invoice_kind);
    const businessDate = await getBusinessDateFromSettings(supabase);
    const checkoutDate = strOrNull(invoice.reservations?.checkout_date);
    const foCanEdit = canFoEditInvoiceByBusinessDate(businessDate, checkoutDate);

    if (invoiceKind !== "standard" && !isAdmin) {
      return NextResponse.json(
        { success: false, error: "Only admin can edit split/prepayment tax invoices." },
        { status: 403 }
      );
    }

    if (!foCanEdit && !isAdmin) {
      return NextResponse.json(
        { success: false, error: "Only admin can edit this invoice after checkout day is closed." },
        { status: 403 }
      );
    }

    if (
      invoiceKind !== "standard" &&
      input.issue_date &&
      input.issue_date !== invoice.issue_date &&
      !strOrNull(input.manual_issue_date_reason ?? invoice.manual_issue_date_reason)
    ) {
      return NextResponse.json(
        { success: false, error: "manual_issue_date_reason is required for split invoice manual issue dates." },
        { status: 400 }
      );
    }

    if (!foCanEdit && isAdmin && !strOrNull(input.update_reason)) {
      return NextResponse.json(
        { success: false, error: "update_reason is required for admin edit after cutoff." },
        { status: 400 }
      );
    }

    const patch: Record<string, unknown> = {
      updated_by: user.id,
    };

    if (input.language) patch.language = input.language;
    if (input.issue_date) patch.issue_date = input.issue_date;
    if (input.customer_name !== undefined) patch.customer_name = input.customer_name;
    if (input.customer_address !== undefined) patch.customer_address = strOrNull(input.customer_address);
    if (input.customer_branch !== undefined) patch.customer_branch = strOrNull(input.customer_branch);
    if (input.remark !== undefined) patch.remark = strOrNull(input.remark);
    if (input.guest_tax_profile_id !== undefined) patch.guest_tax_profile_id = input.guest_tax_profile_id;
    if (input.update_reason !== undefined) patch.update_reason = strOrNull(input.update_reason);
    if (input.coverage_note !== undefined) patch.coverage_note = strOrNull(input.coverage_note);
    if (input.manual_issue_date_reason !== undefined) {
      patch.manual_issue_date_reason = strOrNull(input.manual_issue_date_reason);
    }

    const patchIsPassport = Boolean(input.is_passport);
    if (input.is_passport !== undefined) patch.is_passport = patchIsPassport;

    if (input.customer_tax_id !== undefined) {
      patch.customer_tax_id = normalizeTaxIdOrNull(input.customer_tax_id, patchIsPassport);
    }

    const baseLineItems = sanitizeLineItems(invoice.line_items);
    let nextLineItems = input.line_items ? sanitizeLineItems(input.line_items) : baseLineItems;
    if (nextLineItems.length === 0) {
      return NextResponse.json({ success: false, error: "Line items cannot be empty." }, { status: 400 });
    }

    if (invoiceKind !== "standard") {
      const targetCoverageAmount = input.coverage_amount !== undefined
        ? round2(normalizeMoney(input.coverage_amount))
        : round2(normalizeMoney(invoice.coverage_amount ?? invoice.grand_total));
      const coverage = prepareEditedCoverageLineItems(nextLineItems, {
        invoiceKind,
        coverageAmount: targetCoverageAmount,
      });
      nextLineItems = coverage.lineItems;
      patch.coverage_amount = coverage.coverageAmount;
      const currentSnapshot = invoice.booking_snapshot && typeof invoice.booking_snapshot === "object"
        ? invoice.booking_snapshot as Record<string, unknown>
        : {};
      patch.booking_snapshot = {
        ...currentSnapshot,
        invoice_kind: invoiceKind,
        split_group_id: strOrNull(invoice.split_group_id),
        coverage_amount: coverage.coverageAmount,
        coverage_note: strOrNull(input.coverage_note ?? invoice.coverage_note),
        full_net_total: coverage.fullNetTotal,
      };
    }

    const nextDiscount =
      input.discount !== undefined
        ? round2(normalizeMoney(input.discount))
        : round2(normalizeMoney(invoice.discount));

    const totals = totalsFromLineItems(nextLineItems, nextDiscount);
    patch.line_items = nextLineItems;
    patch.discount = totals.discount;
    patch.subtotal = totals.subtotal;
    patch.vat_rate = totals.vat_rate;
    patch.vat_amount = totals.vat_amount;
    patch.grand_total = totals.grand_total;
    if (invoiceKind === "standard") {
      patch.coverage_amount = totals.grand_total;
    }

    const resolvedCustomerName =
      strOrNull((patch.customer_name ?? invoice.customer_name) as unknown) ?? invoice.customer_name;
    const resolvedTaxId = normalizeTaxIdOrNull(
      patch.customer_tax_id !== undefined ? patch.customer_tax_id : invoice.customer_tax_id,
      patchIsPassport
    );

    if (resolvedCustomerName && resolvedTaxId) {
      await upsertGuestTaxProfile(supabase, {
        id: strOrNull((patch.guest_tax_profile_id ?? invoice.guest_tax_profile_id) as unknown),
        guest_profile_id: strOrNull(invoice.reservations?.guest_profile_id),
        tax_id: resolvedTaxId,
        company_name: resolvedCustomerName,
        address: strOrNull((patch.customer_address ?? invoice.customer_address) as unknown),
        branch: strOrNull((patch.customer_branch ?? invoice.customer_branch) as unknown),
        is_passport: patchIsPassport,
      });
    }

    const { data: updated, error: updateError } = await supabase
      .from("invoices")
      .update(patch)
      .eq("id", invoiceId)
      .select(
        "id, reservation_id, invoice_no, cancelled_invoice_no, status, issue_date, language, customer_name, customer_tax_id, customer_address, customer_branch, remark, guest_tax_profile_id, booking_snapshot, line_items, subtotal, vat_rate, vat_amount, grand_total, discount, invoice_kind, split_group_id, coverage_amount, coverage_note, manual_issue_date_reason, seller_snapshot, issued_by, cancelled_at, cancelled_by, cancel_reason, updated_by, update_reason, created_at, updated_at"
      )
      .maybeSingle();

    if (updateError) {
      return NextResponse.json({ success: false, error: updateError.message }, { status: 500 });
    }

    const updateReason = strOrNull(input.update_reason);
    const { error: auditError } = await supabase.from("audit_logs").insert({
      actor_user_id: user.id,
      action: "tax_invoice_updated",
      entity_type: "tax_invoice",
      entity_id: invoiceId,
      before_json: toAuditInvoiceSnapshot(invoice),
      after_json: toAuditInvoiceSnapshot(updated as Record<string, unknown>),
      source: "manual",
      note: updateReason,
      change_reason: updateReason,
      business_date: businessDate,
    });

    if (auditError) {
      console.error("tax invoice update audit insert failed", auditError);
    }

    return NextResponse.json({ success: true, invoice: updated, data: updated });
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

export async function DELETE(
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
    if (!isAdminRole(role)) {
      return NextResponse.json({ success: false, error: "Only admin can cancel invoice." }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const parsed = cancelSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid payload.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const invoice = await loadInvoiceOr404(supabase, invoiceId);
    if (invoice.status === "cancelled") {
      return NextResponse.json({ success: true, invoice, data: invoice, already_cancelled: true });
    }

    const allowReuseInvoiceNo = parsed.data.reuse_invoice_no && await canReuseInvoiceNumber(supabase, invoice);
    if (parsed.data.reuse_invoice_no && !allowReuseInvoiceNo) {
      return NextResponse.json(
        { success: false, error: "Invoice number can only be reused when cancelling the latest issued invoice." },
        { status: 400 }
      );
    }

    const nowIso = new Date().toISOString();
    const { data: cancelled, error: cancelError } = await supabase
      .from("invoices")
      .update({
        status: "cancelled",
        invoice_no: allowReuseInvoiceNo ? null : invoice.invoice_no,
        cancelled_invoice_no: allowReuseInvoiceNo ? invoice.invoice_no : invoice.cancelled_invoice_no ?? null,
        cancelled_at: nowIso,
        cancelled_by: user.id,
        cancel_reason: parsed.data.cancel_reason,
        updated_by: user.id,
        update_reason: parsed.data.cancel_reason,
      })
      .eq("id", invoiceId)
      .select(
        "id, reservation_id, invoice_no, cancelled_invoice_no, status, issue_date, language, customer_name, customer_tax_id, customer_address, customer_branch, remark, guest_tax_profile_id, booking_snapshot, line_items, subtotal, vat_rate, vat_amount, grand_total, discount, invoice_kind, split_group_id, coverage_amount, coverage_note, manual_issue_date_reason, seller_snapshot, issued_by, cancelled_at, cancelled_by, cancel_reason, updated_by, update_reason, created_at, updated_at"
      )
      .maybeSingle();

    if (cancelError) {
      return NextResponse.json({ success: false, error: cancelError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, invoice: cancelled, data: cancelled });
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
