import assert from "node:assert/strict";

// Behavioural test for the shared complete-fetch pager introduced by the
// 1000-row cap sweep. PostgREST silently caps every response at 1000 rows, so a
// `.limit(5000)` is a lie and a bare `.select()` truncates at 1000 with no
// signal. This pager must page until the accumulated rows match the server's own
// `count: 'exact'` and THROW when they do not.
//
// ── Why this file models a MUTATING table ───────
// The first version of this pager paged by OFFSET (`.range(from, to)`) and
// certified the result by comparing accumulated length against `count`. Review
// broke it in both directions, and the root cause is worth stating exactly:
//
//   offset denotes POSITION. count certifies SIZE. Neither certifies IDENTITY.
//
// So two errors that cancel in cardinality are invisible to the oracle. A row
// inserted behind the read cursor shifts every later row one place right; the
// next offset page then re-reads one row already seen and never reads one that
// exists. That is a duplicate plus a miss — and because `count` also grew by
// one, `rows.length === count` still held. GREEN, wrong data.
//
// The fix is keyset paging: page N+1 is selected by IDENTITY (`.gt(id, <last id
// of page N>)`), never by position. Duplicates then become structurally
// impossible (ids strictly increase across pages), so a miss can no longer be
// masked by a compensating duplicate and always surfaces as a count mismatch.
//
// DECLARED LIMIT, so nobody upgrades this claim: keyset does NOT give a
// snapshot. A row that was read on page 1 and stops matching before the scan
// ends is still in the result, and no client-side oracle can detect that — it
// needs a single-statement read or a repeatable-read transaction. What keyset
// buys is the elimination of duplicates and forward skips; read skew is out of
// its reach and out of this pager's contract.

type Row = { id: number; marker?: string };

type Page<T> = { data: T[] | null; error: { message: string } | null; count?: number | null };

let fetchAllRowsComplete: (<T>(createQuery: () => unknown, options?: unknown) => Promise<T[]>) | undefined;

try {
  ({ fetchAllRowsComplete } = (await import("./complete-fetch.ts")) as {
    fetchAllRowsComplete: <T>(createQuery: () => unknown, options?: unknown) => Promise<T[]>;
  });
} catch (error) {
  assert.fail(
    `shared complete-fetch pager is missing: ${error instanceof Error ? error.message : String(error)}`
  );
}

const SERVER_CAP = 1000;

/**
 * Fake PostgREST table.
 *
 * Serves BOTH access shapes on purpose — `.range(from, to)` (offset paging) and
 * `.gt/.order/.limit` (keyset paging) — so that a pager written either way runs
 * against the same table and the same scenario. That is what makes the
 * concurrent-insert case below a real RED rather than a missing-method error:
 * an offset pager reaches the assertion and fails it.
 *
 * Every page is hard-capped at SERVER_CAP rows no matter how wide a range is
 * requested — the behaviour the production bug rests on.
 */
