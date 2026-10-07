import { fetchAllRowsComplete } from "@/lib/complete-fetch";
import { compareFiledInvoiceRows } from "./filing-order";
import {
  abbreviatedTaxErrorResponse,
  requireAbbreviatedTaxActor,
} from "@/lib/abbreviated-tax-invoice/api-auth";
import { buildAbbreviatedPreview } from "@/lib/abbreviated-tax-invoice/service";
import { getSellerSnapshotFromSettings } from "@/lib/tax-invoice/service";
import {
  buildSalesTaxReportWorkbookBuffer,
  normalizeSalesTaxCategories,
  toSalesTaxReportRows,
  type SalesTaxExportCategory,
  type SalesTaxFullInvoiceInput,
} from "@/lib/tax-invoice/sales-tax-report";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const ALL_CATEGORIES: SalesTaxExportCategory[] = [
  "abbreviated_ota",
  "abbreviated_walkin_direct",
  "abbreviated_pos",
  "full_tax_invoice",
];

const querySchema = z.object({
  year: z.coerce.number().int().min(2025).max(2035),
  month: z.coerce.number().int().min(1).max(12),
  categories: z.string().trim().optional(),
});

function monthDateRange(year: number, month: number): { from: string; to: string } {
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

async function loadFullTaxInvoices(params: {
  supabase: { from: (table: string) => any };
  year: number;
  month: number;
}): Promise<SalesTaxFullInvoiceInput[]> {
  const { from, to } = monthDateRange(params.year, params.month);

  // This feeds a government sales-tax filing. PostgREST's 1000-row cap meant a
  // month with more than 1000 issued invoices was filed SHORT, with nothing in
  // the workbook to say so.
  try {
    const rows = await fetchAllRowsComplete<SalesTaxFullInvoiceInput>(
      () =>
        params.supabase
          .from("invoices")
          // `id` added for the keyset cursor — the pager reads it from every row
          // and refuses when it is absent. It is not emitted in the workbook.
          .select(
            "id, invoice_no, issue_date, customer_name, customer_tax_id, subtotal, vat_amount, grand_total",
            { count: "exact" }
          )
          .eq("status", "issued")
          .gte("issue_date", from)
          .lte("issue_date", to),
      { label: "full tax invoices for the sales-tax report" }
    );
    // The pager orders by its keyset cursor, so the filing order is restored here.
    return rows.sort(compareFiledInvoiceRows);
  } catch (error) {
    throw new Error(
      `Failed to load full tax invoices: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Filing order lives in ./filing-order.ts so the ORDER OF A FILED DOCUMENT is
// testable without a database. See filing-order.test.mts.

export async function GET(request: NextRequest) {
  try {
    const actor = await requireAbbreviatedTaxActor(request);
    if (!actor.ok) return actor.response;

    const parsed = querySchema.safeParse({
      year: request.nextUrl.searchParams.get("year") ?? undefined,
      month: request.nextUrl.searchParams.get("month") ?? undefined,
      categories: request.nextUrl.searchParams.get("categories") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid query.", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { year, month } = parsed.data;
    const rawCategories = parsed.data.categories
      ? parsed.data.categories.split(",")
      : ALL_CATEGORIES;
    const selectedCategories = normalizeSalesTaxCategories(rawCategories);
    if (selectedCategories.length === 0) {
      return NextResponse.json(
        { success: false, error: "Select at least one export section." },
        { status: 400 }
      );
    }

    const needsRoom =
      selectedCategories.includes("abbreviated_ota") ||
      selectedCategories.includes("abbreviated_walkin_direct");
    const needsPos = selectedCategories.includes("abbreviated_pos");
    const needsFull = selectedCategories.includes("full_tax_invoice");

    const [roomPreview, posPreview, fullTaxInvoices, seller] = await Promise.all([
      needsRoom ? buildAbbreviatedPreview(actor.supabase, year, month, "room") : Promise.resolve(null),
      needsPos ? buildAbbreviatedPreview(actor.supabase, year, month, "pos") : Promise.resolve(null),
      needsFull ? loadFullTaxInvoices({ supabase: actor.supabase, year, month }) : Promise.resolve([]),
      getSellerSnapshotFromSettings(actor.supabase),
    ]);

    const rows = toSalesTaxReportRows({
      selectedCategories,
      abbreviatedRoomDrafts: roomPreview?.drafts ?? [],
      abbreviatedPosDrafts: posPreview?.drafts ?? [],
      fullTaxInvoices,
    });

    const buffer = buildSalesTaxReportWorkbookBuffer({
      year,
      month,
      seller,
      rows,
    });
    const body = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const fileName = `sales-tax-report-${year}-${String(month).padStart(2, "0")}.xlsx`;

    return new NextResponse(body, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    });
  } catch (err) {
    return abbreviatedTaxErrorResponse(err);
  }
}
