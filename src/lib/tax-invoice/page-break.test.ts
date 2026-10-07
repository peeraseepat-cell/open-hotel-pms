// A page break must fire BEFORE the paper runs out, not after.
//
// Everything below was measured by rendering through renderInvoiceA4Html itself
// with the real print CSS and the real THSarabunNew faces, then reading
// scrollHeight against clientHeight on the resulting .invoice-copy box.
//
// The item table has 121px of room on a half-A4 sheet. A row costs
//
//     12px of td padding/border  +  20px per wrapped line
//
// so a one-line row is 32px and a two-line row is 52px. The first version of
// this fix counted "printed lines" and set the budget to 4 lines, which looked
// right for two-line rows and was wrong by a whole row for one-line rows:
// four one-line rows are 128px and overflow by 7px. Measuring against a
// hand-assembled DOM instead of the renderer is what hid that.

import { getInvoiceRenderPageCount, renderInvoiceA4Html } from "./printInvoiceHtml";
import type { TaxInvoiceLineItem, TaxInvoiceBookingSnapshot, TaxInvoiceSellerSnapshot } from "./types";

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(`${message ?? "mismatch"}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/** Room charge as it actually prints: one description line + one note line = 52px. */
function roomRow(room: string): TaxInvoiceLineItem {
  return {
    kind: "room_charge",
    description: "ค่าห้องพัก",
    quantity: 3,
    unit: "คืน",
    unit_price: 1200,
    amount: 3600,
    room_number: room,
    stay_dates: ["2026-08-20", "2026-08-21", "2026-08-22"],
    note: "รวมอาหารเช้า 2 ท่าน",
  };
}

/** Extra charge with no note: one line = 32px. */
function plainRow(description: string): TaxInvoiceLineItem {
  return {
    kind: "extra_charge",
    description,
    quantity: 1,
    unit: "รายการ",
    unit_price: 200,
    amount: 200,
  };
}

/* ── capacity: 121px, rows cost 12px + 20px per line ──────────────────── */

assertEqual(getInvoiceRenderPageCount([]), 1, "an empty invoice is still one page");

// 2 x 52px = 104px, 17px to spare — measured.
assertEqual(
  getInvoiceRenderPageCount([roomRow("301"), roomRow("302")]),
  1,
  "two two-line rows are 104px and fit"
);

// 3 x 52px = 156px.
assertEqual(
  getInvoiceRenderPageCount([roomRow("301"), roomRow("302"), roomRow("303")]),
  2,
  "three two-line rows are 156px — the third must move to a new sheet"
);

// 3 x 32px = 96px.
assertEqual(
  getInvoiceRenderPageCount([plainRow("A"), plainRow("B"), plainRow("C")]),
  1,
  "three one-line rows are 96px and fit"
);

// 4 x 32px = 128px. This is the case the first version of the fix got wrong:
// it predicted one page and the sheet overflowed by 7px.
assertEqual(
  getInvoiceRenderPageCount([plainRow("A"), plainRow("B"), plainRow("C"), plainRow("D")]),
  2,
  "four one-line rows are 128px — over the 121px the sheet has"
);

// 52 + 32 + 32 = 116px.
assertEqual(
  getInvoiceRenderPageCount([roomRow("301"), plainRow("A"), plainRow("B")]),
  1,
  "one two-line row plus two one-line rows is 116px and fits"
);

/* ── an item too tall for a sheet still prints, on a sheet of its own ── */
// It is not refused. Refusing would leave the front desk with an invoice it
// cannot issue at all, and the row is not lost either way — it is given a
// sheet to itself, and the row after it starts another one.

const tooTall = plainRow("ก".repeat(400)); // 10 lines = 12 + 200 = 212px

assertEqual(
  getInvoiceRenderPageCount([tooTall]),
  1,
  "an over-tall row alone is still one sheet, not an error"
);

assertEqual(
  getInvoiceRenderPageCount([plainRow("A"), tooTall, plainRow("B")]),
  3,
  "an over-tall row takes a sheet of its own and does not swallow its neighbours"
);

/* ── a multi-sheet invoice must name its sheets ───────────────────────── */
// ป.86/2542 ข้อ 9(2): when one tax invoice is made of several sheets and every
// sheet carries the SAME invoice number, each sheet must state "แผ่นที่ ...".
// A bare "1/2" is not that wording.

const booking: TaxInvoiceBookingSnapshot = {
  booking_code: "BK-2608-0142",
  source: "direct",
  checkin_date: "2026-08-20",
  checkout_date: "2026-08-23",
  nights: 3,
  room_numbers: ["301", "302", "303"],
};

const seller: TaxInvoiceSellerSnapshot = {
  hotel_name: "โรงแรมตัวอย่าง",
  company_name: "บริษัท ตัวอย่าง จำกัด",
  company_name_en: "Tuayang Co., Ltd.",
  company_tax_id: "0245524000053",
  company_address: "1 ถนนตัวอย่าง",
  company_address_en: "1 Tuayang Rd.",
  company_branch: "สำนักงานใหญ่",
  company_phone: "077-000000",
};

const multiSheet = renderInvoiceA4Html({
  invoiceNo: "IV26099",
  issueDate: "2026-08-23",
  language: "th",
  customerName: "บริษัท ลูกค้า จำกัด",
  customerTaxId: "0987654321098",
  customerAddress: "9 ถนนลูกค้า",
  customerBranch: "00000",
  booking,
  lineItems: [roomRow("301"), roomRow("302"), roomRow("303")],
  totals: { subtotal: 10093.46, vat_rate: 0.07, vat_amount: 706.54, grand_total: 10800, discount: 0 },
  seller,
});

if (!multiSheet.includes("แผ่นที่")) {
  throw new Error('a multi-sheet invoice must print the words "แผ่นที่" on each sheet');
}

const singleSheet = renderInvoiceA4Html({
  invoiceNo: "IV26100",
  issueDate: "2026-08-23",
  language: "th",
  customerName: "บริษัท ลูกค้า จำกัด",
  customerTaxId: "0987654321098",
  customerAddress: "9 ถนนลูกค้า",
  customerBranch: "00000",
  booking,
  lineItems: [roomRow("301")],
  totals: { subtotal: 3364.49, vat_rate: 0.07, vat_amount: 235.51, grand_total: 3600, discount: 0 },
  seller,
});

if (singleSheet.includes("แผ่นที่")) {
  throw new Error('a single-sheet invoice must not print "แผ่นที่" — there is no second sheet to name');
}

const tooTallHtml = renderInvoiceA4Html({
  invoiceNo: "IV26101",
  issueDate: "2026-08-23",
  language: "th",
  customerName: "บริษัท ลูกค้า จำกัด",
  customerTaxId: "0987654321098",
  customerAddress: "9 ถนนลูกค้า",
  customerBranch: "00000",
  booking,
  lineItems: [tooTall],
  totals: { subtotal: 186.92, vat_rate: 0.07, vat_amount: 13.08, grand_total: 200, discount: 0 },
  seller,
});
if (!tooTallHtml.includes("ก".repeat(40))) {
  throw new Error("an over-tall row must still appear in the rendered invoice");
}

console.log("page-break: ok");
