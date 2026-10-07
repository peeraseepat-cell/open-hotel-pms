export const LF_DRAFT_KEY = "maid:lf-report:draft";
export const LF_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export interface LfReportDraftFields {
  roomId: string;
  description: string;
  locationDetail: string;
  category: string;
  createdItemId: string | null;
  photoPromised: boolean;
}

export interface LfReportDraft extends LfReportDraftFields {
  open: true;
  savedAt: number;
}

export function serializeLfDraft(fields: LfReportDraftFields, now: number): string {
  const draft: LfReportDraft = { open: true, savedAt: now, ...fields };
  return JSON.stringify(draft);
}
export function parseLfDraft(raw: string | null, now: number): LfReportDraft | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const d = parsed as Record<string, unknown>;
  if (d.open !== true) return null;
  if (typeof d.savedAt !== "number" || !Number.isFinite(d.savedAt)) return null;
  if (d.savedAt > now || now - d.savedAt >= LF_DRAFT_TTL_MS) return null;

  return {
    open: true,
    savedAt: d.savedAt,
    roomId: typeof d.roomId === "string" ? d.roomId : "",
    description: typeof d.description === "string" ? d.description : "",
    locationDetail: typeof d.locationDetail === "string" ? d.locationDetail : "",
    category: typeof d.category === "string" && d.category ? d.category : "general",
    createdItemId: typeof d.createdItemId === "string" && d.createdItemId ? d.createdItemId : null,
    photoPromised: d.photoPromised === true,
  };
}