function fakeTable(
  initialRows: Row[],
  opts: {
    reportedCount?: number | null;
    failWith?: string;
    /** Fires after each page is served; lets a test mutate the table mid-scan. */
    afterPage?: (pageIndex: number, table: { rows: Row[] }) => void;
    /** Simulates a server that ignores the cursor and re-serves from the top. */
    ignoreCursor?: boolean;
    /**
     * Simulates a server that ENDS THE WALK EARLY: on page `page` it serves only
     * `serve` rows even though its own count says more remain. This is the shape of
     * silent truncation, and it is the only case that can tell a correctly pinned
     * total from a re-pinned one now that the final guard is downward-only.
     */
    truncateAt?: { page: number; serve: number };
  } = {}
) {
  const table = { rows: [...initialRows] };
  const calls: Array<{ from?: number; to?: number; gt?: number; limit?: number }> = [];
  // Recorded so a test can prove the FAKE modelled the filter, not just that the
  // pager passed. An instrument has to be shown capable of the other answer.
  const reportedCounts: Array<number | null | undefined> = [];
  let pageIndex = 0;

  /**
   * `matching` is the number of rows the REQUEST'S FILTERS match — not the table
   * size. This is the distinction the fake used to get wrong, and it was measured
   * against real PostgREST on 1519 rows:
   *
   *   page 1, no cursor      Content-Range: 0-999/1519
   *   page 2, id=gt.<cursor> Content-Range: 0-518/519     <-- the REMAINDER
   *
   * `count: 'exact'` counts the filtered set. `.limit()`/`.range()` are NOT
   * filters, so they leave the count at the full total; `.gt(id, cursor)` IS a
   * filter, so under keyset paging every page after the first reports what is left
   * after the cursor. A fake that always answered `table.rows.length` could not
   * express that, so it certified a pager the real server breaks — the fake
   * answered a question the server answers differently.
   */
  const respond = (served: Row[], matching: number): Page<Row> => {
    const count = opts.reportedCount === undefined ? matching : opts.reportedCount;
    reportedCounts.push(count);
    const page: Page<Row> = { data: served, error: null, count };
    const served_at = pageIndex++;
    opts.afterPage?.(served_at, table);
    return page;
  };

  const factory = () => {
    let gtValue: number | null = null;
    let limitValue = SERVER_CAP;

    const builder = {
      // ── keyset shape ──
      gt(_column: string, value: number) {
        gtValue = value;
        return builder;
      },
      order(_column: string, _options?: { ascending?: boolean }) {
        return builder;
      },
      limit(n: number) {
        limitValue = n;
        return builder;
      },
      // ── offset shape ──
      async range(from: number, to: number): Promise<Page<Row>> {
        calls.push({ from, to });
        if (opts.failWith) return { data: null, error: { message: opts.failWith }, count: null };
        const requested = to - from + 1;
        // `.range()` is limit/offset, NOT a filter, so the count stays the full total.
        return respond(table.rows.slice(from, from + Math.min(requested, SERVER_CAP)), table.rows.length);
      },
      // Awaiting the builder is how PostgREST executes a keyset query.
      then<R1, R2>(
        onFulfilled?: ((value: Page<Row>) => R1 | PromiseLike<R1>) | null,
        onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
      ): PromiseLike<R1 | R2> {
        calls.push({ gt: gtValue ?? undefined, limit: limitValue });
        if (opts.failWith) {
          return Promise.resolve({ data: null, error: { message: opts.failWith }, count: null })
            .then(onFulfilled, onRejected);
        }
        const after = opts.ignoreCursor || gtValue === null ? table.rows : table.rows.filter((r) => r.id > gtValue!);
        const cap =
          opts.truncateAt && opts.truncateAt.page === pageIndex
            ? opts.truncateAt.serve
            : Math.min(limitValue, SERVER_CAP);
        const served = after.slice(0, cap);
        // The cursor IS a filter, so the count is the remainder after it.
        return Promise.resolve(respond(served, after.length)).then(onFulfilled, onRejected);
      },
    };
    return builder;
  };

  return { factory, calls, table, reportedCounts };
}

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    // The fixture must actually CONTAIN the row that truncation would eat.
    ...(i + 1 === n ? { marker: "LAST" } : {}),
  }));
}

function duplicateIds(rows: Row[]): number[] {
  const seen = new Set<number>();
  const dups: number[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) dups.push(r.id);
    seen.add(r.id);
  }
  return dups;
}

// ── 1. The bug this exists to kill: row 1001 must come back ──────────────────
{
  const rows = makeRows(1001);
  const { factory, calls } = fakeTable(rows);
  const out = await fetchAllRowsComplete!<Row>(factory);

  assert.equal(out.length, 1001, "pager must return every row, not the first server page");
  assert.equal(
    out.at(-1)?.marker,
    "LAST",
    "row 1001 is exactly what the 1000-row cap silently drops — it must be present"
  );
  assert.ok(calls.length >= 2, "a >1000-row result set requires more than one request");
}

// ── 2. Positive control: a complete fetch must NOT throw ─────────────────────
// Without this, a pager that threw unconditionally would pass every guard test.
{
  const { factory } = fakeTable(makeRows(5));
  const out = await fetchAllRowsComplete!<Row>(factory);
  assert.equal(out.length, 5, "a small complete result set must come back untouched");
}

