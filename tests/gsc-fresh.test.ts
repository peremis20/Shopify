/**
 * Early hourly Search Console numbers: the 24 hours before now are totaled,
 * older hours are left out, and no data means no numbers rather than zeros.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeHourly } from "../src/lib/analytics/gsc";

const NOW = Date.parse("2026-11-11T19:30:00Z");
const row = (hour: string, clicks: number, impressions: number) => ({
  keys: [hour],
  clicks,
  impressions,
  ctr: 0,
  position: 0,
});

test("no hourly rows gives null, not zeros", () => {
  assert.equal(summarizeHourly([], NOW), null);
  assert.equal(summarizeHourly([row("not a time", 5, 9)], NOW), null);
});

test("totals only the last 24 hours before now, in any order", () => {
  const rows = [
    row("2026-11-11T10:00:00-08:00", 3, 30),
    row("2026-11-10T10:00:00-08:00", 100, 1000), // over 24 hours ago: left out
    row("2026-11-10T12:00:00-08:00", 2, 20),
    row("2026-11-11T09:00:00-08:00", 1, 10),
  ];
  const fresh = summarizeHourly(rows, NOW)!;
  assert.equal(fresh.clicks, 6);
  assert.equal(fresh.impressions, 60);
  assert.equal(fresh.hours, 3);
  assert.equal(fresh.latestHour, "2026-11-11T18:00:00.000Z");
});

test("a quiet site with only old hours shows nothing, not an old day as today", () => {
  assert.equal(summarizeHourly([row("2026-11-09T10:00:00-08:00", 4, 40)], NOW), null);
});
