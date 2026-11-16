import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attemptRoom,
  ATTEMPT_DAILY_CAP,
  bylineOf,
  composePitch,
  contactPageOf,
  deadlineOf,
  draftRoom,
  emailNearByline,
  isPaidPlacement,
  isPersonName,
  journalistFrom,
  paidType,
  PAID_NOTE,
  pitchProblem,
  PITCH_WEEKLY_CAP,
  plainOutreachFailure,
  publishedOf,
  requestFrom,
  statedPrice,
} from "../src/lib/analytics/autopilot/press";
import { keepAsProspect } from "../src/lib/analytics/autopilot/backlinks";
import { runWeekly, type WeeklyDeps } from "../src/lib/analytics/autopilot/weekly-run";
import type { NewsResult } from "../src/lib/analytics/autopilot/serp";

const ARTICLE = `<html><head><title>Why sleep routines matter | Daily Health</title>
<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-11-02T09:00:00Z","author":{"@type":"Person","name":"Dana Whitfield"}}</script>
</head><body><article><p class="byline">By <a rel="author" href="/authors/dana-whitfield/">Dana Whitfield</a>
<a href="mailto:dana@dailyhealth.example">Email</a></p><p>Text about evening routines.</p></article></body></html>`;

const news = (over: Partial<NewsResult> = {}): NewsResult => ({
  title: "Why sleep routines matter",
  link: "https://dailyhealth.example/sleep/routines",
  domain: "dailyhealth.example",
  snippet: "",
  source: "Daily Health",
  date: "2 weeks ago",
  ...over,
});
const nobody = () => false;

test("press: names, contacts and outlets come only from the article page, never invented", () => {
  const j = journalistFrom(news(), ARTICLE, "sleep routines", "shopco.com", nobody)!;
  assert.equal(j.name, "Dana Whitfield");
  assert.equal(j.outlet, "Daily Health");
  assert.equal(j.date, "2026-11-02");
  assert.equal(j.contactPage, "https://dailyhealth.example/authors/dana-whitfield/");
  assert.equal(j.email, "dana@dailyhealth.example");
  assert.equal(j.emailIsOutlets, false);
  // No printed author: no journalist at all. A desk or the outlet is not a person.
  assert.equal(journalistFrom(news(), "<html><body><p>No byline here.</p></body></html>", "t", "shopco.com", nobody), null);
  assert.equal(bylineOf('<meta name="author" content="Staff Writer">'), null);
  assert.equal(bylineOf('<meta name="author" content="Daily Health">', "Daily Health"), null);
  assert.equal(isPersonName("dana@x.com"), false);
  assert.equal(isPersonName("Maria de la Cruz"), true);
  // No printed contact: none is made up.
  const bare = `<html><body><p class="byline">By Dana Whitfield</p></body></html>`;
  const k = journalistFrom(news(), bare, "t", "shopco.com", nobody)!;
  assert.equal(k.contactPage, null);
  assert.equal(k.email, null);
  assert.equal(contactPageOf('<a rel="author" href="https://other.example/authors/dana">Dana Whitfield</a>', "https://dailyhealth.example/x", "Dana Whitfield"), null);
  assert.equal(emailNearByline(`Dana Whitfield ${"x".repeat(700)} <a href="mailto:desk@dailyhealth.example">`, "Dana Whitfield"), null);
  assert.equal(publishedOf("<p>no date</p>"), null);
  // The pitch carries only the printed name and the business's own address.
  const pitch = composePitch("Dana Whitfield", "I read your piece on evening routines.", "ShopCo", "shopco.com");
  assert.match(pitch, /^Hi Dana,/);
  assert.ok(!/@/.test(pitch));
  assert.ok(pitch.endsWith("https://shopco.com"));
});

test("press: other customers' sites and the site itself are skipped", () => {
  const isOther = (d: string) => d.includes("dailyhealth.example");
  assert.equal(journalistFrom(news(), ARTICLE, "t", "shopco.com", isOther), null);
  assert.equal(journalistFrom(news({ link: "https://shopco.com/blog/x", domain: "shopco.com" }), ARTICLE, "t", "www.shopco.com", nobody), null);
  assert.equal(journalistFrom(news({ link: "https://www.facebook.com/x", domain: "facebook.com" }), ARTICLE, "t", "shopco.com", nobody), null);
  const r = { position: 1, title: "Journalist looking for sources on sleep routines", link: "https://www.qwoted.com/requests/1", domain: "qwoted.com", snippet: "Deadline: Nov 20. Seeking expert quotes." };
  assert.equal(requestFrom(r, "sleep", "shopco.com", (d) => d === "qwoted.com"), null);
  const ok = requestFrom(r, "sleep", "shopco.com", nobody)!;
  assert.equal(ok.platform, "Qwoted");
  assert.equal(ok.deadline, "Nov 20");
  // A page that isn't a request for sources isn't listed; a deadline only when shown.
  assert.equal(requestFrom({ ...r, title: "Sleep routines guide", snippet: "Our tips for better sleep." }, "sleep", "shopco.com", nobody), null);
  assert.equal(deadlineOf("Seeking expert quotes on sleep"), null);
});

