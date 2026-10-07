type ChannelGroup = "ota" | "walkin_direct";
type AbbreviatedSourceType = "room" | "dayuse" | "pos";

type NumberedDraft = {
  source_type: AbbreviatedSourceType;
  issue_date: string;
  channel_group: ChannelGroup | null;
  predicted_invoice_no: string;
};

type PersistedInvoiceIdentity = {
  id: string;
  source_type: AbbreviatedSourceType;
  issue_date: string;
  channel_group: ChannelGroup | null;
};

function thaiYearYY(issueDate: string): string {
  const year = Number(issueDate.slice(0, 4));
  const beYear = year + 543;
  return String(beYear % 100).padStart(2, "0");
}

function sequenceSuffix(issueDate: string, sequenceInMonth?: number): string {
  const sequence = sequenceInMonth ?? Number(issueDate.slice(8, 10));
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`Invalid abbreviated invoice sequence: ${sequenceInMonth}`);
  }
  return `${thaiYearYY(issueDate)}${issueDate.slice(5, 7)}${String(sequence).padStart(2, "0")}`;
}

export function computeAbbreviatedInvoiceNo(
  issueDate: string,
  channelGroup: ChannelGroup | null,
  sourceType: AbbreviatedSourceType = "room",
  sequenceInMonth?: number
): string {
  if (sourceType === "dayuse") {
    return `DY${thaiYearYY(issueDate)}${issueDate.slice(5, 7)}`;
  }

  const suffix = sequenceSuffix(issueDate, sequenceInMonth);
  if (sourceType === "pos") return `D${suffix}`;
  return `${channelGroup === "walkin_direct" ? "W" : ""}${suffix}`;
}

function sequenceGroupKey(draft: NumberedDraft): string {
  if (draft.source_type === "room") return `${draft.source_type}:${draft.channel_group ?? ""}`;
  return draft.source_type;
}

function invoiceIdentityKey(invoice: Omit<NumberedDraft, "predicted_invoice_no">): string {
  if (invoice.source_type === "room") {
    return `${invoice.source_type}::${invoice.issue_date}::${invoice.channel_group ?? ""}`;
  }
  if (invoice.source_type === "dayuse") return `${invoice.source_type}::period`;
  return `${invoice.source_type}::${invoice.issue_date}`;
}

export function planAbbreviatedInvoiceRenumbering(
  existingInvoices: PersistedInvoiceIdentity[],
  drafts: NumberedDraft[]
): { assignments: Array<{ id: string; invoice_no: string }>; stale_ids: string[] } {
  const draftByKey = new Map(drafts.map((draft) => [invoiceIdentityKey(draft), draft]));
  const assignments: Array<{ id: string; invoice_no: string }> = [];
  const staleIds: string[] = [];

  for (const invoice of existingInvoices) {
    const draft = draftByKey.get(invoiceIdentityKey(invoice));
    if (!draft) {
      staleIds.push(invoice.id);
      continue;
    }
    assignments.push({ id: invoice.id, invoice_no: draft.predicted_invoice_no });
  }

  return { assignments, stale_ids: staleIds };
}

export function assignSequentialInvoiceNumbers<T extends NumberedDraft>(drafts: T[]): T[] {
  const nextDrafts = drafts.map((draft) => ({ ...draft }));
  const indexesByGroup = new Map<string, number[]>();

  nextDrafts.forEach((draft, index) => {
    const indexes = indexesByGroup.get(sequenceGroupKey(draft)) ?? [];
    indexes.push(index);
    indexesByGroup.set(sequenceGroupKey(draft), indexes);
  });

  for (const indexes of indexesByGroup.values()) {
    indexes.sort((left, right) => {
      const a = nextDrafts[left];
      const b = nextDrafts[right];
      return a.issue_date.localeCompare(b.issue_date) || left - right;
    });

    indexes.forEach((draftIndex, sequenceIndex) => {
      const draft = nextDrafts[draftIndex];
      draft.predicted_invoice_no = computeAbbreviatedInvoiceNo(
        draft.issue_date,
        draft.channel_group,
        draft.source_type,
        draft.source_type === "dayuse" ? undefined : sequenceIndex + 1
      );
    });
  }

  return nextDrafts;
}
