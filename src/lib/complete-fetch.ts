// Shared complete-fetch pager for the 1000-row cap sweep.
//
// PostgREST caps every response at 1000 rows regardless of what the client asks
// for, so `.limit(5000)` is a lie and a bare `.select()` truncates silently. Any
// read whose correctness depends on seeing ALL matching rows must page through
// them and prove it saw the lot — hence the mandatory `count: 'exact'` oracle.
// Without a count there is nothing to compare the accumulation against, so the
// pager refuses rather than returning a plausible short array.
//
// ── Why KEYSET and not offset ──────────────────
// The first version paged by offset (`.range(from, to)`) and certified the
// result by comparing accumulated length against `count`. That is broken, and
// the root cause is worth stating exactly:
//
//   offset denotes POSITION. count certifies SIZE. Neither certifies IDENTITY.
//
// Two errors that cancel in cardinality are therefore invisible. Measured: with
// 1001 matching rows, inserting one row behind the read cursor after page 1 made
// the pager return row 1000 TWICE and never return the inserted row — while
// `count` grew by one at the same moment, so `rows.length === count` still held
// and the pager reported success. Silently wrong data, GREEN oracle.
//
// So page N+1 is now selected by IDENTITY, not position: `.order(id).gt(id,
// <last id of page N>)`. Duplicates become structurally impossible because ids
// strictly increase across pages, which means a miss can no longer be masked by
// a compensating duplicate — it always surfaces as a count mismatch and throws.
//
// Mechanism recorded in review before this rework, and it is the authority here —
// `learning_2026-07-25_a-deterministic-order-by-does-not-make-offset-pagi`: a
// deterministic ORDER BY does NOT make offset paging mutation-stable, and every
// table swept here keys on `gen_random_uuid()`, so a concurrent insert sorts to a
// RANDOM position rather than the tail. The insert mode is therefore live, not
// theoretical — a monotonic key would have reduced it to deletes only. That card
// also prescribes the test shape used in complete-fetch.test.mts: mutate the
// backing set BETWEEN page requests, never just assert on a static fixture.
//
// ── SCOPE OF THE GUARANTEE ───────────────────────────────────────────────────
// Lifted from fetchAllPaged in src/lib/analytics/linen/service.ts,
// because the sentence is exactly right and a second wording would be a second
// home for one fact:
//
//   "the count check certifies the SIZE of the result set, not the IDENTITY of
//   its rows. These tables key on `gen_random_uuid()`, so a concurrent insert
//   sorts to a random position rather than to the tail — an insert and a delete
//   landing between two pages can leave the total unchanged while a pre-existing
//   row is skipped, and this guard passes."
//
// What keyset changes about that sentence, precisely: duplicates and forward
// skips are now structurally impossible, so the *position*-driven half of it is
// closed. What remains open is narrower and worth stating exactly rather than
// implying it is fixed:
//
//   1. READ SKEW — a row read on page 1 that stops matching before the scan ends
//      is still in the returned set. Undetectable from the client.
//   2. CONSTANT-SIZE MEMBERSHIP SWAP — one row deleted behind the cursor and one
//      inserted behind the cursor leaves `count` unchanged AND `rows.length`
//      matching, so the set is wrong and every count-based oracle passes.
//
// Note (2) is why this pager does NOT try to close the membership swap with more
// counting: any two counts are EQUAL in exactly that case. The real fix for a true
// point-in-time snapshot is a single transactional RPC — the review card says so and
// that is DB work, deliberately outside this code-only sweep.
//
// ── `count: 'exact'` IS FILTER-SCOPED. THIS IS THE WHOLE REASON FOR THE PIN ───
// Measured against real PostgREST on 1519 rows,
// not reasoned about:
//
//   page 1, no cursor        Content-Range: 0-999/1519
//   page 2, id=gt.<cursor>   Content-Range: 0-518/519      <-- the REMAINDER
//
// `.limit()` and `.range()` are not filters, so under OFFSET paging the count is
// always the full total — which is why the offset version's oracle worked and why
// nothing here caught the change. `.gt(cursorColumn, cursor)` IS a filter and rides
// in the same query as the count, so under KEYSET paging every page after the first
// reports only what is left after the cursor.
//
// An earlier version of this pager re-pinned `expected = count` on every page, so
// the final comparison used the LAST page's remainder: it threw
// `loaded 1519 of 519` on every multi-page read. It shipped because the bench's
// fake table answered `table.rows.length` regardless of the cursor — a fake that
// answered a question the real server answers differently. The fake now models the
// filter, and complete-fetch.test.mts §12 pins this shape directly, instrument check first.
//
// ── THE SHAPE, AS DECIDED AFTER A TEST DRIVE ───────────────
// The total is pinned ONCE from the first uncursored page. Then:
//
//   * PER-PAGE ORACLE, ONE-SIDED: throw only when `count < expected - rows.length`
//     — the remainder collapsed, so rows that were promised have vanished. Growth
//     is TOLERATED and adopted. Strict equality was my first attempt and it was
//     wrong: measurement showed that one benign insert past the cursor turned into a
//     hard error, which is the churn tax the review withdrew coming back through
//     the remainder door. `reservation_nights` is written on every booking create
//     and cancel — i.e. during the hours these reports run.
//   * TERMINATION NEVER READS THE COUNT: the walk ends on a short or empty page.
//     `rows.length >= expected` was not just a wrong comparison under a remainder
//     count, it ENDED THE WALK EARLY — at TOTAL=2500 the page-2 remainder of 1500
//     re-pinned `expected`, 2000 rows were in hand, the loop broke, and page 3 was
//     never requested. 
//   * THE FINAL GUARD IS THE SINGLE LOAD-BEARING WALL, and it is DOWNWARD ONLY:
//     `rows.length < expected` throws; more than expected is an ahead-insert served
//     mid-scan and is allowed. Because termination no longer consults the count,
//     this comparison is the only thing standing between an early-ended walk and a
//     silently truncated result. Soften it and 2000 of 2500 rows come back with no
//     error at all — the exact defect this sweep exists to kill, re-entering through
//     its own fix. Do not touch it.
//
//   3. SUPERSET, NOT SNAPSHOT — a consequence of tolerating growth, stated here
//      because it is now implemented behaviour rather than a note: rows created
//      ahead of the cursor mid-scan ARE included, so the result can be a superset
//      of the set that existed when the scan began.
//   4. AN INSERT BEHIND THE CURSOR IS INVISIBLE — it is in neither the first page's
//      total nor any later remainder, so no count-based oracle can see it. The
//      returned set is the scan's start state. complete-fetch.test.mts §8 pins this
//      as a declared limit; it used to assert a throw here and passed only because
//      the fake counted the whole table.
//
// CALLERS: do NOT pass your own `.order()` — the pager owns ordering, because
// keyset requires the cursor column to be the PRIMARY sort. A read that needs
// some other order must sort in JS after the fetch completes (see
// canReuseInvoiceNumber and the sales-tax export, which both do exactly that,
// and for the same reason: `invoice_no` is text so its collation order is not
// its numeric order).

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_ROWS = 20000;
const DEFAULT_CURSOR_COLUMN = "id";

