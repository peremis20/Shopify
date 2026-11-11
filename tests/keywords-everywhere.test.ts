/**
 * Keywords Everywhere answers read as plain data: keyword volumes with a trend in month order
 * (never guessed when missing), and ranked keywords sorted by traffic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordDataRows, rankedKeywords } from "../src/lib/analytics/autopilot/keywords-everywhere";

test("keyword data: volume, CPC, competition and a trend in month order", () => {
  const [d] = keywordDataRows([
    {
      keyword: "Keywords Tool",
      vol: 390,
      cpc: { currency: "$", value: "5.51" },
      competition: 0.33,
      trend: [
        { month: "January", year: 2020, value: 390 },
        { month: "December", year: 2019, value: 480 },
      ],
    },
  ]);
  assert.deepEqual(d, {
    keyword: "keywords tool",
    monthlySearches: 390,
    cpc: 5.51,
    competition: 0.33,
    trend: [
      { month: "2019-12", searches: 480 },
      { month: "2020-01", searches: 390 },
    ],
  });
});

test("keyword data: a missing trend stays empty and bad rows are dropped", () => {
  const out = keywordDataRows([{ keyword: "x y", vol: 0, cpc: { value: "0.00" }, competition: 0, trend: [] }, { vol: 5 }, "junk"]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].trend, []);
});

test("ranked keywords: lower case, most traffic first", () => {
  const out = rankedKeywords([
    { keyword: "B", estimated_monthly_traffic: 5, serp_position: 3 },
    { keyword: "A", estimated_monthly_traffic: 50, serp_position: 9 },
    { keyword: "" },
  ]);
  assert.deepEqual(out, [
    { keyword: "a", traffic: 50, position: 9 },
    { keyword: "b", traffic: 5, position: 3 },
  ]);
});