// ── 3. Completeness guard fires when the server has more than it served ──────
{
  // Server admits 1500 matching rows but only ever hands over the 1000 it holds.
  const { factory } = fakeTable(makeRows(1000), { reportedCount: 1500 });
  await assert.rejects(
    () => fetchAllRowsComplete!<Row>(factory),
    /incomplete/i,
    "accumulated !== count must throw, not return a short array"
  );
}

// ── 4. Exact-boundary: 1000 rows is complete, and must terminate ─────────────
{
  const { factory, calls } = fakeTable(makeRows(1000));
  const out = await fetchAllRowsComplete!<Row>(factory);
  assert.equal(out.length, 1000, "exactly one full page is still a complete fetch");
  assert.ok(calls.length <= 3, "must not spin extra requests once count is satisfied");
}

// ── 5. Query errors surface, never silently truncate ────────────────────────
{
  const { factory } = fakeTable(makeRows(10), { failWith: "permission denied for table invoices" });
  await assert.rejects(
    () => fetchAllRowsComplete!<Row>(factory),
    /permission denied for table invoices/,
    "a query error must propagate its message"
  );

  // The original error OBJECT must survive as `cause`. Callers that tolerate a
  // specific failure (e.g. isMissingRelationError, which reads `code`) cannot do
  // so from a flattened string.
  const caught = await fetchAllRowsComplete!<Row>(factory).then(
    () => null,
    (error: unknown) => error as { cause?: { message?: string } }
  );
  assert.equal(
    caught?.cause?.message,
    "permission denied for table invoices",
    "the raw query error must be reachable via `cause`"
  );
}

// ── 6. A server that reports no count at all cannot be certified complete ───
{
  const { factory } = fakeTable(makeRows(1001), { reportedCount: null });
  await assert.rejects(
    () => fetchAllRowsComplete!<Row>(factory),
    /count/i,
    "without count:'exact' the pager has no oracle for completeness and must refuse"
  );
}

// ── 7. Runaway guard: refuse rather than page forever ───────────────────────
{
  const { factory } = fakeTable(makeRows(3000));
  await assert.rejects(
    () => fetchAllRowsComplete!<Row>(factory, { maxRows: 2000 }),
    /2000/,
    "exceeding maxRows must fail loud and name the limit"
  );
}

// ── 8. Review case 1: a row inserted BEHIND the cursor mid-scan ────────────
// This is the defect that killed v1. 1001 rows; after page 1 is served, a row
// is inserted low in the ordering. An OFFSET pager then re-reads one row it has
// already seen and never reads the row that exists past it — and `count` grew by
// one at the same time, so length === count still holds. Silently wrong.
//
// The pager must never return a duplicate, and must THROW rather than hand back
// a set it cannot certify.
{
  const { factory } = fakeTable(makeRows(1001), {
    afterPage: (pageIndex, table) => {
      if (pageIndex !== 0) return;
      // id 0 sorts before every row already read — behind the cursor.
      table.rows.unshift({ id: 0, marker: "INSERTED_BEHIND_CURSOR" });
    },
  });

  const outcome = await fetchAllRowsComplete!<Row>(factory).then(
    (rows) => ({ rows, threw: null as Error | null }),
    (error: Error) => ({ rows: [] as Row[], threw: error })
  );

  assert.deepEqual(
    duplicateIds(outcome.rows),
    [],
    "a concurrent insert must never make the pager return the same row twice — " +
      "offset paging re-reads the boundary row, keyset paging cannot"
  );

  // ── DECLARED RESIDUAL #3, and this expectation is INVERTED from what it was ──
  // This case used to assert the pager THROWS here, and it passed. It passed
  // because the fake reported `table.rows.length` on every page, so the inserted
  // row inflated the final count. Real PostgREST counts the FILTERED set, and a row
  // inserted BEHIND the cursor is in neither the remainder (it is below the cursor)
  // nor the first page's total (it did not exist yet). It is therefore invisible to
  // every count-based oracle, and asserting a throw was asserting a guarantee the
  // server never gave — a test passing for a reason that did not exist.
  //
  // What the pager DOES guarantee here is still worth having, and is strictly more
  // than the offset version gave: no duplicate, and the complete set as of the
  // scan's first page. The offset version returned a duplicated boundary row AND
  // dropped row 1001 on this exact scenario.
  //
  // Pinned as "must NOT throw" on purpose. The only way to detect this insert is an
  // extra uncursored count at the end of the scan, which would make every report on
  // a table written during business hours fail intermittently — `reservation_nights`
  // is written on every booking create and cancel. If someone decides that
  // trade is worth making, this assertion goes RED and forces the decision to be
  // explicit instead of arriving as a silent behaviour change on a money read.
  assert.equal(
    outcome.threw,
    null,
    "an insert BEHIND the cursor is invisible to a filter-scoped count — the pager must return " +
      "the first-page set rather than throw on a change it cannot see. If this now throws, " +
      "someone added an end-of-scan recount: that is a deliberate trade, not a bug fix"
  );
  assert.equal(outcome.rows.length, 1001, "the pre-insert set must come back whole");
  assert.equal(
    outcome.rows.at(-1)?.marker,
    "LAST",
    "row 1001 must be present — this is the row an offset pager silently dropped here"
  );
  assert.ok(
    !outcome.rows.some((r) => r.marker === "INSERTED_BEHIND_CURSOR"),
    "the row inserted after page 1 must not appear: the returned set is the scan's start state, " +
      "which is what makes it a consistent set rather than a mixture of two"
  );
}

