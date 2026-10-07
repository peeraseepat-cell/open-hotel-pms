import type { TaxInvoiceLineItem, TaxInvoiceTotals, TaxInvoiceLanguage } from "@/lib/tax-invoice/types";

export function toBangkokDate(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function toInvoiceYearYY(dateLike?: string | Date | null): string {
  let date = new Date();
  if (typeof dateLike === "string" && dateLike.trim()) {
    const parsed = new Date(`${dateLike.trim()}T00:00:00+07:00`);
    if (!Number.isNaN(parsed.getTime())) {
      date = parsed;
    }
  } else if (dateLike instanceof Date && !Number.isNaN(dateLike.getTime())) {
    date = dateLike;
  }

  const year = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Bangkok",
    year: "2-digit",
  }).format(date);
  return year;
}

export function toInvoiceYearMonthYYMM(dateLike?: string | Date | null): string {
  let date = new Date();
  if (typeof dateLike === "string" && dateLike.trim()) {
    const parsed = new Date(`${dateLike.trim()}T00:00:00+07:00`);
    if (!Number.isNaN(parsed.getTime())) {
      date = parsed;
    }
  } else if (dateLike instanceof Date && !Number.isNaN(dateLike.getTime())) {
    date = dateLike;
  }

  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Bangkok",
    year: "2-digit",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? toInvoiceYearYY(date);
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  return `${year}${month}`;
}

