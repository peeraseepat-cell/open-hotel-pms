import assert from "node:assert/strict";

// What the order of the two issued-invoice reads COMPUTES — not whether a sort is
// called. The contract-test pin covers the call; a review proved that pin
// stays green when this comparator is flipped or made inert, because a structural
// assertion cannot see a comparison. Every case below is a mutant the pin missed.
//
// Fixtures only, no database, so this runs in the plain `node --test` suite.

type Row = { id?: string | null; issue_date?: string | null };

let compareIssuedInvoiceNewestFirst: ((left: Row, right: Row) => number) | undefined;

try {
  ({ compareIssuedInvoiceNewestFirst } = await import("./issued-invoice-order.ts"));
} catch (error) {
  assert.fail(
    `issued-invoice-order module is missing: ${error instanceof Error ? error.message : String(error)}`
  );
}

const compare = compareIssuedInvoiceNewestFirst!;
const row = (id: string, issue_date: string | null = "2026-07-10") => ({ id, issue_date });
const ids = (rows: Row[]) => rows.map((r) => String(r.id));

// ── 1. NEWEST FIRST — kills the direction flip, and kills "inert" ─────────────
// A stable sort leaves an inert comparator's input untouched, so an input that is
// deliberately in the WRONG order is what makes both mutants fail here. Control
// first: prove the fixture can differentiate.
{
  const input = [row("a", "2026-07-01"), row("b", "2026-07-31")];
  assert.equal(ids(input)[0], "a", "fixture control: input must start in the wrong order");

  const sorted = [...input].sort(compare);
  assert.deepEqual(
    ids(sorted),
    ["b", "a"],
    "the newer issue_date must come first — this is the order that decides which invoice's " +
      "grand_total is reported as covering a reservation (first-write-wins consumer)"
  );
}

// ── 2. THE id TIEBREAKER — kills dropping it, and kills inert on ties ────────
// issue_date is a DATE, so ties are the normal case inside one month. Without the
// tiebreaker, tied rows keep whatever order the keyset (uuid) scan produced.
{
  const input = [row("z"), row("a"), row("m")];
  assert.notDeepEqual(ids(input), ["a", "m", "z"], "fixture control: input must not be pre-sorted");

  const sorted = [...input].sort(compare);
  assert.deepEqual(
    ids(sorted),
    ["a", "m", "z"],
    "rows sharing an issue_date must be ordered by id ASCENDING — dropping the tiebreaker leaves " +
      "tied rows in keyset order, which is random per insert"
  );
}

// ── 3. A missing issue_date must not win ─────────────────────────────────────
// `null` becomes "" and "" is below every real date, so such a row sorts LAST.
// Pinned because it is the shape most likely to be "simplified" away.
{
  const sorted = [row("dated", "2026-07-05"), row("undated", null)].sort(compare);
  assert.deepEqual(ids(sorted), ["dated", "undated"], "a row with no issue_date must sort last");
}

// ── 4. The comparator must be a valid total order ───────────────────────────
// Weak on its own (an inert comparator satisfies both), which is why it is last
// and not instead of the cases above.
{
  const a = row("a", "2026-07-01");
  const b = row("b", "2026-07-02");
  assert.equal(compare(a, a), 0, "a row must compare equal to itself");
  assert.equal(compare(a, b), -compare(b, a), "the comparison must be antisymmetric");
}

console.log("issued-invoice-order.test.mts: all assertions passed");
