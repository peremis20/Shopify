/**
 * Google search landing pages read as plain rows, and GA4's "(not set)" page is left out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { landingRows } from "../src/lib/analytics/ga4";

const row = (path: string, ...m: number[]) => ({
  dimensionValues: [{ value: path }],
  metricValues: m.map((v) => ({ value: String(v) })),
});

test("landing pages keep visits, key actions, sales and revenue in order", () => {
  const out = landingRows({ rows: [row("/shop", 40, 3, 2, 120.5), row("(not set)", 9, 0, 0, 0), row("/", 10, 0, 0, 0)] });
  assert.deepEqual(out, [
    { path: "/shop", sessions: 40, keyEvents: 3, orders: 2, revenue: 120.5 },
    { path: "/", sessions: 10, keyEvents: 0, orders: 0, revenue: 0 },
  ]);
});

test("no rows gives an empty list", () => {
  assert.deepEqual(landingRows({}), []);
});
