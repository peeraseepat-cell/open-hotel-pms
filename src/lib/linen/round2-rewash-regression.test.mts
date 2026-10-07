import assert from "node:assert/strict";
import test from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { resolveRewashEvent } from "./rewash.ts";

// Synthetic credentials and an intercepted SDK avoid network access.
process.env.R2_ENDPOINT = "http://127.0.0.1:1";
process.env.R2_ACCESS_KEY_ID = "fixture";
process.env.R2_SECRET_ACCESS_KEY = "fixture";

test("successful rewash resolution survives failed photo-reference clearing", async () => {
  const originalSend = S3Client.prototype.send;
  (S3Client.prototype as any).send = async () => ({});
  const logs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args);
  const event = { id: 7, qty: 1, resolved_qty: 0, status: "pending", photo_keys: ["rewash/linen/fixture.jpg"] };
  const audit: any[] = [];
  const db: any = { from(table: string) {
    let payload: any;
    const q: any = {
      select() { return q; }, eq() { return q; },
      update(value: any) { payload = value; return q; },
      maybeSingle: async () => ({data: event, error: null}),
      single: async () => payload.photo_keys
        ? {data: null, error: {message: "fixture clear failed"}}
        : {data: {...event, ...payload}, error: null},
      insert: async (value: any) => { assert.equal(table, "laundry_batch_events"); audit.push(value); return {error:null}; },
    };
    return q;
  }};
  try {
    let result: any;
    await assert.doesNotReject(async () => {
      result = await resolveRewashEvent(db, {id: 7, resolvedBatchId: "11111111-1111-4111-8111-111111111111", resolvedQty: 1});
    }, "post-resolution reference cleanup must not invite a duplicate inventory retry");
    assert.equal(result.status, "resolved");
    assert.deepEqual(result.photo_keys, event.photo_keys);
    assert.equal(audit.length, 1);
    assert.equal(logs.length, 1);
  } finally { S3Client.prototype.send = originalSend; console.error = originalError; }
});
