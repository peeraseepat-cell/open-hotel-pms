// Escape user input for use inside PostgREST .or() quoted ilike values while
// preserving literal substring semantics.
export function escapeOrValue(value: string): string {
  const ilikeEscaped = value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  return ilikeEscaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildQuotedIlikeOrFilter(columns: readonly string[], value: string): string {
  const escaped = escapeOrValue(value);
  return columns.map((column) => `${column}.ilike."%${escaped}%"`).join(",");
}
