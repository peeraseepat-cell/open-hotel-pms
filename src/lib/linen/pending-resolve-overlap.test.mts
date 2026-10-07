
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dropPendingResolvedCoveredByReturns } from "./pending-resolve-overlap.ts";

const SRC_A = "11111111-1111-1111-1111-111111111111";
const SRC_B = "22222222-2222-2222-2222-222222222222";

const MARKERS = [
  { id: "m-a", source_batch_id: SRC_A, linen_item_id: 7 },
  { id: "m-b", source_batch_id: SRC_B, linen_item_id: 9 },
];

// --- 1. the overlap is dropped -----------------------------------------------
assert.deepEqual(
  dropPendingResolvedCoveredByReturns(
    ["m-a", "m-b"],
    [
      { source_batch_id: SRC_A, linen_item_id: 7, received_qty: 3 }, // covers m-a
      { source_batch_id: SRC_B, linen_item_id: 9, received_qty: 0 },
    ],
    MARKERS
  ),
  ["m-b"],
  "a marker whose pair carries a positive typed qty must not be sent"
);

// --- 2 + 3. no over-filter, and a typed ZERO leaves the marker open ----------
// Legacy closes a marker only when received_back actually moves. A 0 does not
// move it, so a 0 must NOT drop the marker — this is the direction that would
// silently swallow a staff tick.
assert.deepEqual(
  dropPendingResolvedCoveredByReturns(
    ["m-a", "m-b"],
    [
      { source_batch_id: SRC_A, linen_item_id: 7, received_qty: 0 },
      { source_batch_id: SRC_B, linen_item_id: 9, received_qty: 0 },
    ],
    MARKERS
  ),
  ["m-a", "m-b"],
  "a typed zero must leave the marker in the payload — legacy would still resolve it"
);

// --- 4. one marker spans both dayuse variants -------------------------------
// allocatePendingAcrossVariants spreads a single marker across variants, so a
// positive qty on EITHER variant closes it. Keying on (…, is_dayuse) would let
// this marker survive and collide.
assert.deepEqual(
  dropPendingResolvedCoveredByReturns(
    ["m-a"],
    [
      { source_batch_id: SRC_A, linen_item_id: 7, received_qty: 0 }, // non-dayuse row, nothing typed
      { source_batch_id: SRC_A, linen_item_id: 7, received_qty: 2 }, // dayuse row, positive
    ],
    MARKERS
  ),
  [],
  "a positive qty on EITHER dayuse variant must drop the marker (pair key, not triple)"
);

// --- 5. order preserved ------------------------------------------------------
assert.deepEqual(
  dropPendingResolvedCoveredByReturns(["m-b", "m-a"], [], MARKERS),
  ["m-b", "m-a"],
  "surviving order must be preserved — it reaches the stored event"
);

// --- 6. unknown id untouched -------------------------------------------------
assert.deepEqual(
  dropPendingResolvedCoveredByReturns(["ghost"], [], MARKERS),
  ["ghost"],
  "an id with no known marker must pass through — dropping it is a second behaviour change"
);

// --- 7. CONSUMPTION PIN ------------------------------------------------------
// Clauses 1-6 prove the filter filters. They cannot see the component reverting
// to the raw selection, which restores the regression with every clause green.
const src = readFileSync(
  new URL("../../../src/components/linen/batch-step-return.tsx", import.meta.url),
  "utf8"
);
assert.ok(
  src.includes("const safePendingResolved = dropPendingResolvedCoveredByReturns("),
  "the component must derive the filtered list via the pinned filter"
);
assert.ok(
  src.includes("pending_resolved: safePendingResolved.map(id => ({ pending_item_id: id }))"),
  "the payload must be built from the FILTERED list"
);
assert.ok(
  !src.includes("pending_resolved: resolvedPending.map(id => ({ pending_item_id: id }))"),
  "the payload must not be built from the raw selection"
);

console.log("F1 overlap: 7 clauses green (drop, no-over-filter, zero-keeps, dayuse-pair, order, unknown, consumption pin)");
