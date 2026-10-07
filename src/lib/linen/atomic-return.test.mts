import assert from "node:assert/strict";

let applyLaundryReturnStepAtomic:
  | ((
      supabase: any,
      currentBatchId: string,
      submission: Record<string, unknown>,
      actorName: string | null,
      cleanup?: (entries: Array<{ rewash_event_id: number; key: string }>) => Promise<void>
    ) => Promise<any>)
  | undefined;

try {
  ({ applyLaundryReturnStepAtomic } = await import("./atomic-return.ts"));
} catch (error) {
  assert.fail(`atomic return adapter is missing: ${error instanceof Error ? error.message : String(error)}`);
}

const batchId = "11111111-1111-4111-8111-111111111111";
const submission = {
  return_items: [],
  pending_resolved: [],
  rewash_resolved: [{ rewash_event_id: 7, resolved_qty: 2 }],
};
const cleanupEntries = [
  { rewash_event_id: 7, key: "rewash/linen/source/photo.jpg" },
];

{
  const sequence: string[] = [];
  const calls: any[] = [];
  const clearedIds: number[] = [];
  const supabase = {
    async rpc(name: string, args: unknown) {
      sequence.push("rpc-committed");
      calls.push({ name, args });
      return {
        data: { status: "fo_return_counted", photo_cleanup: cleanupEntries },
        error: null,
      };
    },
    from(table: string) {
      assert.equal(table, "laundry_rewash_events");
      const query = {
        update(payload: unknown) {
          assert.deepEqual(payload, { photo_keys: [] });
          return query;
        },
        eq(column: string, value: unknown) {
          if (column === "id") clearedIds.push(Number(value));
          return query;
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          sequence.push("db-keys-cleared");
          return Promise.resolve({ error: null }).then(onFulfilled, onRejected);
        },
      };
      return query;
    },
  };

  const result = await applyLaundryReturnStepAtomic!(
    supabase,
    batchId,
    submission,
    "Front Office",
    async (entries) => {
      sequence.push("r2-cleanup");
      assert.deepEqual(entries, cleanupEntries);
    }
  );

  assert.deepEqual(sequence, ["rpc-committed", "r2-cleanup", "db-keys-cleared"], "DB key clearing must follow R2 cleanup");
  assert.deepEqual(clearedIds, [7]);
  assert.deepEqual(calls, [
    {
      name: "fn_laundry_apply_return_step",
      args: {
        p_current_batch_id: batchId,
        p_submission: submission,
        p_actor_name: "Front Office",
      },
    },
  ]);
  assert.equal(result.status, "fo_return_counted");
}

{
  let cleanupCalled = false;
  const supabase = {
    async rpc() {
      return { data: null, error: { message: "transaction rolled back" } };
    },
  };

  await assert.rejects(
    applyLaundryReturnStepAtomic!(
      supabase,
      batchId,
      submission,
      null,
      async () => {
        cleanupCalled = true;
      }
    ),
    /transaction rolled back/
  );
  assert.equal(cleanupCalled, false, "R2 cleanup must never run when the DB transaction fails");
}

{
  const supabase = {
    async rpc() {
      return {
        data: { status: "fo_return_counted", photo_cleanup: cleanupEntries },
        error: null,
      };
    },
    from() {
      assert.fail("database keys must not be cleared when R2 cleanup fails");
    },
  };

  const originalConsoleError = console.error;
  const orphanLogs: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    orphanLogs.push(args);
  };
  let result;
  try {
    result = await applyLaundryReturnStepAtomic!(
      supabase,
      batchId,
      submission,
      null,
      async () => {
        throw new Error("R2 unavailable");
      }
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(
    result.status,
    "fo_return_counted",
    "post-commit cleanup failure must not convert committed inventory into a retry error"
  );
  assert.equal(orphanLogs.length, 1, "every orphaned key must be logged");
  assert.deepEqual(orphanLogs[0][1], {
    batch_id: batchId,
    rewash_event_id: 7,
    orphan_key: "rewash/linen/source/photo.jpg",
    error: new Error("R2 unavailable"),
  });
}

{
  const supabase = {
    async rpc() {
      return {
        data: { status: "fo_return_counted", photo_cleanup: cleanupEntries },
        error: null,
      };
    },
    from(table: string) {
      assert.equal(table, "laundry_rewash_events");
      const query = {
        update(payload: unknown) {
          assert.deepEqual(payload, { photo_keys: [] });
          return query;
        },
        eq() {
          return query;
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          return Promise.resolve({ error: { message: "clear failed" } }).then(onFulfilled, onRejected);
        },
      };
      return query;
    },
  };

  const originalConsoleError = console.error;
  const clearLogs: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    clearLogs.push(args);
  };
  let result;
  try {
    result = await applyLaundryReturnStepAtomic!(
      supabase,
      batchId,
      submission,
      null,
      async () => undefined
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(result.status, "fo_return_counted");
  assert.equal(clearLogs.length, 1);
  assert.deepEqual(clearLogs[0][1], {
    batch_id: batchId,
    rewash_event_id: 7,
    stale_key: "rewash/linen/source/photo.jpg",
    error: new Error("clear failed"),
  });
}

for (const expected of [
  { message: "Rewash event is not pending.", status: 409 },
  { message: "resolved_qty cannot exceed rewash qty.", status: 400 },
]) {
  const supabase = {
    async rpc() {
      return { data: null, error: { message: expected.message } };
    },
  };

  await assert.rejects(
    applyLaundryReturnStepAtomic!(supabase, batchId, submission, null),
    (error: unknown) => {
      assert.equal((error as Error).message, expected.message);
      assert.equal((error as any).status, expected.status);
      return true;
    },
    "A2 must preserve the staff-visible rewash error message and HTTP status"
  );
}

{
  let clears = 0;
  const supabase = {
    async rpc() { return {data: {status: "fo_return_counted",photo_cleanup:cleanupEntries}, error:null}; },
    from() { clears += 1; return {update(){ return {eq(){ return {eq:async()=>({error:null})}; }}; }}; },
  };
  const result = await applyLaundryReturnStepAtomic!(supabase,batchId,submission,null);
  assert.equal(result.status,"fo_return_counted");
  assert.equal(clears,0,"an omitted cleanup callback must retain durable photo references");
}
