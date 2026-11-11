/**
 * Analytics splits and shopping steps: plain names, percents, biggest first,
 * and no funnel when the site sends no product views.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { funnelSteps, splitRows } from "../src/lib/analytics/ga4";

const row = (name: string, ...m: number[]) => ({
  dimensionValues: [{ value: name }],
  metricValues: m.map((v) => ({ value: String(v) })),
});

test("splits read as plain words, rates as percents, biggest first", () => {
  const out = splitRows({ rows: [row("desktop", 10, 0.5, 1), row("mobile", 30, 0.6, 2), row("(not set)", 99, 0, 0), row("returning", 5, 0.8, 0)] });
  assert.deepEqual(out.map((r) => r.name), ["Mobile", "Desktop", "Returning visitors"]);
  assert.equal(out[0].engagementRate, 60);
  assert.equal(out[0].orders, 2);
});

test("countries keep their own names", () => {
  assert.equal(splitRows({ rows: [row("United States", 4, 0.5, 0)] })[0].name, "United States");
});

test("shopping steps come in order, missing steps count zero", () => {
  const out = funnelSteps({ rows: [row("purchase", 2), row("view_item", 100), row("add_to_cart", 20)] });
  assert.deepEqual(out, [
    { step: "Viewed a product", users: 100 },
    { step: "Added to cart", users: 20 },
    { step: "Started checkout", users: 0 },
    { step: "Bought", users: 2 },
  ]);
});

test("no product views means no funnel, not a row of zeros", () => {
  assert.equal(funnelSteps({ rows: [row("purchase", 3)] }), null);
  assert.equal(funnelSteps({}), null);
});
