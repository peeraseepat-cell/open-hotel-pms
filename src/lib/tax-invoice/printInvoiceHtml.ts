import {
  TaxInvoiceLineItem,
  TaxInvoiceTotals,
  TaxInvoiceBookingSnapshot,
  TaxInvoiceSellerSnapshot,
  TaxInvoiceLanguage
} from "./types";
import {
  compareRoomNumber,
  esc,
  fmtMoney,
  fmtDate,
  formatTaxInvoiceItemDescription,
  formatTaxInvoiceItemUnit,
  getLabels,
} from "./utils";

interface InvoiceRenderData {
  invoiceNo: string | null;
  issueDate: string;
  language: TaxInvoiceLanguage;
  customerName: string;
  customerTaxId: string | null;
  customerAddress: string | null;
  customerBranch: string | null;
  remark?: string | null;
  booking: TaxInvoiceBookingSnapshot;
  lineItems: TaxInvoiceLineItem[];
  totals: TaxInvoiceTotals;
  seller: TaxInvoiceSellerSnapshot;
}

// How much vertical room the item table actually has, and what a row costs.
//
// Measured 2026-08-23 by rendering through renderInvoiceA4Html itself — not a
// hand-assembled DOM — with the real print CSS and the real THSarabunNew faces.
// An earlier attempt counted "printed lines" and got the capacity wrong by a
// whole row, because a row is not just its lines: every row also pays a fixed
// td padding + border cost whether it holds one line or three.
//
//     row height = ROW_CHROME_PX + ROW_LINE_PX * lines      (32px, 52px, 72px …)
//
// Four one-line rows are 128px and overflow the sheet by 7px. Two two-line rows
// are 104px and fit with 17px to spare. Both were measured, and both are pinned
// in src/lib/tax-invoice/page-break.test.ts.
//
// What this estimate does NOT know is glyph width: it counts characters, so a
// run of wide capitals costs the same as the same number of Thai characters.
// Measured in headless Chrome on 2026-08-23, across 30 fixtures rendered through
// this file with the real print CSS and the real THSarabunNew faces:
//
//   * every realistic description and note passed with 0px of overflow —
//     long Thai sentences, long English sentences, ALL-CAPS English, mixed
//     Thai/English, a long URL in a note, twelve items, three room rows
//   * a single row carrying more than ~150 solid capital "W" characters
//     overflows its sheet by 12px, and ~200 of them by 32px
//
// That residual is not something pagination can fix: such a row does not fit on
// a sheet even when it is the only row on it. It spills visibly rather than
// printing underneath the COPY unseen, which is the behaviour this file
// replaced.
const SHEET_ITEM_AREA_PX = 121;
const ROW_CHROME_PX = 12;
const ROW_LINE_PX = 20;

