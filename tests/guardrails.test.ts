/**
 * Guardrail tests: every rule here was a real mistake found in review. They run before each release
 * (npm run build:neon), so none of them can come back unnoticed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { backedByFacts, polish, safeEmailText } from "../src/lib/analytics/autopilot/writer";
import { measuredWorse } from "../src/lib/analytics/autopilot/engine";
import { earlyBucket } from "../src/lib/analytics/autopilot/results";
import { keepBestFresh } from "../src/lib/analytics/autopilot/backlinks";
import { isRisky } from "../src/lib/analytics/autopilot/claims";

const FACTS = [
  "Measured result, SEO titles: 4 compared with Google data, 1 moved up, 3 moved down, 0 about the same, average position change down 2.1, average clicks change down 4.0.",
  "Visitors from Google search, last 28 days: 812. Goal: 20000 a month.",
  "Google visitors: unknown (Search Console not connected).",
  "Pages that already earn the most Google clicks (90 days), the best ones to offer: https://shop.com/blogs/tips/how-to-sleep (12); https://shop.com/ (40)",
].join("\n");

test("evidence: exact copies from one fact line pass", () => {
  assert.ok(backedByFacts("Visitors from Google search, last 28 days: 812", FACTS));
  assert.ok(backedByFacts("1 moved up, 3 moved down.", FACTS));
  assert.ok(backedByFacts("Search Console not connected", FACTS));
  assert.ok(backedByFacts("https://shop.com/blogs/tips/how-to-sleep (12)", FACTS));
});

test("evidence: changed numbers, flipped words, paraphrase and fragments fail", () => {
  assert.equal(backedByFacts("3 moved up, 1 moved down", FACTS), false);
  assert.equal(backedByFacts("average position change up 2.1", FACTS), false);
  assert.equal(backedByFacts("last 28 days: 81", FACTS), false);
  assert.equal(backedByFacts("https://shop.com/blogs/tips/how-to-sleep (13)", FACTS), false);
  assert.equal(backedByFacts("experts say refreshing pages works best", FACTS), false);
  assert.equal(backedByFacts("Visitors: 812", FACTS), false);
  assert.equal(backedByFacts("", FACTS), false);
  assert.equal(backedByFacts(undefined, FACTS), false);
});

test("evidence: a quote can't be stitched across two fact lines", () => {
  assert.equal(backedByFacts("a month. Google visitors: unknown", FACTS), false);
});

test("measurement: a missing reading is never worse", () => {
  assert.deepEqual(measuredWorse(8, null, 0), { worse: false, droppedOut: false });
});

test("measurement: leaving the top 10 is worse only for a page that was in it", () => {
  assert.equal(measuredWorse(5, { position: null, clicks: null }, 0).worse, true);
  assert.equal(measuredWorse(15, { position: null, clicks: null }, 0).worse, false);
  assert.equal(measuredWorse(15, { position: null, clicks: null }, 0).droppedOut, true);
});

test("measurement: a fall of more than 3 places without more clicks is worse", () => {
  assert.equal(measuredWorse(5, { position: 9, clicks: 0 }, 0).worse, true);
  assert.equal(measuredWorse(5, { position: 8, clicks: 0 }, 0).worse, false);
  assert.equal(measuredWorse(5, { position: 9, clicks: 10 }, 2).worse, false);
  assert.equal(measuredWorse(5, { position: 9, clicks: null }, 2).worse, true);
  assert.equal(measuredWorse(12, { position: 6, clicks: 0 }, 0).worse, false);
});

test("early readings: each case lands in exactly one bucket", () => {
  assert.equal(earlyBucket(null, null), "still");
  assert.equal(earlyBucket(null, 7), "reached");
  assert.equal(earlyBucket(4, null), "dropped");
  assert.equal(earlyBucket(8, 5), "up");
  assert.equal(earlyBucket(5, 8), "down");
  assert.equal(earlyBucket(6, 6), "same");
});

test("backlink list: when full, the best kinds and strongest sites stay, in order", () => {
  const p = (kind: string, authority: number | null, id: string) => ({ kind, authority, id });
  const fresh = [p("competitor", 9, "a"), p("broken", 1, "b"), p("mention", null, "c"), p("competitor", 2, "d"), p("resource", 5, "e")];
  assert.deepEqual(keepBestFresh(fresh, 3).map((x) => x.id), ["b", "c", "e"]);
  assert.deepEqual(keepBestFresh(fresh, 10).map((x) => x.id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(keepBestFresh(fresh, 0), []);
});

const keep = ["Peremis", "peremis.com", "healthblog.org"];
const urls = ["https://healthblog.org/sleep-guide", "https://peremis.com/blogs/tips/how-to-sleep", "https://peremis.com", "https://peremis.com/"];

test("email filter: a clean email passes untouched", () => {
  const body = "Hi there,\nI read your sleep guide and found it clear.\nOur guide at https://peremis.com/blogs/tips/how-to-sleep covers bedtime routines.\nPeremis";
  const out = safeEmailText(body, keep, urls);
  assert.equal(out.dropped, 0);
  assert.ok(out.text.includes("https://peremis.com/blogs/tips/how-to-sleep"));
  assert.ok(out.text.endsWith("Peremis"));
});

test("email filter: a sentence with a number or a made up link is dropped", () => {
  const body = "Our guide helps 90 percent of readers sleep better. See https://made-up.example.com/page for more. Thanks for reading.";
  const out = safeEmailText(body, keep, urls);
  assert.equal(out.dropped, 2);
  assert.ok(!out.text.includes("90"));
  assert.ok(!out.text.includes("made-up"));
  assert.ok(out.text.includes("Thanks for reading."));
});

test("email filter: digits inside a brand or allowed link don't count as numbers", () => {
  const out = safeEmailText("Thanks from the team at 1millioncups.com.", ["1millioncups.com"], []);
  assert.equal(out.dropped, 0);
});

test("text: no hyphens or dashes reach the site", () => {
  const out = polish("A well-known tip — sleep early – and rest");
  assert.ok(!/[‐-―]/.test(out), out);
  assert.ok(!/\s-\s/.test(out), out);
});

test("claims: disease claims are caught", () => {
  assert.ok(isRisky("This supplement cures diabetes."));
  assert.equal(isRisky("Magnesium is a mineral found in leafy greens."), false);
});

import { scoreChanges, scoreProspects } from "../src/lib/analytics/autopilot/scorecard";

test("scorecard: groups fields into agents and reports measured effect", () => {
  const s = scoreChanges([
    { field: "meta_title", made: 3, suggested: 1, compared: 2, up: 1, down: 1, undone: 1, gainSum: -1 },
    { field: "content", made: 1, suggested: 0, compared: 0, up: 0, down: 0, undone: 0, gainSum: 0 },
    { field: "internal_link", made: 2, suggested: 0, compared: 0, up: 0, down: 0, undone: 0, gainSum: 0 },
  ]);
  const page = s.find((x) => x.agent === "Page improver")!;
  assert.equal(page.did, "4 changes made on the site, 1 suggested");
  assert.equal(page.result, "2 measured: 1 moved up, 1 moved down, average down 0.5 places, 1 undone for falling.");
  assert.equal(s.find((x) => x.agent === "Link builder")!.result, "Nothing measured yet (four weeks after each change).");
  assert.equal(s.find((x) => x.agent === "Article writer")!.result, null);
});

test("scorecard: backlink agents count found, emailed and won", () => {
  const s = scoreProspects([
    { kind: "broken", status: "won" },
    { kind: "broken", status: "new" },
    { kind: "mention", status: "contacted" },
    { kind: "competitor", status: "new" },
  ]);
  assert.equal(s[0].did, "2 backlink sites found");
  assert.equal(s[0].result, "1 emailed, 1 link won.");
  assert.equal(s[1].result, "1 emailed, 0 links won.");
  assert.equal(s[2].result, "None emailed yet.");
});