// ── 9. Duplicates are impossible even when the count is forced to reconcile ──
// Hardens case 8: here `count` is pinned to exactly what an offset pager would
// accumulate, so the cardinality oracle CANNOT fire. Only an identity-space
// guarantee survives this. If the pager returns duplicates here, its oracle is
// certifying size and calling it completeness.
{
  const { factory } = fakeTable(makeRows(1001), {
    reportedCount: 1002,
    afterPage: (pageIndex, table) => {
      if (pageIndex === 0) table.rows.unshift({ id: 0 });
    },
  });

  const outcome = await fetchAllRowsComplete!<Row>(factory).then(
    (rows) => ({ rows, threw: null as Error | null }),
    (error: Error) => ({ rows: [] as Row[], threw: error })
  );

  assert.deepEqual(
    duplicateIds(outcome.rows),
    [],
    "with the count rigged to reconcile, a duplicate is proof the pager pages by " +
      "POSITION — the whole defect found in review"
  );
}

// ── 10. A server that ignores the cursor must be caught, not trusted ────────
// Keyset correctness depends on the server honouring `.gt`. If it re-serves from
// the top, ids stop increasing across pages — the pager must notice rather than
// accumulate the same rows forever.
{
  const { factory } = fakeTable(makeRows(1001), { ignoreCursor: true });
  await assert.rejects(
    () => fetchAllRowsComplete!<Row>(factory),
    /cursor|order|identit/i,
    "if page N+1 does not start after page N, the cursor is not being honoured and " +
      "the pager must refuse rather than loop or duplicate"
  );
}

// ── 11. A row missing the cursor column cannot be paged ─────────────────────
// A call site that forgets to SELECT `id` would otherwise break paging in a way
// that looks like a short result. Fail loud and name the column.
{
  const rows = makeRows(1001).map(({ marker }) => ({ marker }) as unknown as Row);
  const { factory } = fakeTable(rows);
  await assert.rejects(
    () => fetchAllRowsComplete!<Row>(factory),
    /id/,
    "paging by identity requires the cursor column in the projection — say so"
  );
}

