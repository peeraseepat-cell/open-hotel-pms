import { isCoverageFullySatisfied, sumCoverageAmounts } from "./coverage";
import { extractReservationIdsFromBookingSnapshot } from "./service";
import type { TaxInvoiceKind } from "./types";

/**
 * Issued invoice row shape needed to decide whether Pending should hide a reservation.
 * Matches the expanded "issued invoices" select on GET /api/tax-invoice.
 */
export type IssuedInvoiceCoverageRow = {
  reservation_id?: string | null;
  booking_snapshot?: unknown;
  invoice_kind?: string | null;
  coverage_amount?: number | string | null;
  grand_total?: number | string | null;
};

function normalizeInvoiceKind(value: unknown): TaxInvoiceKind {
  const kind = String(value ?? "standard").trim().toLowerCase();
  return kind === "prepayment" || kind === "balance" ? kind : "standard";
}

function fullNetTotalFromRow(row: IssuedInvoiceCoverageRow): unknown {
  const snapshot =
    row.booking_snapshot && typeof row.booking_snapshot === "object"
      ? (row.booking_snapshot as Record<string, unknown>)
      : null;
  return snapshot?.full_net_total ?? row.coverage_amount ?? row.grand_total ?? 0;
}

function coverageAmountFromRow(row: IssuedInvoiceCoverageRow): unknown {
  return row.coverage_amount ?? row.grand_total ?? 0;
}

/**
 * Reservation ids that should leave the tax-invoice Pending queue.
 *
 * - standard / balance issued invoices fully cover every id in booking_snapshot
 *   (existing behaviour).
 * - prepayment invoices are aggregated by the sorted reservation-id scope from
 *   booking_snapshot.reservation_ids; when summed coverage >= full_net_total
 *   (coverage-module satang semantics), those ids are fully covered too.
 */
export function collectFullyCoveredReservationIds(
  issuedRows: readonly IssuedInvoiceCoverageRow[]
): Set<string> {
  const fullyCovered = new Set<string>();

  for (const row of issuedRows) {
    if (normalizeInvoiceKind(row.invoice_kind) === "prepayment") continue;
    for (const id of extractReservationIdsFromBookingSnapshot(row.booking_snapshot, row.reservation_id)) {
      fullyCovered.add(id);
    }
  }

  type ScopeAcc = {
    coveredAmounts: unknown[];
    fullNet: unknown;
    ids: string[];
  };
  const byScope = new Map<string, ScopeAcc>();

  for (const row of issuedRows) {
    if (normalizeInvoiceKind(row.invoice_kind) !== "prepayment") continue;
    const ids = extractReservationIdsFromBookingSnapshot(row.booking_snapshot, row.reservation_id);
    if (ids.length === 0) continue;

    const scopeKey = [...ids].sort().join("\0");
    const existing = byScope.get(scopeKey);
    const coveredRaw = coverageAmountFromRow(row);
    const snapshotFullNet =
      row.booking_snapshot && typeof row.booking_snapshot === "object"
        ? (row.booking_snapshot as Record<string, unknown>).full_net_total
        : undefined;

    if (!existing) {
      byScope.set(scopeKey, {
        coveredAmounts: [coveredRaw],
        fullNet: fullNetTotalFromRow(row),
        ids,
      });
      continue;
    }

    existing.coveredAmounts.push(coveredRaw);
    if (snapshotFullNet != null && String(snapshotFullNet).trim() !== "") {
      existing.fullNet = snapshotFullNet;
    }
  }

  for (const acc of byScope.values()) {
    const covered = sumCoverageAmounts(acc.coveredAmounts);
    if (isCoverageFullySatisfied(covered, acc.fullNet)) {
      for (const id of acc.ids) fullyCovered.add(id);
    }
  }

  return fullyCovered;
}
