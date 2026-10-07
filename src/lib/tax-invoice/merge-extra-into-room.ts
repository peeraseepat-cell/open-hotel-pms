import type { TaxInvoiceAvailableExtraItem, TaxInvoiceLineItem } from "./types";
import { itemDiscountAmount, itemGrossAmount } from "./trim-room-line";
import { round2 } from "./utils";

/**
 * Fold a folio extra charge into the room line(s) it belongs to, so the invoice
 * shows one topped-up room rate instead of a separate service line.
 *
 * Two invariants this function exists to hold, both of them money:
 *
 *  1. `amount === gross_amount - discount_amount`. Totals are summed through
 *     `itemGrossAmount()`, which PREFERS a stored `gross_amount` over deriving
 *     one. Raising `amount` while leaving a stored `gross_amount` behind makes
 *     the printed line and the invoice total disagree — the line reads 2,060
 *     while the document totals 1,960.
 *
 *  2. On a merged line, `quantity` is room-nights and the per-night amount
 *     covers every room in it. Dividing by `quantity` to get a nightly rate
 *     silently reprices four rooms as one.
 *
 * The share-out across candidate lines is unchanged: proportional to nights,
 * with the remainder landing on the last line so the pieces re-add to the exact
 * charge.
 */
export function mergeExtraIntoRoomLines(
  lineItems: TaxInvoiceLineItem[],
  extra: Pick<TaxInvoiceAvailableExtraItem, "id" | "amount" | "reservation_id">,
  targetDates: string[],
  fallbackNights: string[] = []
): TaxInvoiceLineItem[] {
  const targetDateSet = new Set(targetDates);
  if (targetDateSet.size === 0) return lineItems;

  const candidateMeta = lineItems
    .map((item, index) => {
      if (item.kind !== "room_charge") return null;
      if (item.reservation_id && item.reservation_id !== extra.reservation_id) return null;
      const dates = (item.stay_dates?.length ? item.stay_dates : fallbackNights).filter((date) =>
        targetDateSet.has(date)
      );
      if (dates.length === 0) return null;
      return { index, dates };
    })
    .filter((row): row is { index: number; dates: string[] } => Boolean(row));

  if (candidateMeta.length === 0) return lineItems;

  const totalTargetNights = candidateMeta.reduce((sum, row) => sum + row.dates.length, 0);
  let allocated = 0;
  const shareByIndex = new Map<number, number>();
  candidateMeta.forEach((row, rowIndex) => {
    const share = rowIndex === candidateMeta.length - 1
      ? round2(extra.amount - allocated)
      : round2((extra.amount * row.dates.length) / Math.max(1, totalTargetNights));
    allocated = round2(allocated + share);
    shareByIndex.set(row.index, share);
  });

  return lineItems.flatMap((item, index) => {
    const extraAmount = shareByIndex.get(index);
    if (!extraAmount || item.kind !== "room_charge") return [item];

    const roomCount = Math.max(1, Number(item.room_count || 1));
    const allDates = item.stay_dates?.length ? [...item.stay_dates].sort() : [];
    const selectedDates = allDates.filter((date) => targetDateSet.has(date));

    // No date detail to split on — the whole line takes the charge.
    if (allDates.length === 0 || selectedDates.length === 0) {
      const discount = itemDiscountAmount(item);
      const gross = round2(itemGrossAmount(item) + extraAmount);
      const amount = Math.max(0, round2(gross - discount));
      const quantity = Number(item.quantity || 1) || 1;
      return [{
        ...item,
        gross_amount: gross,
        discount_amount: discount,
        amount,
        unit_price: round2(amount / Math.max(1, quantity)),
        merged_extra_charge_ids: [...(item.merged_extra_charge_ids ?? []), extra.id],
        merged_extra_charge_total: round2((item.merged_extra_charge_total ?? 0) + extraAmount),
        note: item.note,
      }];
    }

    const unaffectedBefore = allDates.filter((date) => !targetDateSet.has(date) && date < selectedDates[0]);
    const unaffectedAfter = allDates.filter((date) => !targetDateSet.has(date) && date > selectedDates[selectedDates.length - 1]);
    const untouchedOther = allDates.filter(
      (date) => !targetDateSet.has(date) && !unaffectedBefore.includes(date) && !unaffectedAfter.includes(date)
    );

    const nights = Math.max(1, allDates.length);
    const baseExtraTotal = item.merged_extra_charge_total ?? 0;
    // Strip previously merged extras before deriving a nightly rate — they are
    // not part of the room's own price, and they do not scale with nights.
    const baseAmountPerNight = round2(Math.max(0, round2(item.amount - baseExtraTotal)) / nights);
    const baseDiscountPerNight = round2(itemDiscountAmount(item) / nights);

    const makeRoomLine = (dates: string[], mergeAmount = 0): TaxInvoiceLineItem | null => {
      if (dates.length === 0) return null;
      // Extras already folded in were stripped out to derive a nightly room rate;
      // they ride along with the line receiving the new one. Without this they
      // are simply lost, and a second fold silently reverses the first — the
      // room reads 540 after 490 + 100 + 50. Money over the whole split is then
      // exactly item.amount + mergeAmount.
      const carriedExtras = mergeAmount > 0 ? baseExtraTotal : 0;
      const amount = round2(baseAmountPerNight * dates.length + mergeAmount + carriedExtras);
      const discount = round2(baseDiscountPerNight * dates.length);
      const quantity = dates.length * roomCount;
      return {
        ...item,
        stay_dates: dates,
        quantity,
        gross_amount: round2(amount + discount),
        discount_amount: discount,
        amount,
        unit_price: round2(amount / Math.max(1, quantity)),
        merged_extra_charge_ids: mergeAmount > 0
          ? [...(item.merged_extra_charge_ids ?? []), extra.id]
          : item.merged_extra_charge_ids,
        merged_extra_charge_total: mergeAmount > 0
          ? round2((item.merged_extra_charge_total ?? 0) + mergeAmount)
          : item.merged_extra_charge_total,
        note: item.note,
      };
    };

    return [
      makeRoomLine(unaffectedBefore),
      makeRoomLine(untouchedOther),
      makeRoomLine(selectedDates, extraAmount),
      makeRoomLine(unaffectedAfter),
    ].filter((row): row is TaxInvoiceLineItem => Boolean(row));
  });
}
