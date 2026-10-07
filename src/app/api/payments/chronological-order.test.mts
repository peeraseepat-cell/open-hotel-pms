import assert from "node:assert/strict";

// What the payments comparators COMPUTE. Each case below is a mutant that stayed
// GREEN on the full suite at one point, when these comparators were private to
// the two route handlers and the only available assertion was that a `.sort(...)`
// call existed (review: compareText inert, compareText flipped,
// comparePosOrdersChronological inert, id tiebreaker dropped).
//
// Fixtures only, no database.

type Payment = { id?: unknown; paid_date?: unknown; paid_at?: unknown };
type PosOrder = { id?: unknown; order_date?: unknown };

let comparePaymentsChronological: ((left: Payment, right: Payment) => number) | undefined;
let comparePosOrdersChronological: ((left: PosOrder, right: PosOrder) => number) | undefined;

try {
  ({ comparePaymentsChronological, comparePosOrdersChronological } = await import(
    "./chronological-order.ts"
  ));
} catch (error) {
  assert.fail(
    `chronological-order module is missing: ${error instanceof Error ? error.message : String(error)}`
  );
}

const payments = comparePaymentsChronological!;
const posOrders = comparePosOrdersChronological!;
const ids = (rows: { id?: unknown }[]) => rows.map((r) => String(r.id));

const pay = (id: string, paid_date = "2026-07-10", paid_at: string | null = "2026-07-10T08:00:00Z") =>
  ({ id, paid_date, paid_at });

// ── 1. paid_date ASCENDING — kills the direction flip and kills inert ────────
// The input starts in the wrong order, so a stable sort exposes both mutants.
{
  const input = [pay("later", "2026-07-31"), pay("earlier", "2026-07-01")];
  assert.equal(ids(input)[0], "later", "fixture control: input must start in the wrong order");

  assert.deepEqual(
    ids([...input].sort(payments)),
    ["earlier", "later"],
    "payments must read OLDEST first — this is a ledger; flipping it reverses every " +
      "chronological listing built from the paged read"
  );
}

// ── 2. paid_at breaks a paid_date tie ───────────────────────────────────────
{
  const input = [
    pay("evening", "2026-07-10", "2026-07-10T19:00:00Z"),
    pay("morning", "2026-07-10", "2026-07-10T07:00:00Z"),
  ];
  assert.equal(ids(input)[0], "evening", "fixture control: input must start in the wrong order");

  assert.deepEqual(
    ids([...input].sort(payments)),
    ["morning", "evening"],
    "within one paid_date the earlier paid_at must come first — dropping paid_at collapses the " +
      "second key of a three-key order"
  );
}

// ── 3. The id tiebreaker ────────────────────────────────────────────────────
// paid_at is nullable on back-dated rows, so full ties are ordinary, not exotic.
{
  const input = [pay("c", "2026-07-10", null), pay("a", "2026-07-10", null), pay("b", "2026-07-10", null)];
  assert.notDeepEqual(ids(input), ["a", "b", "c"], "fixture control: input must not be pre-sorted");

  assert.deepEqual(
    ids([...input].sort(payments)),
    ["a", "b", "c"],
    "fully tied payments must fall back to id ASCENDING — without it tied rows keep keyset " +
      "(uuid) order, which differs per insert"
  );
}

// ── 4. Key PRECEDENCE — paid_date outranks paid_at ──────────────────────────
// No single-key case can catch the two keys being SWAPPED, and the first version of
// this case could not either: its paid_at values embedded their own paid_date, so
// date order and clock order agreed and the swap was invisible. Declaring the
// expected verdict before running the battery is what caught it (N4 came back GREEN
// where it owed RED). A fixture cannot detect what it does not VARY, so the two
// keys must DISAGREE here — which is the real shape of a back-dated payment: the
// business date is old, the wall-clock entry is recent.
{
  const input = [
    pay("current_entered_early", "2026-07-31", "2026-07-01T01:00:00Z"),
    pay("backdated_entered_late", "2026-07-01", "2026-07-31T23:00:00Z"),
  ];
  assert.equal(
    ids(input)[0],
    "current_entered_early",
    "fixture control: input must start in the wrong order, so this case kills inert too"
  );

  assert.deepEqual(
    ids([...input].sort(payments)),
    ["backdated_entered_late", "current_entered_early"],
    "paid_date must outrank paid_at — swapping them reorders every back-dated payment, whose " +
      "clock time disagrees with its business date by construction"
  );
}

// ── 5. A null paid_at must not win ──────────────────────────────────────────
// `null` coerces to "", which is below every timestamp, so it sorts first within
// its date. Pinned because the coercion is deliberate and easy to "clean up".
{
  const sorted = [pay("timed", "2026-07-10", "2026-07-10T06:00:00Z"), pay("undated", "2026-07-10", null)].sort(
    payments
  );
  assert.deepEqual(ids(sorted), ["undated", "timed"], "a null paid_at sorts first within its date");
}

// ── 6. POS orders: order_date ascending, then id ─────────────────────────────
{
  const input = [
    { id: "b", order_date: "2026-07-20" },
    { id: "a", order_date: "2026-07-02" },
  ];
  assert.equal(ids(input)[0], "b", "fixture control: input must start in the wrong order");

  assert.deepEqual(
    ids([...input].sort(posOrders)),
    ["a", "b"],
    "POS walk-in orders must read oldest first"
  );

  const tied = [
    { id: "z", order_date: "2026-07-05" },
    { id: "m", order_date: "2026-07-05" },
  ];
  assert.deepEqual(
    ids([...tied].sort(posOrders)),
    ["m", "z"],
    "POS orders sharing an order_date must fall back to id ASCENDING — order_date is a DATE, so " +
      "same-day ties are the normal case for a walk-in till"
  );
}

console.log("chronological-order.test.mts: all assertions passed");
