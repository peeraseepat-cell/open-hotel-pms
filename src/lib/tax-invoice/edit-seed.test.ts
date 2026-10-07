import { pickEditSeedLineItems } from "./edit-seed";
import type { TaxInvoiceLineItem } from "./types";

function assertDeepEqual(actual: unknown, expected: unknown, message?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message ?? "mismatch"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// What the document holds: rooms merged into one line, plus the extra charge.
const saved: TaxInvoiceLineItem[] = [
  {
    kind: "room_charge",
    description: "ค่าห้องพัก 4 ห้อง (19/8/2569)",
    quantity: 4,
    room_count: 4,
    unit: "คืน",
    unit_price: 490,
    amount: 1960,
    stay_dates: ["2026-08-19"],
    room_number: "204,228,232,238",
  },
  {
    kind: "extra_charge",
    description: "พักเพิ่ม 1 ท่าน",
    quantity: 1,
    unit: "รายการ",
    unit_price: 100,
    amount: 100,
    room_number: "204",
    fee_template_code: "EXTRA_PERSON",
    merged_extra_charge_ids: ["folio-extra-1"],
  },
];

// What a rebuild from the reservation produces: one line per room, no extras.
const rebuilt: TaxInvoiceLineItem[] = ["204", "228", "232", "238"].map((room) => ({
  kind: "room_charge",
  description: "ค่าห้องพัก (19/8/2569)",
  quantity: 1,
  unit: "คืน",
  unit_price: 490,
  amount: 490,
  stay_dates: ["2026-08-19"],
  room_number: room,
}));

const sum = (items: TaxInvoiceLineItem[]) => items.reduce((n, i) => n + i.amount, 0);

// ── The incident, as a test ─────────────────────────────────────────────────
const standard = pickEditSeedLineItems({ saved, rebuilt, invoiceKind: "standard" });
assertDeepEqual(standard, saved, "a standard invoice opens with what was saved");
if (sum(standard) !== 2060) throw new Error(`standard seed total: expected 2060, got ${sum(standard)}`);
if (!standard.some((i) => i.kind === "extra_charge")) throw new Error("the extra charge line was dropped");

// invoice_kind is nullable on older rows; absent means standard.
assertDeepEqual(
  pickEditSeedLineItems({ saved, rebuilt, invoiceKind: null }),
  saved,
  "a null kind is a standard invoice"
);

// ── Split invoices deliberately keep the old path ───────────────────────────
for (const kind of ["prepayment", "balance"] as const) {
  assertDeepEqual(
    pickEditSeedLineItems({ saved, rebuilt, invoiceKind: kind }),
    rebuilt,
    `${kind} still seeds from the rebuild so full_net_total stays the reservation total`
  );
}

// ── Fallbacks: never hand the form undefined ────────────────────────────────
assertDeepEqual(
  pickEditSeedLineItems({ saved: null, rebuilt, invoiceKind: "standard" }),
  rebuilt,
  "a document with no saved lines falls back to the rebuild"
);
assertDeepEqual(
  pickEditSeedLineItems({ saved, rebuilt: null, invoiceKind: "prepayment" }),
  saved,
  "a split invoice falls back to its saved lines when the rebuild is unavailable"
);
assertDeepEqual(
  pickEditSeedLineItems({ saved: null, rebuilt: null, invoiceKind: "standard" }),
  [],
  "both missing yields an empty list, never undefined"
);

console.log("edit-seed: saved document wins for standard invoices; split invoices keep the rebuild");
