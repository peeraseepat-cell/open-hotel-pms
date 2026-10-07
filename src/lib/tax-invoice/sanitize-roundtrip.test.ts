// The edit screen now seeds from the SAVED invoice instead of rebuilding from
// the reservation. That is only safe while `sanitizeLineItems` — the gate every
// submitted line passes through on its way back into `invoices.line_items` —
// preserves the fields that carry the document's editorial decisions.
//
// Drop `room_count` and a merged room line silently becomes a single-room line
// priced for four. Drop `merged_extra_charge_ids` and the same folio charge can
// be added a second time. Drop `fee_template_code` and the print-time wording
// lookup loses its key.
//
// Shape under test is IV260807 as it stands on production after repair.

import { sanitizeLineItems } from "./service";
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

const saved: TaxInvoiceLineItem[] = [
  {
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
    merged_reservation_ids: ["res-204", "res-228", "res-232", "res-238"],
    merged_line_sources: [
      { reservation_id: "res-204", room_number: "204", gross_amount: 490, discount_amount: 0, amount: 490 },
      { reservation_id: "res-228", room_number: "228", gross_amount: 490, discount_amount: 0, amount: 490 },
      { reservation_id: "res-232", room_number: "232", gross_amount: 490, discount_amount: 0, amount: 490 },
      { reservation_id: "res-238", room_number: "238", gross_amount: 490, discount_amount: 0, amount: 490 },
    ],
  },
  {
    kind: "extra_charge",
    description: "พักเพิ่ม 1 ท่าน",
    quantity: 1,
    unit: "รายการ",
    unit_price: 100,
    amount: 100,
    room_number: "204",
    reservation_id: "res-204",
    fee_template_code: "EXTRA_PERSON",
    merged_extra_charge_ids: ["folio-extra-1"],
    merged_extra_charge_total: 100,
  },
];

const out = sanitizeLineItems(saved);

assertEqual(out.length, 2, "both lines survive");

const [room, extra] = out;

assertEqual(room.room_count, 4, "room_count survives — without it the merged line reprices");
assertEqual(room.amount, 1960, "merged amount survives");
assertEqual(room.quantity, 4, "room-nights survive");
assertEqual(room.room_number, "204,228,232,238", "room list survives");
assertDeepEqual(room.merged_reservation_ids, saved[0].merged_reservation_ids, "reservation back-pointers survive");
assertEqual(room.merged_line_sources?.length, 4, "per-room sources survive");

assertEqual(extra.kind, "extra_charge", "extra line keeps its kind");
assertEqual(extra.amount, 100, "extra amount survives");
assertEqual(extra.description, "พักเพิ่ม 1 ท่าน", "hand-typed wording is not rewritten");
assertEqual(extra.fee_template_code, "EXTRA_PERSON", "template code survives — print-time wording needs it");
assertDeepEqual(extra.merged_extra_charge_ids, ["folio-extra-1"], "folio back-pointer survives — blocks double-add");

// A second pass must be a no-op: the edit screen loads what this produced and
// submits it again on every save.
assertDeepEqual(sanitizeLineItems(out), out, "sanitize is idempotent across repeated edits");

console.log("sanitize-roundtrip: merged room line + extra charge survive intact");
