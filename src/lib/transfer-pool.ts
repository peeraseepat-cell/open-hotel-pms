import { fromSatang, toSatang } from "./money";

export type TransferPoolInput = {
  sellingPrice: unknown;
  costPrice: unknown;
  driverFee: unknown;
};

// Keep the recorded pool consistent with the transfer's selling price and costs.
export function computeTransferPool(input: TransferPoolInput): number {
  return fromSatang(toSatang(input.sellingPrice) - toSatang(input.costPrice) - toSatang(input.driverFee));
}
