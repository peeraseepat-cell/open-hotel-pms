export type FolioPaymentMethodEditRow = {
  tx_type?: string | null;
  method?: string | null;
  paid_date?: string | null;
  is_record_only?: boolean | null;
  is_void_reversal?: boolean | null;
  is_correction?: boolean | null;
  void_of?: string | null;
};

function isOperatorPaymentMethod(method: unknown): method is "cash" | "transfer" | "credit_card" {
  return method === "cash" || method === "transfer" || method === "credit_card";
}

export function canEditFolioPaymentMethod(
  row: FolioPaymentMethodEditRow,
  options: {
    hasReservation: boolean;
    businessDate: string;
    ledgerReadonly: boolean;
    allowMethodEditWhenReadonly: boolean;
    isVoided: boolean;
  }
): boolean {
  if (!options.hasReservation) return false;
  if (options.ledgerReadonly && !options.allowMethodEditWhenReadonly) return false;
  if (row.tx_type !== "payment" && row.tx_type !== "deposit") return false;
  if (!isOperatorPaymentMethod(row.method)) return false;
  if (row.paid_date !== options.businessDate) return false;
  if (row.is_record_only || row.is_void_reversal || row.is_correction || row.void_of) return false;
  if (options.isVoided) return false;
  return true;
}