/** A keyset cursor must be a sortable scalar — bigint ids and uuids both are. */
export type CursorValue = string | number;

export type CompleteFetchPage<T> = {
  data: T[] | null;
  error: { message: string } | null;
  count?: number | null;
};

/**
 * The subset of a PostgREST builder this pager drives. Awaiting the builder
 * executes it, which is why the type is itself PromiseLike.
 */
export type CompleteFetchQuery<T> = PromiseLike<CompleteFetchPage<T>> & {
  gt: (column: string, value: CursorValue) => CompleteFetchQuery<T>;
  order: (column: string, options?: { ascending?: boolean }) => CompleteFetchQuery<T>;
  limit: (count: number) => CompleteFetchQuery<T>;
};

export type CompleteFetchOptions = {
  pageSize?: number;
  maxRows?: number;
  /** Names the read in error messages, e.g. "issued invoices". */
  label?: string;
  /** Unique, sortable column to page by. Must be in the select projection. */
  cursorColumn?: string;
};

export class IncompleteFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IncompleteFetchError";
  }
}

function readCursor(row: unknown, column: string, label: string): CursorValue {
  const value = (row as Record<string, unknown> | null)?.[column];
  if (typeof value === "string" || typeof value === "number") return value;
  throw new IncompleteFetchError(
    `Cannot page ${label} by identity: a row has no usable "${column}". ` +
      `Add "${column}" to the select projection — keyset paging needs it in every row.`
  );
}

/**
 * Monotonicity check only — never a claim about the server's collation. Both
 * sides just have to agree that the cursor moves forward. For text cursors a
 * collation difference could in principle reject a legitimate page, and that is
 * the acceptable direction: a false throw is loud, whereas trusting an
 * unhonoured cursor duplicates rows silently.
 */
function advanced(from: CursorValue, to: CursorValue): boolean {
  if (typeof from === "number" && typeof to === "number") return to > from;
  return String(to) > String(from);
}

/**
 * Pages through `createQuery()` by keyset until the rows accumulated match the
 * server's own `count: 'exact'`, and throws if they never do.
 *
 * `createQuery` is a factory, not a query, because a PostgREST builder cannot be
 * re-run once awaited — each page needs a fresh one.
 */
