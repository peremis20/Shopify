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

import { OFF_PAGE_ONE, ownerChangedSeo } from "../src/lib/analytics/autopilot/engine";
import { WixUnpublishedDraft } from "../src/lib/analytics/autopilot/wix";

test("measuring: a search that wasn't ranked before is judged on clicks, never on position alone", () => {
  // 25 is the "off page one" marker, not a real position: 32 isn't a fall from it.
  assert.equal(measuredWorse(OFF_PAGE_ONE, { position: 32, clicks: 0 }, 0).worse, false);
  assert.equal(measuredWorse(OFF_PAGE_ONE, { position: 32, clicks: null }, 3).worse, false);
  assert.equal(measuredWorse(OFF_PAGE_ONE, { position: null, clicks: null }, 0).worse, false);
  assert.equal(measuredWorse(null, { position: 40, clicks: 0 }, 0).worse, false);
  // Clicks that really fell still count.
  assert.equal(measuredWorse(OFF_PAGE_ONE, { position: 30, clicks: 1 }, 5).worse, true);
  // A real baseline is still judged on position.
  assert.equal(measuredWorse(20, { position: 24, clicks: 0 }, 0).worse, true);
});

test("undo: a title the owner changed since is left as the owner made it", () => {
  assert.equal(ownerChangedSeo("Best Magnesium for Sleep | Shop", "Best Magnesium for Sleep | Shop"), false);
  assert.equal(ownerChangedSeo("  Best Magnesium for Sleep  |  Shop ", "Best Magnesium for Sleep | Shop"), false);
  assert.equal(ownerChangedSeo("Magnesium Guide by Our Team", "Best Magnesium for Sleep | Shop"), true);
  assert.equal(ownerChangedSeo(null, "Best Magnesium for Sleep | Shop"), true);
});

test("wix: a post with the owner's unpublished edits is skipped, never published", () => {
  const e = new WixUnpublishedDraft();
  assert.equal(e.name, "UnpublishedDraft");
  assert.ok(!/[-–—]/.test(e.message));
});

import { assertPublicUrl, bareDomain, privateIp, publicHost, publicUrlShape } from "../src/lib/analytics/profile";
import { googleLinkTicket, LINK_FINISH_MS, readLinkTicket } from "../src/lib/analytics/embedded";
import { publicError, wpConfirmToken, wpConfirmValid } from "../src/lib/analytics/handlers";

test("public addresses only: local, private, metadata and raw IP addresses are never fetched", async () => {
  for (const h of ["localhost", "127.0.0.1", "10.0.0.5", "169.254.169.254", "metadata.google.internal", "metadata.goog", "printer.local", "db.corp", "[::1]", "0x7f000001", "intranet"]) {
    assert.equal(publicHost(h), false, h);
  }
  for (const h of ["shop.com", "www.my-store.co.uk", "metadata.io"]) assert.equal(publicHost(h), true, h);
  assert.equal(privateIp("192.168.1.1"), true);
  assert.equal(privateIp("::ffff:127.0.0.1"), true);
  assert.equal(privateIp("8.8.8.8"), false);
  assert.equal(bareDomain("http://127.0.0.1/admin"), null);
  assert.equal(bareDomain("169.254.169.254"), null);
  assert.equal(bareDomain("https://www.Shop.com/x"), "shop.com");
  assert.equal(publicUrlShape("https://shop.com/"), true);
  for (const u of ["file:///etc/passwd", "gopher://shop.com/", "http://shop.com:6379/", "http://user:pw@shop.com/", "http://10.1.2.3/", "not a url"]) {
    assert.equal(publicUrlShape(u), false, u);
  }
  await assert.rejects(assertPublicUrl("http://169.254.169.254/latest/meta-data/"));
  await assert.rejects(assertPublicUrl("http://localhost:3000/"));
});

test("Google link tickets: signed, short to open, and carry who made them", () => {
  process.env.SESSION_SECRET ??= "test secret";
  const t = googleLinkTicket("42", "https://app/x", true);
  const read = readLinkTicket(t);
  assert.equal(read?.accountId, "42");
  assert.equal(read?.session, true);
  assert.ok(read?.nonce);
  assert.notEqual(readLinkTicket(googleLinkTicket("42", "")!)?.nonce, read?.nonce);
  // Tampered: refused.
  const [p, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), a: "7" })).toString("base64url");
  assert.equal(readLinkTicket(`${forged}.${sig}`), null);
  // Old: can't be opened any more, but the Google callback may still finish within the grace time.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 10 * 60_000;
    assert.equal(readLinkTicket(t), null);
    assert.equal(readLinkTicket(t, LINK_FINISH_MS)?.accountId, "42");
  } finally {
    Date.now = realNow;
  }
});

