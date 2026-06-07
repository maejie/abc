export function listPeriods(startPeriod: string, endPeriod: string): string[] {
  const [startYear, startMonth] = parsePeriod(startPeriod);
  const [endYear, endMonth] = parsePeriod(endPeriod);
  const periods: string[] = [];

  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    periods.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }

  return periods;
}

function parsePeriod(period: string): [number, number] {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new Error(`Invalid period: ${period}`);
  return [Number(match[1]), Number(match[2])];
}
