// Trimming a room line to the invoice's date range must not depend on
// `quantity` meaning "nights".
//
// On a MERGED room line, `quantity` is room-nights (4 rooms x 1 night = 4),
// while `stay_dates` still holds 1 date. The old ratio `dates.length / quantity`
// therefore divided a merged line by its room count every time the edit screen
// re-applied the (unchanged) date range — turning IV260807's THB 1,960 into 490.
//
// Nights come from `stay_dates`. Rooms come from `room_count`. Never from `quantity`.

import { trimRoomLineItemToDates } from "./trim-room-line";
import type { TaxInvoiceLineItem } from "./types";

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(`${message ?? "mismatch"}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message ?? "mismatch"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── T9 — the IV260807 shape: 4 rooms, 1 night, merged into one line ──────────
// Re-applying the line's own date range must be a no-op on the money.
const mergedOneNight: TaxInvoiceLineItem = {
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
};

const t9 = trimRoomLineItemToDates(mergedOneNight, ["2026-08-19"]);
assertEqual(t9.amount, 1960, "T9 merged 4-room line keeps its amount");
assertEqual(t9.gross_amount, 1960, "T9 gross survives");
assertEqual(t9.quantity, 4, "T9 quantity stays room-nights");
assertEqual(t9.unit_price, 490, "T9 unit price stays per room-night");
assertDeepEqual(t9.stay_dates, ["2026-08-19"], "T9 dates unchanged");

// ── T10 — regression guard: the plain single-room case must not move ─────────
const singleRoomTwoNights: TaxInvoiceLineItem = {
  kind: "room_charge",
  description: "ค่าห้องพัก (11-12/5/2569)",
  quantity: 2,
  unit: "คืน",
  unit_price: 490,
  gross_amount: 980,
  discount_amount: 0,
  amount: 980,
  stay_dates: ["2026-05-11", "2026-05-12"],
  room_number: "201",
};

const t10 = trimRoomLineItemToDates(singleRoomTwoNights, ["2026-05-11"]);
assertEqual(t10.amount, 490, "T10 one night of two costs half");
assertEqual(t10.quantity, 1, "T10 quantity is nights when there is one room");
assertEqual(t10.unit_price, 490, "T10 unit price unchanged");

// ── T11 — merged AND multi-night: both dimensions at once ───────────────────
const mergedTwoNights: TaxInvoiceLineItem = {
  ...mergedOneNight,
  description: "ค่าห้องพัก 4 ห้อง (19-20/8/2569)",
  quantity: 8,
  gross_amount: 3920,
  amount: 3920,
  stay_dates: ["2026-08-19", "2026-08-20"],
};

const t11 = trimRoomLineItemToDates(mergedTwoNights, ["2026-08-19"]);
assertEqual(t11.amount, 1960, "T11 one night of two, across 4 rooms");
assertEqual(t11.quantity, 4, "T11 quantity is nights x rooms");
assertEqual(t11.unit_price, 490, "T11 unit price still per room-night");

// ── T12 — discounts scale with nights, not with rooms ───────────────────────
const mergedWithDiscount: TaxInvoiceLineItem = {
  ...mergedOneNight,
  gross_amount: 1960,
  discount_amount: 100,
  amount: 1860,
};

const t12 = trimRoomLineItemToDates(mergedWithDiscount, ["2026-08-19"]);
assertEqual(t12.gross_amount, 1960, "T12 gross survives");
assertEqual(t12.discount_amount, 100, "T12 discount survives");
assertEqual(t12.amount, 1860, "T12 net survives");

// ── T13 — a real narrowing still narrows (no accidental no-op) ──────────────
const t13 = trimRoomLineItemToDates(mergedTwoNights, []);
assertEqual(t13.amount, 0, "T13 zero nights costs nothing");
assertEqual(t13.quantity, 0, "T13 zero nights is zero room-nights");

console.log("trim-room-line: 5 cases passed");
