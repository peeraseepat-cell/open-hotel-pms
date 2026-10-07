// Folding an extra charge into a room line must leave the line internally
// consistent, because the invoice total is summed from `gross_amount` (via
// itemGrossAmount) and NOT from `amount`.
//
// Raising `amount` alone on a line that already carries a stored `gross_amount`
// prints one number and totals another. Reported in review; measured
// at THB 100 on the IV260807 shape before this fix.

import { mergeExtraIntoRoomLines } from "./merge-extra-into-room";
import { itemDiscountAmount, itemGrossAmount } from "./trim-room-line";
import type { TaxInvoiceLineItem } from "./types";

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(`${message ?? "mismatch"}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

/** What the form's totals row computes, reduced to one number. */
function documentTotal(items: TaxInvoiceLineItem[]): number {
  const gross = items.reduce((n, i) => n + itemGrossAmount(i), 0);
  const discount = items.reduce((n, i) => n + itemDiscountAmount(i), 0);
  return Math.round((gross - discount) * 100) / 100;
}

/** The invariant every line must hold. */
function assertLinesConsistent(items: TaxInvoiceLineItem[], label: string) {
  items.forEach((item, i) => {
    const derived = Math.round((itemGrossAmount(item) - itemDiscountAmount(item)) * 100) / 100;
    if (derived !== item.amount) {
      throw new Error(
        `${label}: line ${i} (${item.description}) — amount ${item.amount} but gross-discount ${derived}`
      );
    }
  });
}

const extra = { id: "folio-extra-1", amount: 100, reservation_id: "res-204" };

// ── The gate's case: a SAVED merged line, which carries gross_amount ─────────
const savedMerged: TaxInvoiceLineItem = {
  kind: "room_charge",
  description: "ค่าห้องพัก 4 ห้อง (19/8/2569)",
  quantity: 4,
  room_count: 4,
  unit: "คืน",
  unit_price: 490,
  gross_amount: 1960,
  discount_amount: 0,
  amount: 1960,
  stay_dates: ["2026-08-19"],
  room_number: "204,228,232,238",
  reservation_id: null,
};

// "This night" — the extra lands on a named night.
const thisNight = mergeExtraIntoRoomLines([savedMerged], extra, ["2026-08-19"]);
assertEqual(thisNight.length, 1, "one night in, one line out");
assertEqual(thisNight[0].amount, 2060, "This night: the room line absorbs the charge");
assertEqual(thisNight[0].gross_amount, 2060, "This night: gross moved with amount");
assertEqual(documentTotal(thisNight), 2060, "This night: the DOCUMENT totals what the line shows");
assertEqual(thisNight[0].quantity, 4, "This night: still four room-nights");
assertEqual(thisNight[0].merged_extra_charge_total, 100, "This night: the fold is traceable");
assertLinesConsistent(thisNight, "This night");

// "Avg room" — spread across every night of the invoice (here, the same night).
const avgRoom = mergeExtraIntoRoomLines([savedMerged], extra, ["2026-08-19"], ["2026-08-19"]);
assertEqual(avgRoom[0].amount, 2060, "Avg room: same single-night result");
assertEqual(documentTotal(avgRoom), 2060, "Avg room: document agrees with the line");
assertLinesConsistent(avgRoom, "Avg room");

// ── Multi-night merged line, charge on ONE night: the split must not reprice ──
const savedMergedTwoNights: TaxInvoiceLineItem = {
  ...savedMerged,
  description: "ค่าห้องพัก 4 ห้อง (19-20/8/2569)",
  quantity: 8,
  gross_amount: 3920,
  amount: 3920,
  stay_dates: ["2026-08-19", "2026-08-20"],
};

const oneOfTwo = mergeExtraIntoRoomLines([savedMergedTwoNights], extra, ["2026-08-20"]);
assertEqual(oneOfTwo.length, 2, "the line splits into charged and uncharged nights");
assertEqual(documentTotal(oneOfTwo), 4020, "nothing is lost or invented across the split");
assertEqual(oneOfTwo.reduce((n, i) => n + i.quantity, 0), 8, "room-nights are conserved");
assertLinesConsistent(oneOfTwo, "one of two nights");

// ── Discounted line: the discount must not be swallowed by the fold ──────────
const discounted: TaxInvoiceLineItem = {
  kind: "room_charge",
  description: "ค่าห้องพัก (19/8/2569)",
  quantity: 1,
  unit: "คืน",
  unit_price: 900,
  gross_amount: 1000,
  discount_amount: 100,
  amount: 900,
  stay_dates: ["2026-08-19"],
  room_number: "204",
  reservation_id: "res-204",
};

const withDiscount = mergeExtraIntoRoomLines([discounted], extra, ["2026-08-19"]);
assertEqual(withDiscount[0].amount, 1000, "net rises by the charge, not by the discount");
assertEqual(withDiscount[0].discount_amount, 100, "the discount survives untouched");
assertEqual(withDiscount[0].gross_amount, 1100, "gross carries both");
assertEqual(documentTotal(withDiscount), 1000, "document total matches the line");
assertLinesConsistent(withDiscount, "discounted");

// ── A room line with NO stay_dates takes the whole charge (the other branch) ─
// Reached by lines the folio could not date. Found by mutation testing: every
// case above carries stay_dates, so this path had no guard at all.
const undated: TaxInvoiceLineItem = {
  kind: "room_charge",
  description: "ค่าห้องพัก",
  quantity: 2,
  unit: "คืน",
  unit_price: 490,
  gross_amount: 1080,
  discount_amount: 100,
  amount: 980,
  room_number: "204",
  reservation_id: "res-204",
};

const undatedOut = mergeExtraIntoRoomLines([undated], extra, ["2026-08-19"], ["2026-08-19"]);
assertEqual(undatedOut.length, 1, "undated: still one line");
assertEqual(undatedOut[0].amount, 1080, "undated: net rises by the charge");
assertEqual(undatedOut[0].gross_amount, 1180, "undated: gross moved with amount");
assertEqual(undatedOut[0].discount_amount, 100, "undated: discount untouched");
assertEqual(documentTotal(undatedOut), 1080, "undated: document agrees with the line");
assertEqual(undatedOut[0].merged_extra_charge_total, 100, "undated: the fold is traceable");
assertLinesConsistent(undatedOut, "undated");

// ── A SECOND charge on the same line must not undo the first ───────────────
// The nightly rate is derived by stripping extras already folded in; if those
// are not added back, fold #2 silently reverses fold #1. Caught by the
// EXTRA_PRICE work: 490 + 100 + 50 was reading 540.
const foldOnce = mergeExtraIntoRoomLines([discounted], extra, ["2026-08-19"]);
const foldTwice = mergeExtraIntoRoomLines(
  foldOnce,
  { id: "folio-extra-2", amount: 50, reservation_id: "res-204" },
  ["2026-08-19"]
);
assertEqual(foldTwice.length, 1, "second fold: still one line");
assertEqual(foldTwice[0].amount, 1050, "second fold: 900 + 100 + 50, the first charge survives");
assertEqual(foldTwice[0].merged_extra_charge_total, 150, "second fold: both charges accounted for");
assertEqual(foldTwice[0].merged_extra_charge_ids?.length, 2, "second fold: both folio rows referenced");
assertEqual(documentTotal(foldTwice), 1050, "second fold: document agrees");
assertLinesConsistent(foldTwice, "second fold");

// ── A charge for another reservation must not attach here ───────────────────
const otherReservation = mergeExtraIntoRoomLines(
  [discounted],
  { id: "folio-extra-9", amount: 500, reservation_id: "res-999" },
  ["2026-08-19"]
);
assertEqual(otherReservation[0].amount, 900, "an unrelated charge leaves the line alone");
assertEqual(otherReservation[0].merged_extra_charge_ids, undefined, "and leaves no back-pointer");

// ── Splitting one charge across two rooms must re-add to the charge ─────────
const roomA: TaxInvoiceLineItem = { ...discounted, room_number: "204", reservation_id: "res-204" };
const roomB: TaxInvoiceLineItem = { ...discounted, room_number: "228", reservation_id: "res-204" };
const twoRooms = mergeExtraIntoRoomLines([roomA, roomB], extra, ["2026-08-19"]);
assertEqual(documentTotal(twoRooms), 1900, "1,800 of room plus exactly 100 of charge");
assertEqual(
  twoRooms.reduce((n, i) => n + (i.merged_extra_charge_total ?? 0), 0),
  100,
  "the shares re-add to the charge, with no rounding leak"
);
assertLinesConsistent(twoRooms, "two rooms");

console.log("merge-extra-into-room: line and document agree across 9 cases, both branches");
