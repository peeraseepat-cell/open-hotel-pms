import assert from "node:assert/strict";

let listLaundryReturnPartition:
  | ((supabase: any, currentBatchId: string) => Promise<any[]>)
  | undefined;

try {
  ({ listLaundryReturnPartition } = await import("./return-partition.ts"));
} catch (error) {
  assert.fail(`return partition adapter is missing: ${error instanceof Error ? error.message : String(error)}`);
}

const batchId = "11111111-1111-4111-8111-111111111111";
const row = {
  id: "33333333-3333-4333-8333-333333333333",
  source_batch_id: "22222222-2222-4222-8222-222222222222",
  linen_item_id: 1,
  is_dayuse: false,
  sent_by_hotel: 5,
  received_back: 4,
  remaining_qty: 1,
  source_business_date: "2026-07-18",
  source_pickup_round: 1,
  lane: "overdue",
  item_number: 1,
  name_th: "ปลอกหมอน",
};

function fakeSupabase(result: { data: any[] | null; error: any; count: number | null }) {
  const calls: Array<{ name: string; args: unknown; options: unknown }> = [];
  return {
    calls,
    client: {
      async rpc(name: string, args: unknown, options: unknown) {
        calls.push({ name, args, options });
        return result;
      },
    },
  };
}

{
  const fake = fakeSupabase({ data: [row], error: null, count: 1 });
  const result = await listLaundryReturnPartition!(fake.client, batchId);

  assert.deepEqual(result, [row], "matching exact count must return the RPC rows unchanged");
  assert.deepEqual(fake.calls, [
    {
      name: "fn_laundry_return_partition",
      args: { p_current_batch_id: batchId },
      options: { count: "exact" },
    },
  ]);
}

{
  const fake = fakeSupabase({ data: null, error: null, count: 0 });
  const result = await listLaundryReturnPartition!(fake.client, batchId);
  assert.deepEqual(result, [], "an empty authoritative partition is valid");
}

{
  const fake = fakeSupabase({ data: [row], error: null, count: null });
  const result = await listLaundryReturnPartition!(fake.client, batchId);
  assert.deepEqual(
    result,
    [row],
    "missing RPC count below the PostgREST row cap must fall back to the returned rows"
  );
}

{
  const cappedRows = Array.from({ length: 1000 }, (_, index) => ({
    ...row,
    id: `row-${index}`,
  }));
  const fake = fakeSupabase({ data: cappedRows, error: null, count: null });
  await assert.rejects(
    listLaundryReturnPartition!(fake.client, batchId),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.match(message, /incomplete return partition/i);
      assert.match(message, /returned=1000/);
      assert.match(message, /count unavailable/i);
      assert.match(message, new RegExp(batchId));
      return true;
    },
    "missing RPC count at the PostgREST row cap must fail visibly"
  );
}

{
  const fake = fakeSupabase({ data: [row], error: null, count: 2 });
  await assert.rejects(
    listLaundryReturnPartition!(fake.client, batchId),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.match(message, /incomplete return partition/i);
      assert.match(message, /returned=1/);
      assert.match(message, /expected=2/);
      assert.match(message, new RegExp(batchId));
      return true;
    },
    "a PostgREST-shortened rowset must fail visibly"
  );
}

{
  const fake = fakeSupabase({ data: null, error: { message: "rpc exploded" }, count: null });
  await assert.rejects(
    listLaundryReturnPartition!(fake.client, batchId),
    /rpc exploded/,
    "RPC errors must propagate"
  );
}
