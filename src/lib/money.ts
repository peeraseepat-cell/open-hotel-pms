export function toSatang(value: unknown): number {
  if (typeof value === "string") {
    const text = value.trim().replace(/,/g, "");
    if (!text) return 0;
    const matched = text.match(/^([+-])?(\d+)(?:\.(\d+))?$/);
    if (matched) {
      const sign = matched[1] === "-" ? -1 : 1;
      const intPart = Number(matched[2]) || 0;
      const fracRaw = matched[3] ?? "";
      const fracTwo = `${fracRaw}00`.slice(0, 2);
      const fracPart = Number(fracTwo) || 0;
      return sign * (intPart * 100 + fracPart);
    }
  }

  const n = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  return sign * Math.round(abs * 100);
}

export function fromSatang(satang: number): number {
  if (!Number.isFinite(satang)) return 0;
  return satang / 100;
}

export function formatMoney(value: unknown, locale = "th-TH"): string {
  const amount = fromSatang(toSatang(value));
  return amount.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