test("WordPress connect: the confirm token works only for the same account, site and key", () => {
  process.env.SESSION_SECRET ??= "test secret";
  const tok = wpConfirmToken("1", "https://a.com/", "k");
  assert.equal(wpConfirmValid(tok, "1", "https://a.com/", "k"), true);
  assert.equal(wpConfirmValid(tok, "2", "https://a.com/", "k"), false);
  assert.equal(wpConfirmValid(tok, "1", "https://evil.com/", "k"), false);
  assert.equal(wpConfirmValid(tok, "1", "https://a.com/", "other"), false);
  assert.equal(wpConfirmValid(null, "1", "https://a.com/", "k"), false);
  assert.equal(wpConfirmValid(tok, "1", "https://a.com/", "k", Date.now() + 16 * 60_000), false);
});

test("errors: database and system details never reach the browser", () => {
  const db = Object.assign(new Error('relation "insights_accounts" does not exist'), { code: "42P01" });
  const err = console.error;
  console.error = () => undefined;
  try {
    assert.ok(!publicError(db).includes("insights_accounts"));
    assert.ok(!publicError(new TypeError("fetch failed: ECONNREFUSED 10.0.0.1")).includes("10.0.0.1"));
  } finally {
    console.error = err;
  }
  assert.equal(publicError(new Error("Connect your website by its address first.")), "Connect your website by its address first.");
});

// ---------- guardrail review fixes ----------
import { blocksOf, dropBlocks, numbersKnown, onlyKnownNumbers, reviewerOf, NO_SECOND_AI } from "../src/lib/analytics/autopilot/writer";
import { junkReason } from "../src/lib/analytics/autopilot/keyword-guard";

test("headings: a failing heading is checked and takes its section with it", () => {
  const html = "<h2>Cures cancer fast</h2><p>Bad part.</p><h3>Inner</h3><p>Also gone.</p><h2>Good</h2><p>Kept.</p>";
  const out = dropBlocks(html, (t) => isRisky(t), true);
  assert.equal(out, "<h2>Good</h2><p>Kept.</p>");
  assert.deepEqual(blocksOf(html, true).length, 6);
  assert.deepEqual(blocksOf(html).length, 3);
  // Without headings, paragraphs only, as before.
  assert.equal(dropBlocks("<h2>Cures cancer</h2><p>Fine.</p>", (t) => isRisky(t)), "<h2>Cures cancer</h2><p>Fine.</p>");
  assert.equal(onlyKnownNumbers("<h2>Take 500 mg</h2><p>Plain.</p><h2>Other</h2><p>Kept.</p>", "<p>Each bottle has 60 capsules.</p>"), "<h2>Other</h2><p>Kept.</p>");
});

test("claims: only a real negation near the claim excuses it", () => {
  assert.ok(isRisky("It cures anxiety disorders alongside a healthy diet."));
  assert.ok(isRisky("It prevents colds no matter the season."));
  assert.ok(isRisky("Doctor recommended formula."));
  assert.ok(isRisky("Our tea is not a drug, it treats arthritis."));
  assert.ok(isRisky("It not only treats colds but the flu."));
  assert.equal(isRisky("This tea does not cure colds."), false);
  assert.equal(isRisky("No product cures cancer."), false); // the first word of the text counts
  assert.equal(isRisky("Never stop taking your medication."), false);
});

test("claims: relieves, eases and drug alternatives are caught; managing and referrals are fine", () => {
  assert.ok(isRisky("It relieves arthritis pain."));
  assert.ok(isRisky("Eases migraines in minutes."));
  assert.equal(isRisky("Tips for managing type 2 diabetes with food."), false);
  assert.equal(isRisky("Talk to your doctor before you stop taking your medication."), false);
  assert.ok(isRisky("This cures diabetes, talk to your doctor."));
  assert.ok(isRisky("Ask your doctor: this supplement treats arthritis."));
  assert.ok(isRisky("A natural alternative to ibuprofen."));
});

