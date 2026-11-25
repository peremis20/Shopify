import { test } from "node:test";
import assert from "node:assert/strict";
import { withinReach } from "../src/lib/analytics/autopilot/strategist";
import { ownerText, retryNote } from "../src/lib/analytics/autopilot/writer";

test("plan text: no hyphens or dashes between words reach the owner", () => {
  assert.equal(ownerText("Lift pages in positions 4‑20 with a benefit‑focused headline"), "Lift pages in positions 4 to 20 with a benefit focused headline");
  assert.equal(ownerText("Third-party tested — and clean"), "Third party tested, and clean");
  assert.equal(ownerText("A 30-day supply, 5-star"), "A 30 day supply, 5 star");
});

test("plan text: addresses, paths, quotes, dates and names keep their hyphens", () => {
  const s = 'Rewrite /products/magnesium-glycinate for "vitamin-d gummies", pitch well-being-mag.com and https://a-b.com/x-y since 2026-11-20 (omega-3, B-12, COVID-19)';
  assert.equal(ownerText(s), s);
});

test("reach: easy searches first, bigger ones as the site grows", () => {
  // A site with 18 visitors a month: a 368,000 search waits, a 900 one doesn't.
  assert.equal(withinReach(368000, null, 18), false);
  assert.equal(withinReach(900, null, 18), true);
  // Site size unknown: nothing is held back on a guess.
  assert.equal(withinReach(5000, 62, null), true);
  // Hard searches wait while the site is small, and open up once it has real visitors.
  assert.equal(withinReach(500, 62, 15), false);
  assert.equal(withinReach(500, 62, 3000), true);
  // A bigger site may aim higher.
  assert.equal(withinReach(40000, 30, 5000), true);
  assert.equal(withinReach(null, null, 0), true);
});

test("retry note: tells the planner what was turned down and why", () => {
  assert.equal(retryNote([]), "");
  const note = retryNote([
    { kind: "target", keyword: "trivia questions", action: "Write a trivia guide.", challenge: "Off topic for an SEO site." },
    { kind: "outreach", keyword: null, page: "ringcentral.com", action: "Email them.", challenge: "The guide doesn't exist." },
  ]);
  assert.match(note, /turned down/);
  assert.match(note, /\[target\] Write a trivia guide\. \(trivia questions\): Off topic/);
  assert.match(note, /\(ringcentral\.com\): The guide doesn't exist/);
});
