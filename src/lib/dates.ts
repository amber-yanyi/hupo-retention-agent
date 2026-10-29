// The book is a snapshot; all date logic runs against its as-of date, not the wall clock.
export const AS_OF = "2026-09-11";
export const GRACE_DAYS = 30;

const DAY = 86_400_000;
const toUtc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

export function daysBetween(from: string, to: string) {
  return Math.round((toUtc(to) - toUtc(from)) / DAY);
}

export function addDays(d: string, n: number) {
  return new Date(toUtc(d) + n * DAY).toISOString().slice(0, 10);
}
