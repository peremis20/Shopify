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

import { compareWithControls } from "../src/lib/analytics/autopilot/results";
import { pickControl } from "../src/lib/analytics/autopilot/engine";

test("controls: the effect is the changed pages' move minus the untouched pages' move", () => {
  assert.equal(compareWithControls([]), null);
  assert.equal(
    compareWithControls([{ changed: 4, control: 1 }, { changed: 2, control: 3 }]),
    "Compared with similar untouched pages (2 pairs): changed pages moved up 3.0 places on average, untouched pages up 2.0, so the changes' own effect was up 1.0 places."
  );
});

test("controls: a similar page close in position is chosen; none when nothing is close or real", () => {
  const c = (page: string, query: string, position: number, inferred = false) =>
    ({ op: { page, query, position, impressions: 0, clicks: 0, ctr: 0, potentialClicks: 1 }, mode: "climb", weights: {}, inferred }) as never;
  const cand = c("/a", "a", 12);
  const all = [cand, c("/b", "b", 30), c("/c", "c", 14), c("/d", "d", 11.5, true), c("/a", "a2", 12), c("/e", "a", 12), c("/f", "f", 25)];
  assert.equal((pickControl(cand, all, () => false) as { op: { page: string } }).op.page, "/c");
  assert.equal(pickControl(cand, all, (x: { op: { page: string } }) => x.op.page === "/c"), null);
  assert.equal(pickControl(c("/z", "z", 25), all, () => false), null);
  assert.equal(pickControl(c("/z", "z", 12, true), all, () => false), null);
});

test("text: number ranges read as ranges, not lists", () => {
  assert.equal(polish("Most people notice it in 2–3 weeks"), "Most people notice it in 2 to 3 weeks");
  assert.equal(polish("ages 4 - 8"), "ages 4 to 8");
  assert.equal(polish("<li>— a tip</li>"), "<li>a tip</li>");
  assert.equal(polish("Calm — and rested"), "Calm, and rested");
});

test("controls: pairs left out are said, never hidden", () => {
  assert.match(compareWithControls([{ changed: 1, control: 1 }], 2)!, /2 more pairs were left out/);
});

test("text: hyphens inside numbers (phone, date, B-12) are left alone", () => {
  assert.equal(polish("Call 555-1234 on 2026-11-01 about B-12"), "Call 555-1234 on 2026-11-01 about B-12");
});

test("text: a dash after a bold label becomes a comma, never joins words", () => {
  assert.equal(polish("<p><strong>Tip</strong> — drink water</p>"), "<p><strong>Tip</strong>, drink water</p>");
  assert.equal(polish("<em>Note</em> – read"), "<em>Note</em>, read");
  assert.equal(polish("<p>Done —</p>"), "<p>Done</p>");
});

test("text: a dash before an inline tag keeps the words apart", () => {
  assert.equal(polish("<p>Calm — <em>rested</em></p>"), "<p>Calm, <em>rested</em></p>");
});

import { activeUpdate, parseUpdates } from "../src/lib/analytics/autopilot/google-updates";

test("google updates: only ranking updates count, Discover doesn't", () => {
  const u = parseUpdates([
    { external_desc: "May 2026 core update", begin: "2026-05-21T15:40:00+00:00", end: "2026-06-02T12:40:00+00:00", service_name: "Ranking" },
    { external_desc: "February 2026 Discover update", begin: "2026-02-05T17:00:00+00:00", end: "2026-02-27T10:00:00+00:00", service_name: "Ranking" },
    { external_desc: "Serving was experiencing an issue", begin: "2026-02-25T03:55:00+00:00", end: "2026-02-25T04:10:00+00:00", service_name: "Serving" },
  ]);
  assert.deepEqual(u.map((x) => x.name), ["May 2026 core update"]);
});

test("google updates: verdicts wait while rolling out and for two weeks after", () => {
  const u = [{ name: "May 2026 core update", begin: "2026-05-21T15:40:00Z", end: "2026-06-02T12:40:00Z" }];
  assert.equal(activeUpdate(u, new Date("2026-05-20T00:00:00Z")), null);
  assert.equal(activeUpdate(u, new Date("2026-05-25T00:00:00Z"))?.settling, false);
  assert.equal(activeUpdate(u, new Date("2026-06-10T00:00:00Z"))?.settling, true);
  assert.equal(activeUpdate(u, new Date("2026-06-20T00:00:00Z")), null);
  assert.equal(activeUpdate([{ name: "x", begin: "2026-05-21T00:00:00Z", end: null }], new Date("2026-07-01T00:00:00Z"))?.settling, false);
});

import { updatesDuring } from "../src/lib/analytics/autopilot/google-updates";

test("google updates: a measurement window overlapping a rollout or its settling time is flagged", () => {
  const u = [{ name: "May 2026 core update", begin: "2026-05-21T00:00:00Z", end: "2026-06-02T00:00:00Z" }];
  const w = (a: string, b: string) => updatesDuring(u, new Date(a), new Date(b)).length;
  assert.equal(w("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z"), 0);
  assert.equal(w("2026-05-01T00:00:00Z", "2026-05-30T00:00:00Z"), 1);
  assert.equal(w("2026-06-10T00:00:00Z", "2026-07-08T00:00:00Z"), 1); // still settling on June 10
  assert.equal(w("2026-06-20T00:00:00Z", "2026-07-18T00:00:00Z"), 0);
});