export async function fetchAllRowsComplete<T>(
  createQuery: () => CompleteFetchQuery<T>,
  options: CompleteFetchOptions = {}
): Promise<T[]> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const label = options.label ?? "rows";
  const cursorColumn = options.cursorColumn ?? DEFAULT_CURSOR_COLUMN;

  const rows: T[] = [];
  // -1 until the first uncursored page pins it; that page always runs first.
  let expected = -1;
  let cursor: CursorValue | null = null;

  for (;;) {
    let query = createQuery().order(cursorColumn, { ascending: true }).limit(pageSize);
    if (cursor !== null) query = query.gt(cursorColumn, cursor);

    const { data, error, count } = await query;

    // `cause` keeps the raw PostgREST error reachable: callers that tolerate a
    // specific failure need its `code`, not a flattened message.
    if (error) throw new IncompleteFetchError(error.message, { cause: error });

    if (count === null || count === undefined) {
      throw new IncompleteFetchError(
        `Cannot certify a complete fetch of ${label}: the query returned no count. Select with { count: "exact" }.`
      );
    }

    if (cursor === null) {
      // First page: no cursor filter rides in the query, so THIS count is the total
      // for the whole scan. It is pinned once and never overwritten — see the
      // filter-scoped section above for what re-pinning did.
      if (count > maxRows) {
        throw new IncompleteFetchError(
          `Refusing to load ${count} ${label}: exceeds the ${maxRows} row limit. Narrow the range.`
        );
      }
      expected = count;
    } else {
      // Every later page's count is the REMAINDER after the cursor, which is still a
      // real oracle — but the relation is ASYMMETRIC, and getting that wrong is a
      // second defect rather than a style choice (measured):
      //
      //   count < owed  → rows we were promised are GONE. Loud, always.
      //   count > owed  → the set GREW ahead of the cursor. Benign: nothing was
      //                   skipped or duplicated, so adopt the new total.
      //
      // Strict equality here would turn one concurrent insert past the cursor into a
      // hard failure on a money read — that is the drift rejection the review withdrew in
      // arriving again through the remainder door. `reservation_nights` is written
      // on every booking create and cancel, i.e. during the hours these reports
      // are read, so equality would fail reports for a row that harms nothing.
      //
      // Growth is adopted rather than ignored so the FINAL equality check stays exact
      // and strict. That check is the only thing that keeps truncation loud — at
      // TOTAL=2500 the remainder even poisoned the loop's own `rows.length >= expected`
      // break, so page 3 was never requested. Softening it would return 2000
      // of 2500 silently: the defect this whole sweep exists to kill, re-entering
      // through its own fix.
      const owed = expected - rows.length;
      if (count < owed) {
        throw new IncompleteFetchError(
          `${label} shrank under the scan: the server reports ${count} row(s) after the cursor, ` +
            `but ${owed} were still owed (${expected} at the first page, ${rows.length} loaded so ` +
            `far). Rows that were promised have been deleted mid-read; refusing to compute on a ` +
            `set that moved.`
        );
      }
      if (count > owed) expected = rows.length + count;
    }
    const page = data ?? [];
    // An empty page is the end of the keyset walk. Whether that is COMPLETE is
    // not decided here — the count comparison below decides it.
    if (page.length === 0) break;

    // Identity guard: page N+1 must begin strictly after page N ended. This is
    // the check the old cardinality-only oracle could not express, and it is
    // what makes an unhonoured cursor loud instead of an infinite duplicate.
    if (cursor !== null) {
      const first = readCursor(page[0], cursorColumn, label);
      if (!advanced(cursor, first)) {
        throw new IncompleteFetchError(
          `Refusing to page ${label}: the server returned ${cursorColumn} ${String(first)} ` +
            `after cursor ${String(cursor)}. The cursor is not being honoured, so pages ` +
            `would duplicate or loop.`
        );
      }
    }

    rows.push(...page);
    cursor = readCursor(page[page.length - 1], cursorColumn, label);

    // TERMINATION MUST NOT DEPEND ON THE COUNT (a design decision). This used to
    // be `rows.length >= expected`, and with a remainder count that read is not
    // merely a wrong comparison — it ended the walk early. It was measured at
    // TOTAL=2500: `expected` was re-pinned to the page-2 remainder of 1500, 2000
    // rows had been loaded, so the loop broke and PAGE 3 WAS NEVER REQUESTED. A
    // short page is the only honest end-of-walk signal, and if the server ends the
    // walk early the final downward guard below is what makes it loud.
    if (page.length < pageSize) break;
  }

  // THE SINGLE LOAD-BEARING WALL. Downward only: fewer rows than the first page's
  // total means rows are MISSING, which is the truncation this whole sweep exists to
  // kill, and it throws. MORE rows than that total is an ahead-insert that was served
  // — nothing was skipped or duplicated, so it is allowed through as a superset.
  if (rows.length < expected) {
    throw new IncompleteFetchError(
      `Incomplete fetch of ${label}: loaded ${rows.length} of ${expected} rows. Refusing to compute on a truncated set.`
    );
  }

  return rows;
}
