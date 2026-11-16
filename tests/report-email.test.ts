import { test } from "node:test";
import assert from "node:assert/strict";
import { chartFromUrl, chartUrl, donutPng, weeklyReportHtml } from "../src/lib/analytics/autopilot/report-email";

process.env.SESSION_SECRET ||= "test-secret";
const ch = (name: string, now: number, before: number) => ({ name, now: { sessions: now, keyEvents: 0, purchases: 0, revenue: 0 }, before: { sessions: before, keyEvents: 0, purchases: 0, revenue: 0 } });
const base = { week: { changes: 2, articles: 1, links: 0, suggested: 1 }, visitors: null, focus: null, plan: [], backlinks: null, shopify: null } as const;

test("report chart: a valid PNG, only for a link the app signed", () => {
  const png = donutPng([120, 3, 2], ["#2a78d6", "#eb6834", "#1baf7a"], 60);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const url = new URL(chartUrl("https://app.example.com", [120, 3, 2], ["#2a78d6", "#eb6834", "#1baf7a"]));
  assert.ok(chartFromUrl(url.searchParams.get("d"), url.searchParams.get("s")));
  // Changed numbers or a made up signature draw nothing.
  const forged = Buffer.from(JSON.stringify({ v: [1, 1, 1], c: ["#2a78d6", "#eb6834", "#1baf7a"] })).toString("base64url");
  assert.equal(chartFromUrl(forged, url.searchParams.get("s")), null);
  assert.equal(chartFromUrl(url.searchParams.get("d"), "x".repeat(32)), null);
  assert.equal(chartFromUrl(null, null), null);
});

test("report email: tiles, a named legend, no scripts, and site text is escaped", () => {
  const html = weeklyReportHtml(
    { ...base, traffic: [ch("Direct", 120, 40), ch("Organic Search", 3, 9)], totals: { visits: 123, leads: 0, revenue: 0 }, agents: [{ agent: "Inspector", did: "1 problem <b>found</b>", result: null }] } as never,
    { site: "Shekinah <script>", origin: "https://app.example.com", usage: { ai: 5, search: 0, limits: { ai: 3000, search: 1500 } }, needsYou: 0 },
  );
  assert.match(html, /Visits, last 7 days/);
  assert.match(html, /up 151% from last week/);
  assert.match(html, /Direct<\/td>/);
  assert.match(html, /Organic Search<\/td>/);
  assert.match(html, /All agents are working/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<b>found/);
  assert.match(html, /\/api\/report\/chart\.png\?d=/);
});

test("report email: without Google Analytics it says so instead of showing zeros", () => {
  const html = weeklyReportHtml({ ...base, traffic: "none", totals: null, agents: [] } as never, { site: "x", origin: "https://a", usage: null, needsYou: null });
  assert.match(html, /Connect Google Analytics/);
  assert.doesNotMatch(html, /Visits, last 7 days/);
});

test("report email: the chart and the tile add up when there are more channels than colors", () => {
  const traffic = ["A", "B", "C", "D", "E", "F"].map((n) => ch(n, 100, 100));
  const html = weeklyReportHtml(
    { ...base, traffic, totals: { visits: 900, leads: 0, revenue: 0 }, totalsBefore: { visits: 600, leads: 0, revenue: 0 }, agents: [] } as never,
    { site: "x", origin: "https://a", usage: null, needsYou: null },
  );
  assert.match(html, /up 50% from last week/);
  assert.match(html, /Other<\/td>[\s\S]*?400 \(44%\)/);
});

test("report email: the sales tile uses the store's own Shopify orders, with free samples named apart", async () => {
  const { weeklyReportHtml } = await import("../src/lib/analytics/autopilot/report-email");
  const shopify = { days: 28, orders: 13, revenue: 206.15, currency: "USD", fromGoogle: 0, fromGoogleRevenue: 0, pages: [], week: { orders: 5, revenue: 80.5, free: 2 }, weekBefore: { orders: 2, revenue: 40.25, free: 0 } };
  const traffic = [{ name: "Organic Search", now: { sessions: 10, keyEvents: 1, purchases: 0, revenue: 0 }, before: { sessions: 8, keyEvents: 1, purchases: 0, revenue: 0 } }];
  const html = weeklyReportHtml({ ...base, shopify, traffic, agents: [], totals: { visits: 10, leads: 1, revenue: 0 } } as never, { site: "shop.com", origin: "https://app.example", usage: null, needsYou: 0 } as never);
  assert.ok(html.includes("Sales from Shopify"));
  assert.ok(html.includes("$80.50"));
  assert.ok(html.includes("3 paid orders, 2 free samples"));
  assert.ok(html.includes("Up 100% from last week"));
});