test("numbers: a number counts only with the same unit, spelled out ones too, scripts ignored", () => {
  const page = "<p>Each bottle holds 50 capsules. Ships in 2 to 3 days.</p><script>var off = 30;</script>";
  assert.equal(numbersKnown("Cuts stress by 50%.", page), false);
  assert.ok(numbersKnown("A bottle of 50 capsules.", page));
  assert.ok(numbersKnown("It ships in 3 days.", page));
  assert.equal(numbersKnown("Save 30 today.", page), false);
  assert.equal(numbersKnown("Take two capsules a day.", page), false);
  assert.equal(numbersKnown("Results in fifty percent less time.", page), false);
  assert.ok(numbersKnown("Lasts about fifty capsules.", page));
  assert.ok(numbersKnown("Vitamin B12 helps.", "<p>With vitamin B12 for energy.</p>"));
  assert.ok(numbersKnown("Top tips for one of the best routines.", ""));
  assert.ok(numbersKnown("Step 1: 3 ways to start.", ""));
  assert.ok(numbersKnown("Take 500 mg.", "<p>Each serving has 500 milligrams.</p>"));
  assert.ok(numbersKnown("Take 2 daily.", "<p>Take 2 capsules daily.</p>"));
  assert.equal(numbersKnown("Take 4 daily.", "<p>Take 2 capsules daily.</p>"), false);
  assert.equal(numbersKnown("Take 3 a day.", "<p>Take 2 capsules daily.</p>"), false);
});

test("network guard: WordPress.com hosts are public, private ranges are not", () => {
  assert.equal(privateIp("192.0.78.9"), false);
  assert.ok(privateIp("192.0.2.1"));
  assert.ok(privateIp("10.0.0.1"));
});

test("evidence: a short fragment without a number fails", () => {
  assert.equal(backedByFacts("searches tracked", "Searches tracked: 40."), false);
  assert.ok(backedByFacts("Searches tracked: 40", "Searches tracked: 40."));
});

test("reviewers: never the writer's own service; with no other one the work waits", () => {
  const claude = { kind: "claude" as const, key: "a" };
  const gemini = { kind: "gemini" as const, key: "b" };
  assert.throws(() => reviewerOf(claude), { message: NO_SECOND_AI });
  const r = reviewerOf({ ...claude, backups: [gemini] });
  assert.equal(r.kind, "gemini");
  assert.ok(!(r.backups ?? []).some((b) => b.kind === "claude"));
});

test("keywords: niche neutral local and character rules", () => {
  assert.equal(junkReason("how many hours of sleep"), null);
  assert.equal(junkReason("café au lait recipe"), null);
  assert.equal(junkReason("pharmacy opening hours"), "local search");
  assert.equal(junkReason("best tea ☕"), "odd characters");
});

test("text: day and number ranges read with to, letter and number names stay joined", () => {
  assert.equal(polish("Open Mon–Fri"), "Open Mon to Fri");
  assert.equal(polish("Open Monday – Friday"), "Open Monday to Friday");
  assert.equal(polish("Vitamin B–12"), "Vitamin B12");
  assert.equal(polish("9am–5pm"), "9am to 5pm");
});

test("email filter: spaced hyphens become commas and made up bare domains drop their sentence", () => {
  const out = safeEmailText("Hi there - I read your guide. See healthtips.com for more. Our page is at peremis.com/blogs too.", keep, urls);
  assert.ok(!/\s-\s/.test(out.text), out.text);
  assert.ok(!out.text.includes("healthtips.com"));
  assert.equal(out.dropped, 1);
});

import { articleFromLog } from "../src/lib/analytics/autopilot/share-kit";

test("share kit: reads the article title and text from the logged change, without the SEO line", () => {
  const logged = `<h1>Magnesium threonate benefits</h1>\n<p><strong>SEO title:</strong> Magnesium Threonate | Peremis<br><strong>Meta description:</strong> What it is.</p>\n<h2>What it is</h2><p>A form of magnesium.</p>`;
  const a = articleFromLog(logged);
  assert.equal(a.title, "Magnesium threonate benefits");
  assert.ok(!a.text.includes("SEO title"));
  assert.ok(a.text.includes("A form of magnesium."));
});

import { asSearch } from "../src/lib/analytics/autopilot/idea-finder";

test("idea finder: a People also ask question becomes a plain search", () => {
  assert.equal(asSearch("What is magnesium threonate good for?"), "what is magnesium threonate good for");
  assert.equal(asSearch("  Best  sleep aids (natural)! "), "best sleep aids natural");
});