import { relativeFall } from "../src/lib/analytics/autopilot/engine";
import { EMAIL_WORTHY } from "../src/lib/analytics/autopilot/alerts";
import { reviewedByline, withByline } from "../src/lib/analytics/autopilot/expert-review";

test("google updates: spam updates don't blind the measurement, core updates do", () => {
  const u = [
    { name: "September 2026 spam update", begin: "2026-09-24T00:00:00Z", end: "2026-10-08T00:00:00Z" },
    { name: "May 2026 core update", begin: "2026-05-21T00:00:00Z", end: "2026-06-02T00:00:00Z" },
  ];
  assert.equal(updatesDuring(u, new Date("2026-09-20T00:00:00Z"), new Date("2026-10-20T00:00:00Z")).length, 0);
  assert.equal(updatesDuring(u, new Date("2026-05-01T00:00:00Z"), new Date("2026-05-30T00:00:00Z")).length, 1);
});

test("controls: during a core update a change is judged against its control", () => {
  assert.equal(relativeFall(5, 12, 6, 11), 2); // fell 7, control fell 5: only 2 more
  assert.equal(relativeFall(5, 12, 6, 6), 7); // the control held: the change fell 7 more
  assert.equal(relativeFall(8, 5, 8, 9), -4); // it rose while the control fell
});

test("emails: only problems worth an inbox go out", () => {
  assert.ok(EMAIL_WORTHY.test("traffic:drop"));
  assert.ok(EMAIL_WORTHY.test("autopilot:stalled"));
  assert.equal(EMAIL_WORTHY.test("google:recrawl"), false);
  assert.equal(EMAIL_WORTHY.test("limit:ai"), false);
  assert.equal(EMAIL_WORTHY.test("autopilot:idle"), false);
});

test("expert review: the byline is escaped, dated and replaced, never stacked", () => {
  const r = { name: "Dr <Jane> Doe", credentials: "MD", url: "https://example.org/jane" };
  const b = reviewedByline(r, new Date("2026-11-01T12:00:00Z"));
  assert.ok(b.includes("Dr &lt;Jane&gt; Doe"));
  assert.ok(b.includes("November 1, 2026"));
  const once = withByline("<p>Body</p>", b);
  const twice = withByline(once, reviewedByline({ ...r, credentials: "MD, MPH" }, new Date("2026-12-01T12:00:00Z")));
  assert.equal((twice.match(/<!-- dashpatrol:reviewed -->/g) ?? []).length, 1);
  assert.ok(twice.includes("MD, MPH") && !twice.includes("November 1"));
  assert.ok(twice.endsWith("<p>Body</p>"));
});

import { withoutByline } from "../src/lib/analytics/autopilot/expert-review";

test("expert review: the byline comes off cleanly when the article changes", () => {
  const b = reviewedByline({ name: "Jane Doe", credentials: "RD", url: null }, new Date("2026-11-01T00:00:00Z"));
  assert.equal(withoutByline(withByline("<p>Body</p>", b)), "<p>Body</p>");
  assert.equal(withoutByline("<p>Body</p>"), "<p>Body</p>");
});

import { gscReading } from "../src/lib/analytics/autopilot/engine";

test("search console: an empty summary row is no data, never position 0", () => {
  assert.equal(gscReading({ position: 0, clicks: 0, impressions: 0 }), null);
  assert.equal(gscReading(undefined), null);
  assert.deepEqual(gscReading({ position: 7.2, clicks: 3, impressions: 40 }), { position: 7.2, clicks: 3, impressions: 40 });
});

// ---------- the outside watcher's heartbeat ----------
import { judgeHeartbeat } from "../src/lib/analytics/autopilot/heartbeat";

test("heartbeat: a recent finished run is healthy, a missing or stuck or failing one is not", () => {
  // A Monday afternoon in Texas, far from the Sabbath.
  const now = new Date("2026-11-02T20:00:00Z");
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const base = { startedAt: ago(0.5), finishedAt: ago(0.4), ok: true, error: null, sabbath: false, failures: 0 };
  assert.equal(judgeHeartbeat(base, now).ok, true);
  assert.equal(judgeHeartbeat(null, now).ok, false);
  assert.equal(judgeHeartbeat({ ...base, startedAt: ago(3) }, now).ok, false);
  // One skipped run: no alarm in the seconds before the next one starts.
  assert.equal(judgeHeartbeat({ ...base, startedAt: ago(2.01) }, now).ok, true);
  // Error details never reach the public text.
  assert.ok(!judgeHeartbeat({ ...base, failures: 3, ok: false, error: "secret detail" }, now).text.includes("secret"));
  assert.equal(judgeHeartbeat({ ...base, startedAt: ago(1.5), finishedAt: null }, now).ok, false);
  assert.equal(judgeHeartbeat({ ...base, startedAt: ago(0.2), finishedAt: null }, now).ok, true);
  assert.equal(judgeHeartbeat({ ...base, failures: 1, ok: false }, now).ok, true);
  assert.equal(judgeHeartbeat({ ...base, failures: 2, ok: false, error: "boom" }, now).ok, false);
});

test("heartbeat: quiet is expected during the Sabbath and just after it", () => {
  // Saturday noon in Texas, and Saturday about an hour after sundown.
  assert.equal(judgeHeartbeat(null, new Date("2026-11-07T18:00:00Z")).ok, true);
  assert.equal(judgeHeartbeat(null, new Date("2026-11-08T00:30:00Z")).ok, true);
  // Sunday afternoon: quiet is a problem again.
  assert.equal(judgeHeartbeat(null, new Date("2026-11-08T20:00:00Z")).ok, false);
});
