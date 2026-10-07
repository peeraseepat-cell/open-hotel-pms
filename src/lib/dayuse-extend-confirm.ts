export type DayUseExtendMethod = "cash" | "transfer" | "credit_card";

export function isDayUseExtendMethod(raw: string): raw is DayUseExtendMethod {
  return raw === "cash" || raw === "transfer" || raw === "credit_card";
}

export function buildDayUseExtendRequest(input: {
  paymentMethod: string;
  paymentAmount: number;
}): { payment_method: DayUseExtendMethod; payment_amount: number } | null {
  if (!isDayUseExtendMethod(input.paymentMethod)) return null;
  if (!Number.isFinite(input.paymentAmount) || input.paymentAmount < 0) return null;
  return {
    payment_method: input.paymentMethod,
    payment_amount: input.paymentAmount,
  };
}

export function formatDayUseExtendConfirm(input: {
  minutes: number;
  amountLabel: string;
  methodLabel: string;
}): string {
  return [
    `จะต่อเวลา Day Use ${input.minutes} นาที`,
    `คิดเงิน ${input.amountLabel} ช่องทาง ${input.methodLabel}`,
    "ถ้าไม่ได้ต่อเวลา ให้กดยกเลิก",
  ].join("\n");
}
