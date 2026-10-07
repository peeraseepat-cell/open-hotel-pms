export function resolveCheckoutReleaseStartDate(
  businessDate: string,
  lastConsumedStayDate: string | null
): string {
  if (!lastConsumedStayDate) return businessDate;

  const date = new Date(`${lastConsumedStayDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
