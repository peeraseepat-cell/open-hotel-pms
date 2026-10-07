
import assert from "node:assert/strict";
import { sortReturnSourcesForDisplay } from "./return-display-order.ts";

type Row = Parameters<typeof sortReturnSourcesForDisplay>[0][number];

const row = (
  id: string,
  source_business_date: string,
  source_pickup_round: number
): Row => ({ id, source_business_date, source_pickup_round }) as Row;


const RPC_ORDER: Row[] = [
  row("r1", "2026-06-20", 2), // lane_order 1 — the newest pair, hoisted by the RPC
  row("r2", "2026-06-20", 2), // same group as r1: stability probe
  row("o1", "2026-06-20", 1),
  row("o2", "2026-06-07", 3),
  row("o3", "2026-06-07", 1),
];

const LEGACY_ORDER = ["o3", "o2", "o1", "r1", "r2"];

// --- 4. positive control, asserted BEFORE the thing it protects -------------
// If the fixture were already ascending, clause 1 would pass against a function
// that returns its input untouched, and this file would prove nothing.
assert.notDeepEqual(
  RPC_ORDER.map((r) => r.id),
  LEGACY_ORDER,
  "positive control: the fixture must NOT already be in legacy order, or clause 1 is vacuous"
);

// --- 1. ascending (date, round) ---------------------------------------------
const sorted = sortReturnSourcesForDisplay(RPC_ORDER);
assert.deepEqual(
  sorted.map((r) => r.id),
  LEGACY_ORDER,
  "desktop list must render oldest-first, matching batch-service.ts at 00546b9^:439-442"
);

// --- 2. stability within a (date, round) group -------------------------------
// Legacy order INSIDE a group was whatever Postgres returned; the new payload is
// item_number asc / is_dayuse asc. A stable sort carries that through untouched —
// so within a group the order goes from arbitrary to deterministic. Recorded here
assert.deepEqual(
  sorted.filter((r) => r.source_business_date === "2026-06-20" && r.source_pickup_round === 2).map((r) => r.id),
  ["r1", "r2"],
  "within one (date, round) group the payload's own order must survive"
);

// --- 3. the prop is not mutated ---------------------------------------------
assert.deepEqual(
  RPC_ORDER.map((r) => r.id),
  ["r1", "r2", "o1", "o2", "o3"],
  "sortReturnSourcesForDisplay must not mutate its argument — it is a React prop"
);

// --- guard: a missing/garbage round must not throw ---------------------------
// Legacy read it as Number(x ?? 0); replicated rather than improved.
assert.doesNotThrow(() => sortReturnSourcesForDisplay([
  row("x", "2026-06-07", undefined as unknown as number),
  row("y", "2026-06-07", 1),
]));

// --- 5. CONSUMPTION PIN ------------------------------------------------------
// Clauses 1-4 prove the sorter sorts. They say NOTHING about whether the screen
// uses it: reverting any call site to raw `returnSources` leaves all of them green
// and restores the breach. Pin the seam that consumes the value, not just the value.
import { readFileSync } from "node:fs";

const COMPONENT = "src/components/linen/batch-step-return.tsx";
const src = readFileSync(new URL(`../../../${COMPONENT}`, import.meta.url), "utf8");

for (const site of [
  // the rendered list
  "return orderedReturnSources.map(i => ({",
  // the POST payload -> becomes the stored fo_return_counted event
  "const returnItemsPayload = orderedReturnSources.map(item => ({",
  // the summary handed to onNext
  "const returnedSummary: ReturnSummaryDisplayRow[] = orderedReturnSources",
]) {
  assert.ok(
    src.includes(site),
    `order-sensitive site must read orderedReturnSources, not the raw prop: ${site}`
  );
}

assert.ok(
  src.includes("sortReturnSourcesForDisplay(returnSources)"),
  "orderedReturnSources must be derived by the pinned comparator, not re-sorted inline"
);

// The raw prop legitimately survives at the order-INSENSITIVE sites (the props
// signature, the isComplete loop). Pinning a raw-prop count would break on any
// unrelated edit, so assert the specific thing instead: displayItems must not
// silently fall back to the unsorted array.
assert.ok(
  !src.includes("return returnSources.map(i => ({"),
  "displayItems must not render the unsorted payload"
);

console.log("desktop order: 5 clauses green (asc pin, stability, no-mutate, positive control, consumption pin)");
