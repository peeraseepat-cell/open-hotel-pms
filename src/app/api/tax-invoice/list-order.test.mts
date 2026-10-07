import assert from "node:assert/strict";

// What the tax-invoice LIST order computes. This array becomes the API response,
// so each case here is a visible-to-the-user ordering, and each one is a mutant
// that the structural pin in complete-fetch.contract.test.mjs could not see
// (review: a direction flip on issue_date left the full suite green).
//
// The order restored is the SQL one the keyset pager took over:
//   issue_date desc, created_at desc, id asc

type Row = { id?: string | null; issue_date?: string | null; created_at?: string | null };

let compareInvoiceListNewestFirst: ((left: Row, right: Row) => number) | undefined;

try {
  ({ compareInvoiceListNewestFirst } = await import("./list-order.ts"));
} catch (error) {
  assert.fail(
    `list-order module is missing: ${error instanceof Error ? error.message : String(error)}`
  );
}

const compare = compareInvoiceListNewestFirst!;
const row = (
  id: string,
  issue_date = "2026-07-10",
  created_at = "2026-07-10T00:00:00Z"
): Row => ({ id, issue_date, created_at });
const ids = (rows: Row[]) => rows.map((r) => String(r.id));

// ── 1. issue_date DESC is the primary key — kills the flip and kills inert ───
{
  const input = [row("old", "2026-07-01"), row("new", "2026-07-31")];
  assert.equal(ids(input)[0], "old", "fixture control: input must start in the wrong order");

  assert.deepEqual(
    ids([...input].sort(compare)),
    ["new", "old"],
    "the newest issue_date must head the list — this array IS the response order"
  );
}

// ── 2. created_at DESC breaks an issue_date tie ─────────────────────────────
// Same-day issuing is routine, so this key does the visible work most days.
{
  const input = [
    row("first", "2026-07-10", "2026-07-10T01:00:00Z"),
    row("later", "2026-07-10", "2026-07-10T09:00:00Z"),
  ];
  assert.equal(ids(input)[0], "first", "fixture control: input must start in the wrong order");

  assert.deepEqual(
    ids([...input].sort(compare)),
    ["later", "first"],
    "within one issue_date the most recently created invoice must come first — dropping " +
      "created_at silently collapses the second key of a three-key order"
  );
}

// ── 3. id ASC closes the order ──────────────────────────────────────────────
{
  const same = "2026-07-10T05:00:00Z";
  const input = [row("c", "2026-07-10", same), row("a", "2026-07-10", same), row("b", "2026-07-10", same)];
  assert.notDeepEqual(ids(input), ["a", "b", "c"], "fixture control: input must not be pre-sorted");

  assert.deepEqual(
    ids([...input].sort(compare)),
    ["a", "b", "c"],
    "fully tied rows must fall back to id ASCENDING, not to keyset order"
  );
}

// ── 4. Key PRECEDENCE — an older issue_date cannot be rescued by created_at ──
// The mutant this catches is swapping the two keys, which no single-key case can.
{
  const sorted = [
    row("newest_date_oldest_created", "2026-07-31", "2026-07-31T00:00:01Z"),
    row("older_date_newest_created", "2026-07-01", "2026-07-31T23:59:59Z"),
  ].sort(compare);

  assert.deepEqual(
    ids(sorted),
    ["newest_date_oldest_created", "older_date_newest_created"],
    "issue_date must outrank created_at — swapping the two keys reorders the list for every " +
      "invoice created out of issue order"
  );
}

console.log("list-order.test.mts: all assertions passed");
