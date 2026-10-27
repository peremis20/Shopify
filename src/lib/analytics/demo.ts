import { daysInRange, listDates, pctChange } from "./dates";
import type { DateRange, Delta, GaData, GscData, PeriodRanges } from "./types";

/**
 * Realistic looking sample data so the dashboard is usable before any
 * credentials are added. Seeded, so the numbers stay stable between reloads.
 */

function seeded(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

function series(range: DateRange, base: number, growth: number, seed: number) {
  const rand = seeded(seed);
  return listDates(range).map((date, i) => {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekly = day === 0 || day === 6 ? 0.78 : 1.06;
    const trend = 1 + growth * (i / Math.max(1, daysInRange(range)));
    return Math.round(base * weekly * trend * (0.9 + rand() * 0.2));
  });
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const delta = (value: number, previous: number): Delta => ({
  value,
  previous,
  change: pctChange(value, previous),
});

export function demoGa(ranges: PeriodRanges): GaData {
  const users = series(ranges.current, 4100, 0.25, 7);
  const views = users.map((u, i) => Math.round(u * (2.9 + ((i * 7) % 5) / 10)));
  const prevUsers = sum(series(ranges.previous, 3900, 0.1, 11));
  const totalUsers = sum(users);
  const totalViews = sum(views);
  const sessions = Math.round(totalUsers * 1.42);

  const channelSplit: [string, number][] = [
    ["Organic Search", 0.423],
    ["Direct", 0.187],
    ["Referral", 0.125],
    ["Organic Social", 0.112],
    ["Email", 0.081],
    ["Paid Search", 0.072],
  ];
  const pages: [string, number, number][] = [
    ["/", 0.137, 165],
    ["/nutrition", 0.128, 192],
    ["/mental-health", 0.095, 138],
    ["/wellness", 0.074, 122],
    ["/fitness", 0.065, 118],
    ["/sleep", 0.051, 151],
    ["/recipes", 0.044, 204],
    ["/about", 0.021, 64],
  ];

  return {
    totals: {
      users: delta(totalUsers, prevUsers),
      pageViews: delta(totalViews, Math.round(prevUsers * 3.05)),
      sessions: delta(sessions, Math.round(prevUsers * 1.39)),
      avgEngagementSec: delta(138, 120),
    },
    daily: listDates(ranges.current).map((date, i) => ({
      date,
      users: users[i],
      pageViews: views[i],
    })),
    channels: channelSplit.map(([name, share]) => ({
      name,
      sessions: Math.round(sessions * share),
      share: share * 100,
    })),
    topPages: pages.map(([path, share, avgTimeSec]) => ({
      path,
      views: Math.round(totalViews * share),
      avgTimeSec,
    })),
  };
}

export function demoGsc(ranges: PeriodRanges): GscData {
  const clicks = series(ranges.current, 2200, 0.3, 23);
  const impressions = clicks.map((c, i) => Math.round(c * (33 + ((i * 3) % 7))));
  const totalClicks = sum(clicks);
  const totalImpr = sum(impressions);
  const prevClicks = sum(series(ranges.previous, 2000, 0.1, 29));

  const queries: [string, number, number][] = [
    ["brain health tips", 0.061, 5.2],
    ["natural supplements", 0.058, 6.1],
    ["mental wellness", 0.05, 7.3],
    ["healthy lifestyle", 0.043, 8.6],
    ["nutrition advice", 0.04, 9.1],
    ["sleep better naturally", 0.031, 6.8],
    ["gut health foods", 0.027, 11.4],
    ["daily vitamins guide", 0.022, 12.9],
  ];
  const pages: [string, number][] = [
    ["https://example.com/nutrition", 0.21],
    ["https://example.com/mental-health", 0.17],
    ["https://example.com/", 0.12],
    ["https://example.com/sleep", 0.09],
    ["https://example.com/wellness", 0.08],
  ];

  return {
    totals: {
      clicks: delta(totalClicks, prevClicks),
      impressions: delta(totalImpr, Math.round(prevClicks * 34.5)),
      ctr: delta((totalClicks / totalImpr) * 100, 2.76),
      position: delta(12.4, 13.5),
    },
    daily: listDates(ranges.current).map((date, i) => ({
      date,
      clicks: clicks[i],
      impressions: impressions[i],
    })),
    topQueries: queries.map(([query, share, position]) => {
      const c = Math.round(totalClicks * share);
      const impr = Math.round(c * (10 + position));
      return { query, clicks: c, impressions: impr, ctr: (c / impr) * 100, position };
    }),
    topPages: pages.map(([page, share]) => {
      const c = Math.round(totalClicks * share);
      return { page, clicks: c, impressions: Math.round(c * 30) };
    }),
  };
}
