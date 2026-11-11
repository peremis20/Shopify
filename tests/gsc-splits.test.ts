/**
 * Search Console splits: devices and rich results read as plain words,
 * sorted biggest first, with CTR as a percent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appearanceList, deviceSplit } from "../src/lib/analytics/gsc";

const row = (key: string, clicks: number, impressions: number, ctr = 0, position = 0) => ({
  keys: [key],
  clicks,
  impressions,
  ctr,
  position,
});

test("devices: plain names, most clicks first, CTR as a percent", () => {
  const out = deviceSplit([row("DESKTOP", 5, 100, 0.05, 7), row("MOBILE", 20, 400, 0.05, 9), row("TABLET", 0, 10)]);
  assert.deepEqual(out.map((d) => d.device), ["Mobile", "Desktop", "Tablet"]);
  assert.equal(out[0].ctr, 5);
  assert.equal(out[0].position, 9);
});

test("rich results: known types named, unknown ones made readable, most impressions first", () => {
  const out = appearanceList([row("REVIEW_SNIPPET", 3, 50), row("PRODUCT_SNIPPETS", 1, 200), row("SOME_NEW_TYPE", 0, 5)]);
  assert.deepEqual(out.map((a) => a.type), ["Product details", "Review stars", "Some new type"]);
  for (const a of out) assert.doesNotMatch(a.type, /[_-]/);
});

test("rows without a key are left out", () => {
  assert.deepEqual(deviceSplit([{ clicks: 1, impressions: 1, ctr: 0, position: 0 }]), []);
  assert.deepEqual(appearanceList([]), []);
});
