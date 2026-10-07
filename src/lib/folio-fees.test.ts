import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";

const originalResolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function resolveWithSrcAlias(request: string, ...rest: unknown[]) {
  if (request.startsWith("@/")) {
    return originalResolveFilename.call(this, path.join(process.cwd(), "src", request.slice(2)), ...rest);
  }
  return originalResolveFilename.call(this, request, ...rest);
};

const { computeFeeSummary } = require("./folio-fees") as typeof import("./folio-fees");

type FeePaymentRow = import("./folio-fees").FeePaymentRow;

function extraChargeRow(txType: "payment" | "refund", isRecordOnly: boolean): FeePaymentRow {
  return {
    id: `${txType}-${String(isRecordOnly)}`,
    tx_type: txType,
    method: "cash",
    amount: 500,
    note: null,
    paid_at: "2026-06-06T00:00:00.000Z",
    paid_date: "2026-06-06",
    created_at: "2026-06-06T00:00:00.000Z",
    revenue_category: "extra_charge",
    fee_template_code: null,
    is_record_only: isRecordOnly,
  };
}

const paidChargeReversed = computeFeeSummary(5000, 0, [
  extraChargeRow("payment", false),
  extraChargeRow("refund", false),
]);
assert.equal(paidChargeReversed.extra_charges_total, 0);
assert.equal(paidChargeReversed.total_paid, 0);
assert.equal(paidChargeReversed.balance, 5000);

const onAccountChargeReversed = computeFeeSummary(5000, 0, [
  extraChargeRow("payment", true),
  extraChargeRow("refund", true),
]);
assert.equal(onAccountChargeReversed.extra_charges_total, 0);
assert.equal(onAccountChargeReversed.total_paid, 0);
assert.equal(onAccountChargeReversed.balance, 5000);

const paidChargeWrongRecordOnlyRefund = computeFeeSummary(5000, 0, [
  extraChargeRow("payment", false),
  extraChargeRow("refund", true),
]);
assert.equal(paidChargeWrongRecordOnlyRefund.balance, 4500);