function addOneDay(isoDate: string | null | undefined): string | null {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate ?? null;
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(year, month - 1, day + 1);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function estimateItemLines(item: TaxInvoiceLineItem): number {
  // `room_number` prints once per sheet in the party block, never inside a row —
  // itemTable() renders only `description` and the optional `note`.
  const descriptionLines = Math.max(1, Math.ceil(String(item.description || "").length / 40));
  const noteLines = item.note ? Math.max(1, Math.ceil(String(item.note).length / 48)) : 0;
  return descriptionLines + noteLines;
}

function estimateItemHeightPx(item: TaxInvoiceLineItem): number {
  return ROW_CHROME_PX + ROW_LINE_PX * estimateItemLines(item);
}

function paginateLineItems(items: TaxInvoiceLineItem[]): TaxInvoiceLineItem[][] {
  if (items.length === 0) return [[]];

  const pages: TaxInvoiceLineItem[][] = [];
  let current: TaxInvoiceLineItem[] = [];
  let usedPx = 0;

  for (const item of items) {
    const heightPx = estimateItemHeightPx(item);

    // A row taller than the whole item area still has to print. Flushing first
    // gives it a sheet to itself, and because usedPx then already exceeds the
    // area, the row after it starts another sheet. Nothing is dropped.
    if (current.length > 0 && usedPx + heightPx > SHEET_ITEM_AREA_PX) {
      pages.push(current);
      current = [];
      usedPx = 0;
    }
    current.push(item);
    usedPx += heightPx;
  }

  if (current.length > 0) {
    pages.push(current);
  }

  return pages;
}

export function getInvoiceRenderPageCount(items: TaxInvoiceLineItem[]): number {
  return paginateLineItems(items).length;
}

function splitRoomNumberText(value: string | null | undefined): string[] {
  return String(value ?? "")
    .split(",")
    .map((room) => room.trim())
    .filter(Boolean);
}

function getDisplayRoomNumbers(booking: TaxInvoiceBookingSnapshot, lineItems: TaxInvoiceLineItem[]): string[] {
  const roomChargeNumbers = lineItems
    .filter((item) => item.kind === "room_charge")
    .flatMap((item) => splitRoomNumberText(item.room_number));

  const lineItemNumbers = roomChargeNumbers.length > 0
    ? roomChargeNumbers
    : lineItems.flatMap((item) => splitRoomNumberText(item.room_number));

  const source = lineItemNumbers.length > 0 ? lineItemNumbers : booking.room_numbers;
  return Array.from(new Set(source.map((room) => String(room ?? "").trim()).filter(Boolean)))
    .sort(compareRoomNumber);
}

function getLineItemDiscountAmount(item: TaxInvoiceLineItem): number {
  const explicit = Number(item.discount_amount ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const gross = Number(item.gross_amount ?? 0);
  const amount = Number(item.amount ?? 0);
  if (!Number.isFinite(gross) || !Number.isFinite(amount)) return 0;
  return Math.max(0, gross - amount);
}

/* ─── Amount in Words (Thai + English) ─── */

function numberToThaiWords(n: number): string {
  if (n === 0) return "ศูนย์บาทถ้วน";
  const units = ["", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
  const positions = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน", "ล้าน"];

  const intPart = Math.floor(Math.abs(n));
  const decPart = Math.round((Math.abs(n) - intPart) * 100);

  function groupToWords(num: number): string {
    if (num === 0) return "";
    let result = "";
    const str = String(num);
    const len = str.length;
    for (let i = 0; i < len; i++) {
      const digit = Number(str[i]);
      const pos = len - i - 1;
      if (digit === 0) continue;
      if (pos === 0 && digit === 1 && len > 1) {
        result += "เอ็ด";
      } else if (pos === 1 && digit === 1) {
        result += "สิบ";
      } else if (pos === 1 && digit === 2) {
        result += "ยี่สิบ";
      } else {
        result += units[digit] + positions[pos];
      }
    }
    return result;
  }

  function convert(num: number): string {
    if (num === 0) return "";
    if (num < 1000000) return groupToWords(num);
    const millions = Math.floor(num / 1000000);
    const remainder = num % 1000000;
    return convert(millions) + "ล้าน" + (remainder > 0 ? convert(remainder) : "");
  }

  let result = convert(intPart) + "บาท";
  if (decPart === 0) {
    result += "ถ้วน";
  } else {
    result += convert(decPart) + "สตางค์";
  }
  return result;
}

function numberToEnglishWords(n: number): string {
  if (n === 0) return "Zero baht only";
  const ones = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
    "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

  function convert(num: number): string {
    if (num === 0) return "";
    if (num < 20) return ones[num];
    if (num < 100) return tens[Math.floor(num / 10)] + (num % 10 ? " " + ones[num % 10] : "");
    if (num < 1000) return ones[Math.floor(num / 100)] + " hundred" + (num % 100 ? " " + convert(num % 100) : "");
    if (num < 1000000) return convert(Math.floor(num / 1000)) + " thousand" + (num % 1000 ? " " + convert(num % 1000) : "");
    if (num < 1000000000) return convert(Math.floor(num / 1000000)) + " million" + (num % 1000000 ? " " + convert(num % 1000000) : "");
    return convert(Math.floor(num / 1000000000)) + " billion" + (num % 1000000000 ? " " + convert(num % 1000000000) : "");
  }

  const intPart = Math.floor(Math.abs(n));
  const decPart = Math.round((Math.abs(n) - intPart) * 100);

  // Capitalize first letter
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  if (decPart === 0) {
    return cap(convert(intPart)) + " baht only";
  }
  return cap(convert(intPart)) + " baht and " + convert(decPart) + " satang";
}

function amountInWords(amount: number, lang: TaxInvoiceLanguage): string {
  return lang === "th" ? numberToThaiWords(amount) : numberToEnglishWords(amount);
}

/* ─── Seller Block ─── */

function sellerBlock(seller: TaxInvoiceSellerSnapshot, lang: TaxInvoiceLanguage) {
  const l = getLabels(lang);
  const mainName = lang === "en" && seller.company_name_en
    ? seller.company_name_en
    : seller.company_name || "";
  const hotelName = seller.hotel_name || "";
  // Company name (HQ) / Hotel name — hotel name in smaller lighter text
  const isHQ = seller.company_branch === "00000" || seller.company_branch?.includes("สำนักงานใหญ่");
  const branchText = isHQ ? ` (${l.hq})` : (seller.company_branch ? ` (${lang === "th" ? "สาขา" : "Branch"}: ${seller.company_branch})` : "");
  const hotelSuffix = hotelName ? ` <span class="seller-hotel">/ ${esc(hotelName)}</span>` : "";

  // Seller address — use English address for EN mode
  const address = lang === "en" && seller.company_address_en
    ? seller.company_address_en
    : seller.company_address || "";

  // Branch label after Tax ID: "| สาขา สำนักงานใหญ่" / "| Branch Head Office"
  const branchAfterTax = isHQ
    ? ` | ${lang === "th" ? "สาขา" : "Branch"} ${l.hq}`
    : (seller.company_branch ? ` | ${lang === "th" ? "สาขา" : "Branch"} ${seller.company_branch}` : "");

  return `
    <div class="seller-main">${esc(mainName)}${esc(branchText)}${hotelSuffix}</div>
    <div class="seller-line">${esc(address)}</div>
    <div class="seller-line">${esc(l.taxId)} ${esc(seller.company_tax_id || "")}${esc(branchAfterTax)}</div>
    ${seller.company_phone ? `<div class="seller-line">${lang === "th" ? "โทร" : "Tel"} ${esc(seller.company_phone)}</div>` : ""}
  `;
}

/* ─── Customer / Party Block ─── */

function partyBlock(data: InvoiceRenderData, lang: TaxInvoiceLanguage) {
  const l = getLabels(lang);
  const { customerName, customerAddress, customerTaxId, customerBranch, booking, lineItems } = data;
  const roomText = getDisplayRoomNumbers(booking, lineItems).join(", ") || "-";
  const stayDates = Array.from(
    new Set(
      lineItems
        .filter((item) => item.kind === "room_charge")
        .flatMap((item) => item.stay_dates ?? [])
    )
  ).sort();
  const displayCheckin = stayDates[0] ?? booking.checkin_date;
  const displayCheckout = stayDates.length > 0
    ? addOneDay(stayDates[stayDates.length - 1])
    : booking.checkout_date;

  // Tax ID line — include branch info inline: "Tax ID 024... | Branch HQ" or passport
  const isPassport = customerTaxId && !/^\d{13}$/.test(customerTaxId);
  let taxIdLine: string;
  if (isPassport && customerTaxId) {
    taxIdLine = `${l.taxId} ${customerTaxId} (Passport)`;
  } else if (customerTaxId) {
    const branchPart = customerBranch && customerBranch !== "-"
      ? ` | ${lang === "th" ? "สาขา" : "Branch"} ${customerBranch === "00000" ? l.hq : customerBranch}`
      : "";
    taxIdLine = `${l.taxId} ${customerTaxId}${branchPart}`;
  } else {
    taxIdLine = `${l.taxId} -`;
  }

  return `
    <div class="party-name">${esc(l.customer)} ${esc(customerName || "-")}</div>
    <div class="party-line">${esc(l.address)} ${esc(customerAddress || "-")}</div>
    <div class="party-line">${esc(taxIdLine)}</div>
    <div class="party-line">${esc(l.room)} ${esc(roomText)} | Check-in ${esc(fmtDate(displayCheckin, lang))} | Check-out ${esc(fmtDate(displayCheckout, lang))}</div>
  `;
}

/* ─── Items Table ─── */

function itemTable(items: TaxInvoiceLineItem[], lang: TaxInvoiceLanguage, startIndex = 0) {
  const l = getLabels(lang);

  const rows = items
    .map((it, idx) => {
      const description = formatTaxInvoiceItemDescription(it, lang);
      const unit = formatTaxInvoiceItemUnit(it, lang);
      return `
        <tr>
          <td class="center">${startIndex + idx + 1}</td>
          <td>
            <b>${esc(description)}</b>
            ${it.note ? `<br/><span class="item-note">${esc(it.note)}</span>` : ""}
          </td>
          <td class="center">${esc(String(it.quantity || 0))}</td>
          <td class="center">${esc(unit)}</td>
          <td class="num">${fmtMoney(it.unit_price)}</td>
          <td class="num">${fmtMoney(getLineItemDiscountAmount(it))}</td>
          <td class="num">${fmtMoney(it.amount)}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <table class="items" cellspacing="0" cellpadding="0">
      <thead>
        <tr>
          <th class="w-no">${esc(l.no)}</th>
          <th>${esc(l.item)}</th>
          <th class="w-qty">${esc(l.qty)}</th>
          <th class="w-unit">${esc(l.unit)}</th>
          <th class="w-price">${esc(l.unitPrice)}</th>
          <th class="w-discount">${esc(l.discount)}</th>
          <th class="w-amt">${esc(l.amount)}</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function continuationBlock(lang: TaxInvoiceLanguage, pageIndex: number, pageCount: number) {
  const text = lang === "th"
    ? `หน้าต่อไป / Continued (${pageIndex + 1}/${pageCount})`
    : `Continued on next page (${pageIndex + 1}/${pageCount})`;

  return `<div class="continuation">${esc(text)}</div>`;
}

/* ─── Summary Block ─── */

function summaryBlock(totals: TaxInvoiceTotals, lang: TaxInvoiceLanguage) {
  const l = getLabels(lang);
  return `
    <table class="summary" cellspacing="0" cellpadding="0">
      <tbody>
        <tr><td>${esc(l.discount)}</td><td class="num">${fmtMoney(totals.discount)}</td><td class="baht">${esc(l.baht)}</td></tr>
        <tr><td>${esc(l.subtotal)}</td><td class="num">${fmtMoney(totals.subtotal)}</td><td class="baht">${esc(l.baht)}</td></tr>
        <tr><td>${esc(l.vat)}</td><td class="num">${fmtMoney(totals.vat_amount)}</td><td class="baht">${esc(l.baht)}</td></tr>
        <tr class="total"><td>${esc(l.total)}</td><td class="num">${fmtMoney(totals.grand_total)}</td><td class="baht">${esc(l.baht)}</td></tr>
      </tbody>
    </table>
  `;
}

/* ─── Invoice Copy (Original / Copy) ─── */

function invoiceCopy(
  data: InvoiceRenderData,
  labelType: "original" | "copy",
  pageItems: TaxInvoiceLineItem[],
  pageIndex: number,
  pageCount: number,
  itemOffset: number
) {
  const { invoiceNo, issueDate, language: lang } = data;
  const l = getLabels(lang);
  const copyLabel = labelType === "original" ? l.original : l.copy;
  const amountWords = amountInWords(data.totals.grand_total, lang);
  const amountLabel = lang === "th" ? "จำนวนเงิน :" : "Amount :";
  const isFinalPage = pageIndex === pageCount - 1;
  const remarkText = String(data.remark ?? "").trim();
  const remarkHtml = remarkText
    ? esc(remarkText).replace(/\n/g, "<br>")
    : esc(l.ifAny);
  // ป.86/2542 ข้อ 9(2): one tax invoice made of several sheets, all carrying the
  // same invoice number, must state the words "แผ่นที่ ..." on each sheet. A bare
  // "1/2" is not that wording.
  const pageBadge = pageCount > 1
    ? `<div class="page-badge">${esc(`${l.sheetNo} ${pageIndex + 1}/${pageCount}`)}</div>`
    : "";

  return `
    <section class="invoice-copy">
      <div class="doc-head">
        <div class="seller">${sellerBlock(data.seller, lang)}</div>
        <div class="doc-title">
          <div class="th">${esc(getLabels("th").title)}</div>
          <div class="en">${esc(getLabels("en").title)}</div>
          <div class="label">${esc(copyLabel)}</div>
          ${pageBadge}
        </div>
      </div>

      <div class="party-row">
        <div class="party">${partyBlock(data, lang)}</div>
        <div class="meta">
          <div><span>${esc(l.invoiceNo)}</span><b>${esc(invoiceNo || l.pending)}</b></div>
          <div><span>${esc(l.date)}</span><b>${esc(fmtDate(issueDate, lang))}</b></div>
          <div><span>${esc(l.ref)}</span><b>-</b></div>
        </div>
      </div>

      ${itemTable(pageItems, lang, itemOffset)}

      ${isFinalPage ? `<div class="bottom-section">
        <div class="bottom-left">
          <div class="remark">
            <div class="remark-title">${esc(l.remark)}</div>
            <div class="remark-text">${remarkHtml}</div>
            <div class="amount-words">
              <span class="amount-words-label">${esc(amountLabel)}</span>
              <span class="amount-words-box">${esc(amountWords)}</span>
            </div>
          </div>
          <div class="sig-col">
            <div class="sig-line"></div>
            <div class="sig-label">${esc(l.cashier)}</div>
          </div>
        </div>
        <div class="bottom-right">
          ${summaryBlock(data.totals, lang)}
          <div class="sig-col">
            <div class="sig-name">นาย ตัวอย่าง สมมุติ</div>
            <div class="sig-label">${esc(l.manager)}</div>
          </div>
        </div>
      </div>` : continuationBlock(lang, pageIndex, pageCount)}
    </section>
  `;
}

/* ─── Main Render ─── */

export function renderInvoiceA4Html(data: InvoiceRenderData) {
  const css = `
  @font-face {
    font-family: "TH Sarabun New";
    src: url("/fonts/THSarabunNew.ttf") format("truetype");
    font-weight: normal;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: "TH Sarabun New";
    src: url("/fonts/THSarabunNew Bold.ttf") format("truetype");
    font-weight: bold;
    font-style: normal;
    font-display: swap;
  }

  @page { size: A4 portrait; margin: 0mm; }

  html, body {
    margin: 0;
    padding: 0;
    width: 210mm;
    min-height: 297mm;
    background: #fff;
    color: #111827;
  }

  * {
    box-sizing: border-box;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  body {
    --font-scale: 1.45;
    font-family: "TH Sarabun New", "Sarabun", "Noto Sans Thai", Tahoma, Arial, sans-serif;
  }

  .paper {
    width: 210mm;
    min-height: 297mm;
    display: flex;
    flex-direction: column;
    page-break-after: always;
    break-after: page;
  }

  .paper:last-child {
    page-break-after: auto;
    break-after: auto;
  }

  .sheet {
    width: 100%;
    height: 148.5mm;
    padding: 7mm;
  }

  .sheet + .sheet {
    border-top: 0.15mm dashed rgba(20, 83, 45, 0.3);
    margin-top: -0.05mm;
  }

  .invoice-copy {
    width: 100%;
    height: 100%;
    border: 0.25mm solid rgba(20, 83, 45, 0.6);
    padding: 6mm 7mm;
    display: flex;
    flex-direction: column;
    gap: 1.5mm;
  }

  .doc-head {
    display: flex;
    justify-content: space-between;
    gap: 4mm;
  }

  .seller {
    flex: 1;
    min-width: 0;
  }

  .seller-main {
    font-size: calc(10pt * var(--font-scale));
    font-weight: bold;
    line-height: 1.1;
    margin-bottom: 0.8mm;
  }

  .seller-hotel {
    font-size: calc(8pt * var(--font-scale));
    font-weight: normal;
    color: #4b5563;
  }

  .seller-line {
    font-size: calc(8pt * var(--font-scale));
    line-height: 1.15;
    text-wrap: pretty;
  }

  .doc-title {
    width: 62mm;
    text-align: center;
    position: relative;
  }

  .doc-title .th {
    font-size: calc(15pt * var(--font-scale));
    font-weight: 800;
    color: #14532d;
    line-height: 1.05;
  }

  .doc-title .en {
    font-size: calc(8pt * var(--font-scale));
    font-weight: 600;
    color: #4b5563;
    margin-top: 0.1mm;
    line-height: 1.0;
  }

  .doc-title .label {
    font-size: calc(10.5pt * var(--font-scale));
    font-weight: bold;
    margin-top: 1mm;
    padding: 0.5mm 0;
  }

  .page-badge {
    margin-top: 0.6mm;
    font-size: calc(7.5pt * var(--font-scale));
    font-weight: 700;
    color: #4b5563;
  }

  .party-row {
    display: flex;
    justify-content: space-between;
    gap: 4mm;
  }

  .party {
    flex: 1;
    min-width: 0;
  }

  .party-name {
    font-size: calc(9.5pt * var(--font-scale));
    font-weight: bold;
    line-height: 1.1;
    margin-bottom: 0.6mm;
  }

  .party-line {
    font-size: calc(8.4pt * var(--font-scale));
    line-height: 1.15;
  }

  .meta {
    width: 54mm;
    border: 0.25mm solid rgba(20, 83, 45, 0.5);
    padding: 1mm 1.5mm;
  }

  .meta div {
    display: flex;
    justify-content: space-between;
    gap: 2mm;
    font-size: calc(8.5pt * var(--font-scale));
    line-height: 1.25;
  }

  .meta span {
    font-weight: 600;
  }

  .items {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    margin-top: 0.4mm;
    border-top: 0.4mm solid #14532d;
    border-bottom: 0.4mm solid #14532d;
  }

  .items th {
    padding: 1mm 0.8mm;
    font-size: calc(8pt * var(--font-scale));
    font-weight: bold;
    border-bottom: 0.2mm solid rgba(20, 83, 45, 0.5);
    text-align: center;
  }

  .items td {
    padding: 1.5mm 1.2mm;
    font-size: calc(8.6pt * var(--font-scale));
    line-height: 1.2;
    vertical-align: top;
    border-bottom: 0.1mm solid rgba(20, 83, 45, 0.1);
    /* The columns are already fixed-width (table-layout: fixed), but a long
       unbroken token still paints outside its cell and lands on top of the
       qty / price / amount columns. Breaking it keeps the money readable; the
       extra lines it costs are absorbed by paginateLineItems. */
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .item-note {
    font-size: 0.85em;
    color: #4b5563;
    font-style: italic;
  }

  .w-no { width: 9mm; }
  .w-qty { width: 11mm; }
  .w-unit { width: 13mm; }
  .w-price { width: 22mm; }
  .w-discount { width: 18mm; }
  .w-amt { width: 24mm; }

  .center { text-align: center; }
  .num { text-align: right; }

  .continuation {
    margin-top: auto;
    padding-top: 2mm;
    text-align: right;
    font-size: calc(8pt * var(--font-scale));
    font-style: italic;
    color: #4b5563;
  }

  /* ── Bottom section: left (remark + staff sig) | right (summary + manager sig) ── */
  .bottom-section {
    display: flex;
    gap: 10mm;
    margin-top: auto;
  }

  .bottom-left {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    min-width: 0;
  }

  .bottom-right {
    width: 72mm;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }

  .remark {
    /* fills top of bottom-left */
  }

  .remark-title {
    font-size: calc(8.5pt * var(--font-scale));
    font-weight: bold;
  }

  .remark-text {
    font-size: calc(7.5pt * var(--font-scale));
    margin-top: 1mm;
    padding-left: 2mm;
  }

  .amount-words {
    margin-top: 3mm;
    display: flex;
    align-items: center;
    gap: 1.5mm;
    font-size: calc(8.5pt * var(--font-scale));
    line-height: 1.4;
  }

  .amount-words-label {
    font-weight: bold;
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* flex:1 + min-width:0 → fills remaining space of .bottom-left, aligns with sig-line */
  .amount-words-box {
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    padding: 1mm 2mm;
    background: #f3f4f6;
    border-radius: 0.5mm;
    font-weight: 500;
    text-align: center;
  }

  .summary {
    width: 100%;
    border-collapse: collapse;
  }

  .summary td {
    font-size: calc(9pt * var(--font-scale));
    line-height: 1.2;
    padding: 0.2mm 0;
  }

  .summary .baht {
    width: 10mm;
    text-align: right;
  }

  .summary .total td {
    font-weight: bold;
    padding-top: 1mm;
  }

  .sig-col {
    text-align: center;
    margin-top: 2mm;
  }

  .sig-line {
    height: 8mm;
    border-bottom: 0.3mm solid #374151;
  }

  .sig-name {
    height: 8mm;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    font-size: calc(9pt * var(--font-scale));
    font-weight: bold;
    padding-bottom: 0.5mm;
  }

  .sig-label {
    margin-top: 1mm;
    font-size: calc(8.4pt * var(--font-scale));
    font-weight: 600;
  }

  @media print {
    body { background: #fff; }
    .sheet + .sheet { border-top-style: dashed; }
  }
  `;

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>Invoice - ${esc(data.invoiceNo || "draft")}</title>
      <style>${css}</style>
    </head>
    <body onload="window.focus();">
      ${paginateLineItems(data.lineItems)
        .map((pageItems, pageIndex, pages) => {
          const itemOffset = pages
            .slice(0, pageIndex)
            .reduce((sum, current) => sum + current.length, 0);
          return `<main class="paper">
        <div class="sheet">${invoiceCopy(data, "original", pageItems, pageIndex, pages.length, itemOffset)}</div>
        <div class="sheet">${invoiceCopy(data, "copy", pageItems, pageIndex, pages.length, itemOffset)}</div>
      </main>`;
        })
        .join("")}
    </body>
  </html>`;
}
