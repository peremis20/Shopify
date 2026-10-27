import type { DateRange, PeriodRanges, RangeKey } from "./types";

export const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "7d", label: "Last 7 days" },
  { key: "28d", label: "Last 28 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "lastMonth", label: "Last month" },
];

export function isRangeKey(value: unknown): value is RangeKey {
  return RANGE_OPTIONS.some((o) => o.key === value);
}

const DAY = 86_400_000;

export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fromIso(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY);
}

function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function daysInRange(range: DateRange): number {
  return Math.round((fromIso(range.end).getTime() - fromIso(range.start).getTime()) / DAY) + 1;
}

/** Every date in the range, oldest first. */
export function listDates(range: DateRange): string[] {
  const out: string[] = [];
  for (let d = fromIso(range.start); d <= fromIso(range.end); d = addDays(d, 1)) {
    out.push(toIso(d));
  }
  return out;
}

/** The same number of days immediately before the given range. */
export function previousRange(range: DateRange): DateRange {
  const len = daysInRange(range);
  const end = addDays(fromIso(range.start), -1);
  return { start: toIso(addDays(end, -(len - 1))), end: toIso(end) };
}

/**
 * Resolves a preset into current and previous periods.
 * `lagDays` shifts the end date back for sources that report late:
 * GA4 is complete through yesterday, Search Console runs about 3 days behind.
 */
export function resolveRange(key: RangeKey, lagDays: number): PeriodRanges {
  const lastComplete = addDays(todayUtc(), -lagDays);
  let current: DateRange;

  if (key === "lastMonth") {
    const t = todayUtc();
    const start = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1));
    const monthEnd = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0));
    const end = monthEnd < lastComplete ? monthEnd : lastComplete;
    current = { start: toIso(start), end: toIso(end) };
  } else {
    const days = { "7d": 7, "28d": 28, "90d": 90 }[key];
    current = {
      start: toIso(addDays(lastComplete, -(days - 1))),
      end: toIso(lastComplete),
    };
  }

  return { current, previous: previousRange(current) };
}

export function pctChange(value: number, previous: number): number | null {
  if (!previous) return null;
  return ((value - previous) / previous) * 100;
}
