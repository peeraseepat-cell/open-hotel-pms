import assert from "node:assert/strict";

let allocatePendingAcrossVariants:
  | ((
      rows: Array<{
        id: string;
        sent_by_hotel: number;
        received_back: number;
        is_dayuse: boolean;
      }>,
      pendingQty: number
    ) => Array<{ id: string; qty: number; is_dayuse: boolean }>)
  | undefined;

try {
  ({ allocatePendingAcrossVariants } = await import("./pending-service.ts"));
} catch (error) {
  assert.fail(`pending allocation helper is missing: ${error instanceof Error ? error.message : String(error)}`);
}

{
  const allocations = allocatePendingAcrossVariants!(
    [
      {
        id: "normal",
        sent_by_hotel: 5,
        received_back: 2,
        is_dayuse: false,
      },
    ],
    3
  );

  assert.deepEqual(allocations, [{ id: "normal", qty: 3, is_dayuse: false }]);
}

{
  const allocations = allocatePendingAcrossVariants!(
    [
      {
        id: "dayuse",
        sent_by_hotel: 4,
        received_back: 2,
        is_dayuse: true,
      },
      {
        id: "normal",
        sent_by_hotel: 5,
        received_back: 2,
        is_dayuse: false,
      },
    ],
    5
  );

  assert.deepEqual(
    allocations,
    [
      { id: "normal", qty: 3, is_dayuse: false },
      { id: "dayuse", qty: 2, is_dayuse: true },
    ],
    "a merged pending marker must resolve both authoritative variants without ambiguity"
  );
}

assert.throws(
  () =>
    allocatePendingAcrossVariants!(
      [
        {
          id: "normal",
          sent_by_hotel: 5,
          received_back: 4,
          is_dayuse: false,
        },
      ],
      2
    ),
  /exceeds authoritative remaining/i,
  "a stale merged marker must not over-receive a source row"
);