// ── 12. `count` IS FILTER-SCOPED: the remainder must never be read as the total ─
// The defect measured against real PostgREST (1519 rows):
//
//   page 1, no cursor        Content-Range: 0-999/1519
//   page 2, id=gt.<cursor>   Content-Range: 0-518/519
//
// A pager that re-pins `expected = count` every page ends the scan comparing 1519
// loaded rows against the last page's 519 and throws on EVERY multi-page read. In
// production it surfaced as a 500 reading "loaded 1519 of 519 rows" — the numbers
// inverted, which is the tell. Three pages here so the remainder shrinks TWICE.
{
  const { factory, reportedCounts } = fakeTable(makeRows(2001));
  const out = await fetchAllRowsComplete!<Row>(factory);

  // INSTRUMENT CHECK FIRST. If the fake reported the table size on every page — as
  // it did until a measured finding — this case could not fail no matter what the pager
  // did, and the pager's own bench would keep certifying a pager the server breaks.
  assert.deepEqual(
    reportedCounts,
    [2001, 1001, 1],
    "the FAKE must model a filter-scoped count: full total on the uncursored page, then the " +
      "remainder after each cursor. If this reads [2001, 2001, 2001] the fake is lying and " +
      "every other assertion in this case is worthless"
  );

  assert.equal(out.length, 2001, "all three pages must be returned, not the last remainder");
  assert.deepEqual(duplicateIds(out), [], "keyset paging must not duplicate across three pages");
  assert.equal(out.at(-1)?.marker, "LAST", "the final row must survive a three-page walk");
}

// ── 13. The remainder is still an oracle: it must equal what is left to fetch ───
// The design note on the fix. Pinning the total from page 1 alone would let a
// mid-scan change go unnoticed until the final comparison; each later page can
// certify itself, because its count is exactly "rows still owed". Here row 1001 is
// deleted AHEAD of the cursor after page 1, so page 2 reports 0 where 1 was owed.
{
  const { factory } = fakeTable(makeRows(1001), {
    afterPage: (pageIndex, table) => {
      if (pageIndex === 0) table.rows = table.rows.filter((r) => r.id !== 1001);
    },
  });

  await assert.rejects(
    () => fetchAllRowsComplete!<Row>(factory),
    /changed under the scan|still owed/i,
    "a page whose remainder disagrees with what is owed must name the moving set, at the page " +
      "where it moved — not as a bare total mismatch after the walk finishes"
  );
}

// ── 14. An AHEAD-INSERT must be tolerated, not rejected (one-sided) ──
// A row inserted PAST the cursor mid-scan is served by a later page. Nothing is
// skipped and nothing is duplicated, so the scan is sound — the result is simply a
// superset of the set that existed when it began. Strict per-page equality made
// this a hard failure (measured "reports 1501, expected 1500"), which is the
// churn tax the review withdrew arriving through the remainder door. These tables
// are written during the hours the reports run, so this case is the difference
// between a report that works and one that fails intermittently.
{
  const { factory } = fakeTable(makeRows(1001), {
    afterPage: (pageIndex, table) => {
      if (pageIndex === 0) table.rows.push({ id: 1500, marker: "INSERTED_AHEAD" });
    },
  });

  const outcome = await fetchAllRowsComplete!<Row>(factory).then(
    (rows) => ({ rows, threw: null as Error | null }),
    (error: Error) => ({ rows: [] as Row[], threw: error })
  );

  assert.equal(
    outcome.threw,
    null,
    "one benign row inserted past the cursor must NOT fail the read — the remainder is allowed " +
      "to GROW, and a hard error here is the churn tax that was explicitly withdrawn"
  );
  assert.equal(outcome.rows.length, 1002, "the served ahead-insert belongs in the result");
  assert.deepEqual(duplicateIds(outcome.rows), [], "growth must not introduce a duplicate");
  assert.ok(
    outcome.rows.some((r) => r.marker === "INSERTED_AHEAD"),
    "SUPERSET, NOT SNAPSHOT: a row created ahead of the cursor mid-scan is included, and that " +
      "is documented behaviour rather than an accident"
  );
}

