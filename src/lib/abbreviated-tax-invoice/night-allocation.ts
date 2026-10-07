export type AllocationReservation = {
  checkin_date: string;
  checkout_date: string;
};

export type AllocationNight = {
  stay_date: string;
  nightly_price: number;
  cancelled_at: string | null;
};

export type CoveredRoomRevenueByStayDate = Record<string, number | null | undefined>;

function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function addDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00+07:00`);
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function stayDatesBetween(checkinDate: string, checkoutDate: string): string[] {
  const dates: string[] = [];
  if (!checkinDate || !checkoutDate || checkinDate >= checkoutDate) return dates;
  for (let current = checkinDate; current < checkoutDate; current = addDays(current, 1)) {
    dates.push(current);
  }
  return dates;
}

function sortNights<T extends AllocationNight>(nights: T[]): T[] {
  return [...nights].sort((left, right) => left.stay_date.localeCompare(right.stay_date));
}

export function sumNightPrices(nights: AllocationNight[]): number {
  return round2(nights.reduce((sum, night) => sum + round2(night.nightly_price), 0));
}

function isWholeBaht(value: number): boolean {
  return Math.abs(round2(value) - Math.round(round2(value))) < 0.005;
}

function distributeUnitsByWeight(total: number, weights: number[], unit: number): number[] {
  const totalUnits = Math.round(round2(total) / unit);
  if (totalUnits <= 0 || weights.length === 0) return weights.map(() => 0);

  const weightTotal = weights.reduce((sum, weight) => sum + Math.max(0, round2(weight)), 0);
  if (weightTotal <= 0) {
    const base = Math.floor(totalUnits / weights.length);
    let remaining = totalUnits - base * weights.length;
    return weights.map(() => {
      const units = base + (remaining > 0 ? 1 : 0);
      remaining -= remaining > 0 ? 1 : 0;
      return round2(units * unit);
    });
  }

  const shares = weights.map((weight, index) => {
    const exact = (totalUnits * Math.max(0, round2(weight))) / weightTotal;
    const units = Math.floor(exact);
    return { index, units, remainder: exact - units };
  });
  let remaining = totalUnits - shares.reduce((sum, share) => sum + share.units, 0);
  for (const share of [...shares].sort((left, right) => right.remainder - left.remainder || left.index - right.index)) {
    if (remaining <= 0) break;
    share.units += 1;
    remaining -= 1;
  }

  return shares
    .sort((left, right) => left.index - right.index)
    .map((share) => round2(share.units * unit));
}

export function distributeAuditTotalAcrossNights(total: number, nights: AllocationNight[]): number[] {
  const normalizedTotal = round2(Math.max(0, total));
  if (normalizedTotal <= 0 || nights.length === 0) return [];

  const nightlyPrices = nights.map((night) => round2(Math.max(0, night.nightly_price)));
  const nightlyTotal = round2(nightlyPrices.reduce((sum, price) => sum + price, 0));
  if (nightlyTotal > 0 && Math.abs(nightlyTotal - normalizedTotal) < 0.005) return nightlyPrices;

  const unit = [normalizedTotal, ...nightlyPrices].every(isWholeBaht) ? 1 : 0.01;
  return distributeUnitsByWeight(
    normalizedTotal,
    nightlyTotal > 0 ? nightlyPrices : nights.map(() => 1),
    unit
  );
}

export function allocateRoomAndExtraAcrossNights(params: {
  roomAuditTotal: number;
  extraAuditTotal: number;
  includedNights: AllocationNight[];
  capRoomToIncludedNightTotal: boolean;
}): { roomTotal: number; extraTotal: number; amounts: number[] } {
  const includedNights = params.includedNights;
  if (includedNights.length === 0) return { roomTotal: 0, extraTotal: 0, amounts: [] };

  const nightlyTotal = sumNightPrices(includedNights);
  const rawRoomTotal = round2(Math.max(0, params.roomAuditTotal));
  let roomTotal = computeInvoiceableRoomTotal({
    auditRoomTotal: rawRoomTotal,
    includedNights,
    capToIncludedNightTotal: params.capRoomToIncludedNightTotal,
  });
  let extraTotal = round2(Math.max(0, params.extraAuditTotal));

  if (!params.capRoomToIncludedNightTotal && nightlyTotal > 0 && rawRoomTotal > nightlyTotal) {
    extraTotal = round2(extraTotal + rawRoomTotal - nightlyTotal);
    roomTotal = nightlyTotal;
  }

  const amounts = includedNights.map(() => 0);
  const roomAmounts = roomTotal > 0 ? distributeAuditTotalAcrossNights(roomTotal, includedNights) : [];
  for (const [index, amount] of roomAmounts.entries()) {
    amounts[index] = round2(amount);
  }
  if (extraTotal > 0) {
    const lastIndex = amounts.length - 1;
    amounts[lastIndex] = round2(amounts[lastIndex] + extraTotal);
  }

  return {
    roomTotal,
    extraTotal,
    amounts,
  };
}

export function completeChargedReservationNightsFromAuditTotal<T extends AllocationNight>(
  reservation: AllocationReservation,
  loadedNights: T[],
  auditRoomTotal: number,
  refundTotal: number
): T[] {
  const activeNights = loadedNights.filter((night) => !night.cancelled_at);
  if (auditRoomTotal <= 0) return sortNights(activeNights);
  if (refundTotal > 0) return sortNights(activeNights);

  const residualTotal = round2(auditRoomTotal - sumNightPrices(activeNights));
  if (residualTotal <= 0) return sortNights(activeNights);

  const activeDates = new Set(activeNights.map((night) => night.stay_date));
  const missingDates = stayDatesBetween(reservation.checkin_date, reservation.checkout_date)
    .filter((stayDate) => !activeDates.has(stayDate));
  if (missingDates.length === 0) return sortNights(activeNights);

  const cancelledCandidates: T[] = [];
  for (const stayDate of missingDates) {
    const candidates = loadedNights
      .filter((night) => night.cancelled_at && night.stay_date === stayDate && night.nightly_price > 0)
      .sort((left, right) =>
        round2(right.nightly_price) - round2(left.nightly_price) ||
        String(right.cancelled_at).localeCompare(String(left.cancelled_at))
      );
    if (candidates.length === 0) return sortNights(activeNights);
    cancelledCandidates.push(candidates[0]);
  }

  const candidateTotal = sumNightPrices(cancelledCandidates);
  if (Math.abs(candidateTotal - residualTotal) > 0.01) return sortNights(activeNights);

  return sortNights([...activeNights, ...cancelledCandidates]);
}

export function applyCoveredRoomRevenueToNights<T extends AllocationNight>(
  nights: T[],
  coveredByStayDate: CoveredRoomRevenueByStayDate | null | undefined
): T[] {
  const remainingCoverage = new Map<string, number>();
  for (const [stayDate, amount] of Object.entries(coveredByStayDate ?? {})) {
    const normalized = round2(Number(amount ?? 0));
    if (normalized > 0) remainingCoverage.set(stayDate, normalized);
  }
  if (remainingCoverage.size === 0) return nights.map((night) => ({ ...night, nightly_price: round2(night.nightly_price) }));

  return nights
    .map((night) => {
      const price = round2(night.nightly_price);
      const covered = round2(remainingCoverage.get(night.stay_date) ?? 0);
      if (covered <= 0) return { ...night, nightly_price: price };

      const remainingPrice = round2(Math.max(0, price - covered));
      remainingCoverage.set(night.stay_date, round2(Math.max(0, covered - price)));
      return { ...night, nightly_price: remainingPrice };
    })
    .filter((night) => night.nightly_price > 0);
}

export function computeInvoiceableRoomTotal(params: {
  auditRoomTotal: number;
  includedNights: AllocationNight[];
  capToIncludedNightTotal: boolean;
}): number {
  const auditRoomTotal = round2(Math.max(0, params.auditRoomTotal));
  if (!params.capToIncludedNightTotal) return auditRoomTotal;
  return round2(Math.min(auditRoomTotal, sumNightPrices(params.includedNights)));
}
