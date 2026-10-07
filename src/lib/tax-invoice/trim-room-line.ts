import type { TaxInvoiceLineItem } from "./types";
import { round2 } from "./utils";

export function itemGrossAmount(item: TaxInvoiceLineItem): number {
  const gross = Number(item.gross_amount ?? 0);
  if (Number.isFinite(gross) && gross > 0) return gross;
  return round2(Number(item.amount || 0) + Number(item.discount_amount || 0));
}

export function itemDiscountAmount(item: TaxInvoiceLineItem): number {
  const explicit = Number(item.discount_amount ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return round2(explicit);
  return Math.max(0, round2(itemGrossAmount(item) - Number(item.amount || 0)));
}

/**
 * Narrow a room line to the nights the invoice actually covers.
 *
 * `quantity` is NOT the night count on a merged line — it is room-nights
 * (4 rooms x 1 night = 4). Scaling by it divided merged lines by their room
 * count on every edit-screen render, which is how IV260807 lost THB 1,470.
 *
 * Nights come from `stay_dates`; rooms come from `room_count`.
 */
export function trimRoomLineItemToDates(item: TaxInvoiceLineItem, dates: string[]): TaxInvoiceLineItem {
  const sourceDates = item.stay_dates?.length ? item.stay_dates : dates;
  const sourceNights = Math.max(1, sourceDates.length);
  const roomCount = Math.max(1, Number(item.room_count || 1));
  const ratio = dates.length / sourceNights;
  const gross = round2(itemGrossAmount(item) * ratio);
  const discount = round2(itemDiscountAmount(item) * ratio);
  const amount = Math.max(0, round2(gross - discount));
  const quantity = dates.length * roomCount;

  return {
    ...item,
    stay_dates: dates,
    quantity,
    gross_amount: gross,
    discount_amount: discount,
    amount,
    unit_price: round2(gross / Math.max(1, quantity)),
  };
}