// ── 15. A BEHIND-DELETE is accepted read skew, and stays accepted ──────────────
// A row read on page 1 that is deleted before the walk ends is still in the result.
// No client-side oracle can see it: the remainder is unaffected and the first
// page's total already counted it. Pinned so the limit is a decision on the record
// rather than a surprise — closing it needs a transactional RPC, which is DB work.
{
  const { factory } = fakeTable(makeRows(1001), {
    afterPage: (pageIndex, table) => {
      if (pageIndex === 0) table.rows = table.rows.filter((r) => r.id !== 1);
    },
  });

  const outcome = await fetchAllRowsComplete!<Row>(factory).then(
    (rows) => ({ rows, threw: null as Error | null }),
    (error: Error) => ({ rows: [] as Row[], threw: error })
  );

  assert.equal(outcome.threw, null, "a delete behind the cursor is read skew, not a failed fetch");
  assert.equal(outcome.rows.length, 1001, "the set as of page 1 is what comes back");
  assert.ok(
    outcome.rows.some((r) => r.id === 1),
    "READ SKEW, DECLARED: the deleted row is still in the result because the scan already read " +
      "it. This is the residual a single transactional RPC would close and this pager cannot"
  );
}

// ── 16. A SERVER THAT ENDS THE WALK EARLY MUST BE CAUGHT ─────────────────────
// This is the case the suite was missing, and it is the one that matters most.
//
// Since a later design decision the walk terminates on a SHORT PAGE and the final guard
// is DOWNWARD ONLY. Both are right, and together they mean a wrongly pinned
// `expected` can no longer be caught by anything else: re-pin it to a later page's
// remainder and it becomes a SMALLER number, and a smaller number passes a
// downward-only comparison trivially.
//
// Measured, not reasoned: re-inserting the filed defect (`expected = count` on
// every page) left the entire suite GREEN at 363/363 before this case existed. With
// it, that mutant reports "loaded 1500 of 1001" and dies here.
//
// The scenario is a measured warning made executable — the server's own count says 1001
// rows remain after the cursor, and it hands back 500. Nothing about that page looks
// wrong in isolation.
{
  const { factory } = fakeTable(makeRows(2001), { truncateAt: { page: 1, serve: 500 } });

  await assert.rejects(
    () => fetchAllRowsComplete!<Row>(factory),
    (error: Error) =>
      /Incomplete fetch/.test(error.message) && /of 2001 rows/.test(error.message),
    "a server that serves a short page while its own count says more rows remain is SILENT " +
      "TRUNCATION — the exact defect this sweep exists to kill. The comparison must be against " +
      "the FIRST page's total (2001); against any later remainder the shortfall vanishes"
  );
}

// ── 17. GROWTH ADOPTION IS LOAD-BEARING — the compound witness ───────────────
// A later review finding, and it corrects something I had written down as redundant.
//
// I observed that the final guard's `<` and `!==` are indistinguishable once growth
// is adopted, and concluded the pair was belt-and-braces. Half right: the DIRECTION
// is untestable while adoption is present, but ADOPTION ITSELF IS NOT REDUNDANT. The
// two mask each other — remove either alone and every test stays green; remove both
// and an ahead-insert throws "loaded 2501 of 2500". Measured, reproduced
// here before this case was written.
//
// Adoption is load-bearing because `expected` feeds `owed`, and `owed` is what the
// shrink branch compares against. Delete the adoption line and `owed` stays too small
// forever, so promised rows can vanish without the guard ever firing.
//
// The witness has to be COMPOUND: grow ahead of the cursor, THEN delete promised
// rows. Neither half alone can see it.
{
  const { factory } = fakeTable(makeRows(2500), {
    afterPage: (pageIndex, table) => {
      if (pageIndex === 0) {
        // +500 ahead of everything: adoption must raise `expected` to 3000.
        for (let i = 0; i < 500; i++) table.rows.push({ id: 4001 + i });
      } else if (pageIndex === 1) {
        // −300 rows that were PROMISED at page 1 and are still unread.
        table.rows = table.rows.filter((r) => r.id < 2001 || r.id > 2300);
      }
    },
  });

  await assert.rejects(
    () => fetchAllRowsComplete!<Row>(factory),
    /shrank under the scan|still owed/i,
    "300 promised rows were deleted mid-scan and must be reported. Without growth adoption " +
      "`owed` stays pinned to the original total, the remainder never falls below it, and the " +
      "pager returns 2700 rows missing 300 promised ones while reporting success"
  );
}
