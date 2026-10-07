import type { TaxInvoiceKind, TaxInvoiceLineItem } from "./types";

/**
 * Which set of line items the edit screen opens with.
 *
 * The saved document wins. Rebuilding from the reservation discards the
 * document's editorial decisions — merged room lines collapse back to one line
 * per room, and extra charges vanish, since `buildLineItems` emits room charges
 * only and offers extras separately. IV260807 lost the same THB 100 line twice
 * in one day to that rebuild, on edits that never touched the line items.
 *
 * Split invoices are the exception, and it is a money exception, not a taste
 * one: on save, `prepareEditedCoverageLineItems` recomputes `full_net_total`
 * from the submitted lines. Their saved lines are already scaled down to the
 * covered portion, so seeding from them would write the covered amount into the
 * reservation's full total and leave the sibling balance invoice short.
 */
export function pickEditSeedLineItems(input: {
  saved: TaxInvoiceLineItem[] | null | undefined;
  rebuilt: TaxInvoiceLineItem[] | null | undefined;
  invoiceKind: TaxInvoiceKind | string | null | undefined;
}): TaxInvoiceLineItem[] {
  const { saved, rebuilt, invoiceKind } = input;
  const isSplit = Boolean(invoiceKind) && invoiceKind !== "standard";

  if (isSplit) return rebuilt ?? saved ?? [];
  return saved ?? rebuilt ?? [];
}
