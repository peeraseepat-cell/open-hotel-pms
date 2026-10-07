import type { TaxInvoiceKind, TaxInvoiceLineItem } from "./types";

type DiscountType = "percent" | "fixed_total" | "fixed_per_night" | string | null;

export type ReservationDiscountInput = {
  id: string;
  discount_type?: DiscountType;
  discount_value?: number | string | null;
  discount_percent?: number | string | null;
  rate_plan_id?: string | null;
};

type CoverageInput = {
  invoiceKind: TaxInvoiceKind;
  coverageAmount?: number | string | null;
  alreadyCoveredAmount?: number | string | null;
};

type AllocationTarget<T> = {
  item: T;
  amountSatang: number;
};

export class TaxInvoiceCoverageError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "TaxInvoiceCoverageError";
    this.status = status;
  }
}

function toSatang(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function fromSatang(value: number): number {
  return Math.round(value) / 100;
}

function norm(value: unknown): number {
  return fromSatang(toSatang(value));
}

function positiveSatang(value: unknown): number {
  return Math.max(0, toSatang(value));
}

function allocateSatang<T>(
  targets: AllocationTarget<T>[],
  totalSatang: number
): Array<{ item: T; allocatedSatang: number }> {
  const positiveTargets = targets.filter((target) => target.amountSatang > 0);
  if (positiveTargets.length === 0 || totalSatang <= 0) {
    return targets.map((target) => ({ item: target.item, allocatedSatang: 0 }));
  }

  const totalBase = positiveTargets.reduce((sum, target) => sum + target.amountSatang, 0);
  let used = 0;
  const allocations = new Map<T, number>();

  positiveTargets.forEach((target, index) => {
    const allocated = index === positiveTargets.length - 1
      ? Math.max(0, totalSatang - used)
      : Math.floor((totalSatang * target.amountSatang) / totalBase);
    used += allocated;
    allocations.set(target.item, allocated);
  });

  return targets.map((target) => ({
    item: target.item,
    allocatedSatang: allocations.get(target.item) ?? 0,
  }));
}

function roomLineGrossSatang(item: TaxInvoiceLineItem): number {
  const gross = item.gross_amount !== undefined
    ? positiveSatang(item.gross_amount)
    : positiveSatang(item.amount) + positiveSatang(item.discount_amount);
  return Math.max(gross, positiveSatang(item.amount));
}

function calculateReservationDiscountSatang(
  items: TaxInvoiceLineItem[],
  reservation: ReservationDiscountInput
): number {
  if (reservation.rate_plan_id) return 0;

  const discountType = String(reservation.discount_type ?? "").trim().toLowerCase();
  if (!discountType) return 0;

  const grossSatang = items.reduce((sum, item) => sum + roomLineGrossSatang(item), 0);
  if (grossSatang <= 0) return 0;

  const rawValue = reservation.discount_value ?? reservation.discount_percent ?? 0;
  const value = Number(rawValue ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;

  if (discountType === "percent") {
    return Math.min(grossSatang, Math.round((grossSatang * value) / 100));
  }

  if (discountType === "fixed_total") {
    return Math.min(grossSatang, toSatang(value));
  }

  if (discountType === "fixed_per_night") {
    const uniqueDates = new Set<string>();
    for (const item of items) {
      for (const stayDate of item.stay_dates ?? []) uniqueDates.add(stayDate);
    }
    const quantity = uniqueDates.size || items.reduce((sum, item) => sum + Math.max(0, Number(item.quantity || 0)), 0);
    return Math.min(grossSatang, Math.round(toSatang(value) * quantity));
  }

  return 0;
}

export function applyReservationDiscountsToLineItems(
  lineItems: TaxInvoiceLineItem[],
  reservations: ReservationDiscountInput[]
): TaxInvoiceLineItem[] {
  const reservationById = new Map(reservations.map((reservation) => [reservation.id, reservation]));
  const discountByItem = new Map<TaxInvoiceLineItem, number>();

  for (const reservation of reservations) {
    const reservationItems = lineItems.filter(
      (item) => item.kind === "room_charge" && item.reservation_id === reservation.id
    );
    const discountSatang = calculateReservationDiscountSatang(reservationItems, reservation);
    const allocations = allocateSatang(
      reservationItems.map((item) => ({ item, amountSatang: roomLineGrossSatang(item) })),
      discountSatang
    );

    for (const allocation of allocations) {
      discountByItem.set(allocation.item, allocation.allocatedSatang);
    }
  }

  return lineItems.map((item) => {
    const reservation = item.reservation_id ? reservationById.get(item.reservation_id) : null;
    const existingDiscountSatang = positiveSatang(item.discount_amount);
    const appliedDiscountSatang = reservation ? (discountByItem.get(item) ?? 0) : existingDiscountSatang;
    const grossSatang = item.kind === "room_charge"
      ? roomLineGrossSatang(item)
      : positiveSatang(item.gross_amount ?? item.amount);
    const netSatang = Math.max(0, grossSatang - appliedDiscountSatang);

    return {
      ...item,
      gross_amount: fromSatang(grossSatang),
      discount_amount: fromSatang(appliedDiscountSatang),
      amount: fromSatang(netSatang),
    };
  });
}

export function sumLineItemAmounts(lineItems: TaxInvoiceLineItem[]): number {
  return norm(lineItems.reduce((sum, item) => sum + norm(item.amount), 0));
}

export function sumLineItemGross(lineItems: TaxInvoiceLineItem[]): number {
  return norm(
    lineItems.reduce((sum, item) => {
      const gross = item.gross_amount !== undefined
        ? norm(item.gross_amount)
        : norm(item.amount) + norm(item.discount_amount);
      return sum + gross;
    }, 0)
  );
}

export function sumLineItemDiscounts(lineItems: TaxInvoiceLineItem[]): number {
  return norm(lineItems.reduce((sum, item) => sum + norm(item.discount_amount), 0));
}

function scaleLineSources(
  sources: TaxInvoiceLineItem["merged_line_sources"],
  ratio: number,
  targetAmountSatang?: number
): TaxInvoiceLineItem["merged_line_sources"] {
  if (!sources?.length) return sources;

  const sourceTargets = sources.map((source) => ({
    item: source,
    amountSatang: positiveSatang(source.amount),
  }));
  const totalSourceSatang = sourceTargets.reduce((sum, source) => sum + source.amountSatang, 0);
  const scaledTargetSatang = targetAmountSatang ?? Math.round(totalSourceSatang * ratio);
  const amountAllocations = allocateSatang(sourceTargets, scaledTargetSatang);

  return amountAllocations.map(({ item, allocatedSatang }) => {
    const originalAmountSatang = positiveSatang(item.amount);
    const sourceRatio = originalAmountSatang > 0 ? allocatedSatang / originalAmountSatang : ratio;
    const discountSatang = Math.round(positiveSatang(item.discount_amount) * sourceRatio);
    return {
      ...item,
      gross_amount: fromSatang(allocatedSatang + discountSatang),
      discount_amount: fromSatang(discountSatang),
      amount: fromSatang(allocatedSatang),
    };
  });
}

function scaleLineItemsToCoverage(
  lineItems: TaxInvoiceLineItem[],
  coverageSatang: number
): TaxInvoiceLineItem[] {
  const currentNetSatang = lineItems.reduce((sum, item) => sum + positiveSatang(item.amount), 0);
  if (currentNetSatang <= 0 || coverageSatang <= 0) {
    throw new TaxInvoiceCoverageError("Coverage amount must be greater than zero.");
  }

  if (coverageSatang === currentNetSatang) return lineItems.map((item) => ({ ...item }));

  const allocations = allocateSatang(
    lineItems.map((item) => ({ item, amountSatang: positiveSatang(item.amount) })),
    coverageSatang
  );

  return allocations.map(({ item, allocatedSatang }) => {
    const originalNetSatang = positiveSatang(item.amount);
    const ratio = originalNetSatang > 0 ? allocatedSatang / originalNetSatang : 0;
    const originalDiscountSatang = positiveSatang(item.discount_amount);
    const scaledDiscountSatang = Math.round(originalDiscountSatang * ratio);
    const grossSatang = allocatedSatang + scaledDiscountSatang;
    const quantity = Math.max(1, Number(item.quantity || 1));

    return {
      ...item,
      gross_amount: fromSatang(grossSatang),
      discount_amount: fromSatang(scaledDiscountSatang),
      amount: fromSatang(allocatedSatang),
      unit_price: fromSatang(grossSatang / quantity),
      merged_line_sources: scaleLineSources(item.merged_line_sources, ratio, allocatedSatang),
    };
  });
}

export function prepareCoverageLineItems(
  lineItems: TaxInvoiceLineItem[],
  input: CoverageInput
): { lineItems: TaxInvoiceLineItem[]; fullNetTotal: number; coverageAmount: number } {
  const invoiceKind = input.invoiceKind;
  const fullNetTotalSatang = lineItems.reduce((sum, item) => sum + positiveSatang(item.amount), 0);
  const alreadyCoveredSatang = positiveSatang(input.alreadyCoveredAmount);
  if (fullNetTotalSatang <= 0) {
    throw new TaxInvoiceCoverageError("Invoice total must be greater than zero.");
  }

  if (invoiceKind === "standard") {
    return {
      lineItems: lineItems.map((item) => ({ ...item })),
      fullNetTotal: fromSatang(fullNetTotalSatang),
      coverageAmount: fromSatang(fullNetTotalSatang),
    };
  }

  if (alreadyCoveredSatang > fullNetTotalSatang) {
    throw new TaxInvoiceCoverageError("Existing split invoice coverage exceeds the discounted net total.");
  }

  const coverageSatang = invoiceKind === "balance"
    ? fullNetTotalSatang - alreadyCoveredSatang
    : positiveSatang(input.coverageAmount);

  if (coverageSatang <= 0) {
    throw new TaxInvoiceCoverageError(
      invoiceKind === "balance"
        ? "No remaining balance is available for this reservation."
        : "Prepayment coverage amount must be greater than zero."
    );
  }

  if (alreadyCoveredSatang + coverageSatang > fullNetTotalSatang) {
    throw new TaxInvoiceCoverageError("Split invoice coverage cannot exceed the discounted net total.");
  }

  return {
    lineItems: scaleLineItemsToCoverage(lineItems, coverageSatang),
    fullNetTotal: fromSatang(fullNetTotalSatang),
    coverageAmount: fromSatang(coverageSatang),
  };
}


/**
 * Same remaining-balance semantics as prepareCoverageLineItems for "balance":
 * coverage is complete when already-covered satang >= full-net satang (and full net > 0).
 * A prepayment that covers the full discounted net leaves remaining = 0, so balance
 * cannot be issued — Pending must treat that the same as standard/balance coverage.
 */
export function isCoverageFullySatisfied(
  alreadyCoveredAmount: unknown,
  fullNetTotal: unknown
): boolean {
  const fullSatang = positiveSatang(fullNetTotal);
  if (fullSatang <= 0) return false;
  return positiveSatang(alreadyCoveredAmount) >= fullSatang;
}

/** Sum coverage amounts using the same satang rounding as prepareCoverageLineItems. */
export function sumCoverageAmounts(amounts: readonly unknown[]): number {
  const sumSatang = amounts.reduce<number>((sum, amount) => sum + positiveSatang(amount), 0);
  return fromSatang(sumSatang);
}

export function prepareEditedCoverageLineItems(
  lineItems: TaxInvoiceLineItem[],
  input: CoverageInput
): { lineItems: TaxInvoiceLineItem[]; fullNetTotal: number; coverageAmount: number } {
  if (input.invoiceKind === "standard") {
    return prepareCoverageLineItems(lineItems, input);
  }

  return prepareCoverageLineItems(lineItems, {
    invoiceKind: "prepayment",
    coverageAmount: input.coverageAmount,
    alreadyCoveredAmount: 0,
  });
}