export function round2(value: number): number {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export function normalizeMoney(value: unknown): number {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return round2(n);
}

export function compareRoomNumber(left: string, right: string): number {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function groupConsecutiveDates(sortedDates: string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];

  const toDate = (iso: string) => new Date(`${iso}T00:00:00+07:00`);

  for (const date of sortedDates) {
    if (current.length === 0) {
      current = [date];
      continue;
    }

    const prev = current[current.length - 1];
    const prevDate = toDate(prev);
    const thisDate = toDate(date);
    const diffDays = Math.round((thisDate.getTime() - prevDate.getTime()) / (24 * 60 * 60 * 1000));

    if (diffDays === 1) {
      current.push(date);
    } else {
      groups.push(current);
      current = [date];
    }
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

export function formatThaiDate(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  const [yyyy, mm, dd] = isoDate.split("-");
  const beYear = Number(yyyy) + 543;
  return `${Number(dd)}/${Number(mm)}/${beYear}`;
}

export function formatThaiDateLabelFromDates(sortedDates: string[]): string {
  return formatDateLabelFromDates(sortedDates, "th");
}

export function formatDateLabelFromDates(sortedDates: string[], lang: TaxInvoiceLanguage): string {
  if (!sortedDates.length) return "-";

  const groups = groupConsecutiveDates(sortedDates);
  const yearOffset = lang === "th" ? 543 : 0;
  const formatSingle = (isoDate: string): string => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
    const [yyyy, mm, dd] = isoDate.split("-");
    return `${Number(dd)}/${Number(mm)}/${Number(yyyy) + yearOffset}`;
  };

  const labels = groups.map((dates) => {
    if (dates.length === 1) {
      return formatSingle(dates[0]);
    }

    const first = dates[0];
    const last = dates[dates.length - 1];
    const [fy, fm, fd] = first.split("-");
    const [ly, lm, ld] = last.split("-");

    if (fy === ly && fm === lm) {
      return `${Number(fd)}-${Number(ld)}/${Number(fm)}/${Number(fy) + yearOffset}`;
    }

    return `${formatSingle(first)}-${formatSingle(last)}`;
  });

  return labels.join(", ");
}

export function computeVatInclusiveTotals(
  grossTotal: number,
  discount: number,
  vatRate = 0.07
): TaxInvoiceTotals {
  const safeGross = Math.max(0, round2(grossTotal));
  const safeDiscount = Math.max(0, round2(discount));
  const grandTotal = Math.max(0, round2(safeGross - safeDiscount));

  const subtotal = round2(grandTotal / (1 + vatRate));
  const vatAmount = round2(grandTotal - subtotal);

  return {
    subtotal,
    vat_rate: vatRate,
    vat_amount: vatAmount,
    grand_total: grandTotal,
    discount: safeDiscount,
  };
}

/**
 * Escapes common HTML special characters.
 */
export function esc(s: string) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Formats a number to 2 decimal places.
 */
export function fmtMoney(n: number | string) {
  const v = Number(n || 0);
  return v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatTaxInvoiceItemDescription(item: TaxInvoiceLineItem, lang: TaxInvoiceLanguage): string {
  const description = String(item.description || "").trim();
  if (item.kind === "room_charge" && item.stay_dates?.length) {
    const dateLabel = formatDateLabelFromDates(Array.from(new Set(item.stay_dates)).sort(), lang);
    const roomCount = Number(item.room_count || 0);
    if (roomCount > 1) {
      return lang === "en"
        ? `Room charge ${roomCount} rooms (${dateLabel})`
        : `ค่าห้องพัก ${roomCount} ห้อง (${dateLabel})`;
    }
    return lang === "en" ? `Room charge (${dateLabel})` : `ค่าห้องพัก (${dateLabel})`;
  }
  if (lang !== "en" && item.kind === "room_charge") {
    return description.replace(/^ค่าห้อง(?!พัก)\s*/i, "ค่าห้องพัก ").trim();
  }
  if (lang !== "en" || item.kind !== "room_charge") return description;

  return description
    .replace(/^ค่าห้องพัก\s*Room\s*/i, "Room charge ")
    .replace(/^ค่าห้องพัก\s*/i, "Room charge ")
    .replace(/^ค่าห้อง\s*Room\s*/i, "Room charge ")
    .replace(/^ค่าห้อง\s*/i, "Room charge ")
    .trim();
}

export function formatTaxInvoiceItemUnit(item: TaxInvoiceLineItem, lang: TaxInvoiceLanguage): string {
  const unit = String(item.unit || "").trim();
  if (lang !== "en") return unit;
  if (item.kind === "room_charge" && unit === "คืน") return Number(item.quantity) === 1 ? "Night" : "Nights";
  if (item.kind === "extra_charge" && unit === "รายการ") return "Item";
  return unit;
}

/**
 * Formats an ISO date string to DD/MM/YYYY.
 * If language is 'th', it uses the Buddhist calendar year (+543).
 */
export function fmtDate(iso: string | null | undefined, lang: TaxInvoiceLanguage) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;

  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yearOffset = lang === "th" ? 543 : 0;
  const yyyy = String(d.getFullYear() + yearOffset);

  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Returns labels for the Tax Invoice based on language.
 */
export function getLabels(lang: TaxInvoiceLanguage) {
  return lang === "en"
    ? {
        title: "Receipt/Tax Invoice",
        customer: "Customer",
        address: "Address",
        taxId: "Tax ID",
        branch: "Branch",
        room: "Room",
        invoiceNo: "Invoice No.",
        date: "Date",
        ref: "Reference",
        no: "No.",
        item: "Description",
        qty: "Qty",
        unit: "Unit",
        unitPrice: "Unit Price",
        discount: "Discount",
        amount: "Amount (THB)",
        remark: "Remark",
        ifAny: "(if any)",
        subtotal: "Subtotal (Before VAT)",
        vat: "VAT 7%",
        total: "Grand Total",
        baht: "THB",
        pending: "pending",
        cashier: "Collection Staff",
        manager: "Hotel Manager",
        original: "Original",
        copy: "Copy",
        sheetNo: "แผ่นที่ / Sheet",
        hq: "Head Office",
      }
    : {
        title: "ใบเสร็จรับเงิน/ใบกำกับภาษี",
        customer: "ลูกค้า",
        address: "ที่อยู่",
        taxId: "เลขประจำตัวผู้เสียภาษี",
        branch: "สาขา",
        room: "ห้อง",
        invoiceNo: "เลขที่ Invoice",
        date: "วันที่",
        ref: "อ้างอิง",
        no: "ลำดับ",
        item: "รายการ",
        qty: "จำนวน",
        unit: "หน่วย",
        unitPrice: "ราคา/หน่วย",
        discount: "ส่วนลด",
        amount: "จำนวนเงิน (บาท)",
        remark: "หมายเหตุ",
        ifAny: "(หากมี)",
        subtotal: "รวมเป็นเงิน (ก่อน VAT)",
        vat: "ภาษีมูลค่าเพิ่ม 7%",
        total: "จำนวนเงินทั้งสิ้น",
        baht: "บาท",
        pending: "รอเลขจากระบบ",
        cashier: "พนักงานเก็บเงิน",
        manager: "ผู้จัดการโรงแรม",
        original: "ต้นฉบับ / Original",
        copy: "สำเนา / Copy",
        sheetNo: "แผ่นที่",
        hq: "สำนักงานใหญ่",
      };
}