test("press: the claim guard stops medical claims and unprovable promises in pitches", () => {
  assert.equal(pitchProblem("I'd be glad to share a quote on evening routines for your next story.", true), null);
  assert.match(pitchProblem("Our magnesium cures insomnia.", true)!, /stopped|curing/);
  assert.match(pitchProblem("A gentle way to treat anxiety at home.", true)!, /curing|claim/);
  assert.match(pitchProblem("It is clinically proven to help.", false)!, /claim/);
  assert.match(pitchProblem("Studies show it works.", false)!, /claim/);
});

test("press: at most five drafts a week and ten attempts a day", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  const day = (n: number) => new Date(now - n * 864e5).toISOString();
  assert.equal(PITCH_WEEKLY_CAP, 5);
  assert.equal(draftRoom([], now), 5);
  assert.equal(draftRoom([day(1), day(2), day(3), day(4), day(5)], now), 0);
  assert.equal(draftRoom([day(1), day(2), day(8), day(9)], now), 3); // older than a week don't count
  assert.equal(attemptRoom(Array.from({ length: ATTEMPT_DAILY_CAP }, () => day(0.1)), now), 0);
  assert.equal(attemptRoom([day(2)], now), ATTEMPT_DAILY_CAP);
});

test("press: paid placements never become backlink prospects", () => {
  const ad = { url: "https://sleepmag.example/advertise", title: "Advertise with us | Sleep Mag", snippet: "Reach our readers. Media kit and rates." };
  assert.equal(isPaidPlacement(ad.url, ad.title, ad.snippet), true);
  assert.equal(keepAsProspect(ad), false);
  assert.equal(keepAsProspect({ url: "https://x.example/newsletter", title: "Sponsor our newsletter", snippet: "" }), false);
  assert.equal(keepAsProspect({ url: "https://x.example/sponsored-posts", title: "Sponsored posts", snippet: "" }), false);
  assert.equal(keepAsProspect({ url: "https://x.example/sleep-resources", title: "Sleep resources", snippet: "Useful links for better sleep" }), true);
  assert.equal(paidType("Sponsor our weekly newsletter, 20k subscribers"), "newsletter");
  assert.equal(paidType("Podcast sponsorship, host read ads per episode"), "podcast");
  assert.match(PAID_NOTE, /rel="sponsored"/);
  assert.match(PAID_NOTE, /not backlinks/);
});

test("press: a price is shown only when the page states one", () => {
  assert.equal(statedPrice("Sponsor our newsletter. Contact us for rates."), null);
  assert.equal(statedPrice("Newsletter sponsorship: $450 per issue, booked monthly."), "$450 per issue");
  assert.equal(statedPrice("Podcast ad spots start at £1,200 per episode."), "£1,200 per episode");
  // A product price elsewhere on the page is not a placement price.
  assert.equal(statedPrice("Magnesium Glycinate $24.99 Add to bag"), null);
});

test("press: weekly runs save a provisional marker first and a real one on every exit", async () => {
  const make = (over: Partial<WeeklyDeps> = {}) => {
    const calls = { marks: [] as { note: string; days?: number }[], reports: [] as boolean[], work: 0 };
    const d: WeeklyDeps = {
      name: "Journalists",
      started: "started",
      sabbath: () => false,
      autopilotOn: async () => true,
      mark: async (note, days) => void calls.marks.push({ note, days }),
      report: (ok) => void calls.reports.push(ok),
      work: async () => (calls.work++, { note: "3 new journalists" }),
      plainFailure: plainOutreachFailure,
      ...over,
    };
    return { d, calls };
  };
  const ok = make();
  assert.equal(await runWeekly(ok.d), "3 new journalists");
  assert.deepEqual(ok.calls.marks.map((m) => [m.note, m.days]), [["started", 1], ["3 new journalists", undefined]]);
  assert.deepEqual(ok.calls.reports, [true]);
  // An error: marked in plain words, reported, never thrown.
  const bad = make({ work: async () => Promise.reject(new Error("socket hang up at TLSWrap")) });
  assert.equal(await runWeekly(bad.d), "The search hit a problem and tries again next week.");
  assert.equal(bad.calls.marks.at(-1)!.note, "The search hit a problem and tries again next week.");
  assert.deepEqual(bad.calls.reports, [false]);
  // A problem the Inspector must see.
  const prob = make({ work: async () => ({ note: "Journalists wait for a search key.", problem: "No search key (Serper) is set up." }) });
  await runWeekly(prob.d);
  assert.deepEqual(prob.calls.reports, [false]);
  // The Sabbath and the pause: no work, a marker, no report.
  const sab = make({ sabbath: () => true });
  await runWeekly(sab.d);
  assert.equal(sab.calls.work, 0);
  assert.deepEqual(sab.calls.marks.map((m) => m.days), [1]);
  assert.deepEqual(sab.calls.reports, []);
  const paused = make({ autopilotOn: async () => false });
  await runWeekly(paused.d);
  assert.equal(paused.calls.work, 0);
  assert.equal(paused.calls.marks.length, 1);
  assert.deepEqual(paused.calls.reports, []);
  // A marker that can't be saved never escapes.
  const noDb = make({ mark: async () => Promise.reject(new Error("db down")) });
  assert.equal(await runWeekly(noDb.d), "3 new journalists");
});
