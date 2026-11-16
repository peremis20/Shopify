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
  absoluteDate,
  addItem,
  autoDraftable,
  mergeItem,
  outletEmailOk,
  patchItem,
  releaseDraftSlot,
  setOwnerFields,
  takeDraftSlot,
  type Sql,
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

// ---------- review fixes ----------

/** A stand in for the database that records each statement and answers with the given rows. */
const recorder = (answer: (text: string) => Record<string, string | null>[] = () => []) => {
  const calls: { text: string; values: unknown[] }[] = [];
  const q: Sql = async (strings, ...values) => {
    const text = strings.join("$").replace(/\s+/g, " ");
    calls.push({ text, values });
    return answer(text);
  };
  return { q, calls };
};

test("press: a draft slot is taken in one conditional statement and given back when the draft fails", async () => {
  const ok = recorder(() => [{ account_id: "1" }]);
  const stamp = await takeDraftSlot("1", ok.q);
  assert.ok(stamp);
  assert.equal(ok.calls.length, 1); // one statement: no read, then write
  const t = ok.calls[0].text;
  assert.match(t, /INSERT INTO insights_press_drafts/);
  assert.match(t, /ON CONFLICT \(account_id\) DO UPDATE/);
  assert.match(t, /WHERE \(SELECT count\(\*\) FROM unnest\(insights_press_drafts\.drafts\).*< \$ AND \(SELECT count\(\*\) FROM unnest\(insights_press_drafts\.attempts\).*< \$ RETURNING/);
  assert.ok(ok.calls[0].values.includes(PITCH_WEEKLY_CAP) && ok.calls[0].values.includes(ATTEMPT_DAILY_CAP));
  // At the cap the statement returns nothing: no slot.
  const full = recorder(() => []);
  assert.equal(await takeDraftSlot("1", full.q), null);
  // Giving it back removes exactly that stamp from the week's drafts (the attempt still counts).
  const back = recorder();
  await releaseDraftSlot("1", stamp!, back.q);
  assert.match(back.calls[0].text, /SET drafts = array_remove\(drafts, \$::timestamptz\)/);
  assert.ok(back.calls[0].values.includes(stamp));
  assert.ok(!/attempts/.test(back.calls[0].text));
});

test("press: the owner's status and dismissals are never overwritten by the agents", async () => {
  // The owner's fields win when shown, and stored agent data can't carry them.
  const j = mergeItem<{ status: string; name: string; pitch?: unknown }>({ name: "Dana Whitfield", status: "new" }, { status: "pitched", statusAt: "2026-11-15" });
  assert.equal(j.status, "pitched");
  assert.equal(mergeItem<{ status: string }>({ name: "x" }, null).status, "new");
  assert.equal(mergeItem<{ name: string }>({ name: "x" }, { name: "evil" }).name, "x"); // only owner fields come from the owner
  // A new find never replaces a stored row, and never writes the owner's column.
  const add = recorder();
  await addItem("1", "journalist", "abc", { name: "Dana Whitfield", status: "new", dismissed: false }, add.q);
  assert.match(add.calls[0].text, /ON CONFLICT \(account_id, kind, item_id\) DO NOTHING/);
  assert.ok(!/owner/.test(add.calls[0].text));
  const stored = JSON.parse(String(add.calls[0].values.find((v) => typeof v === "string" && v.startsWith("{"))));
  assert.equal(stored.status, undefined);
  assert.equal(stored.dismissed, undefined);
  // An agent's update merges into the row in one statement, only into data, and only when no pitch landed first.
  const patch = recorder(() => [{ item_id: "abc" }]);
  assert.equal(await patchItem("1", "journalist", "abc", { pitch: { subject: "s" }, status: "new" }, "pitch", patch.q), true);
  assert.match(patch.calls[0].text, /SET data = data \|\| \$::jsonb/);
  assert.match(patch.calls[0].text, /data -> \$::text IS NULL/);
  assert.ok(!/owner/.test(patch.calls[0].text));
  assert.ok(!String(patch.calls[0].values[0]).includes("status"));
  const lost = recorder(() => []);
  assert.equal(await patchItem("1", "journalist", "abc", { pitch: {} }, "pitch", lost.q), false);
  // The owner's change merges into the owner column only, and only owner fields.
  const own = recorder();
  await setOwnerFields("1", "journalist", "abc", { status: "covered", pitch: "x" }, own.q);
  assert.match(own.calls[0].text, /SET owner = owner \|\| \$::jsonb/);
  assert.deepEqual(Object.keys(JSON.parse(String(own.calls[0].values[0]))), ["status"]);
});

test("press: the outlet's published email must be on the outlet's own domain, never another customer's", () => {
  const isOther = (d: string) => d === "othercustomer.com";
  assert.equal(outletEmailOk("tips@dailyhealth.example", "dailyhealth.example", isOther), true);
  assert.equal(outletEmailOk("news@mail.dailyhealth.example", "www.dailyhealth.example", isOther), true);
  assert.equal(outletEmailOk("someone@gmail.com", "dailyhealth.example", isOther), false);
  assert.equal(outletEmailOk("hello@othercustomer.com", "othercustomer.com", isOther), false);
  assert.equal(outletEmailOk("x@dailyhealth.example.evil.net", "dailyhealth.example", isOther), false);
  assert.equal(outletEmailOk(null, "dailyhealth.example", isOther), false);
  // An email elsewhere on the page (a newsroom footer) is not the author's.
  const page = `<p class="byline">By Dana Whitfield</p><footer><a href="mailto:newsroom@dailyhealth.example">Tips</a></footer>`;
  assert.equal(emailNearByline(page, "Dana Whitfield"), null);
  assert.equal(emailNearByline(`<a rel="author" href="mailto:dana@dailyhealth.example">Dana</a>`, "Dana Whitfield"), "dana@dailyhealth.example");
});

test("press: prices need placement words next to them; subscription prices are dropped", () => {
  assert.equal(statedPrice("Subscribe for $9 per month to read every issue."), null);
  assert.equal(statedPrice("Premium membership $49 a year. Advertise with us."), null);
  assert.equal(statedPrice("Our pricing starts from $99."), null);
  assert.equal(statedPrice("Newsletter ads: $300 per issue."), "$300 per issue");
  assert.equal(statedPrice("Sponsored placement in the show notes, $150."), "$150");
});

test("press: dates are absolute or left out, never relative", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  assert.equal(absoluteDate("3 days ago", now), "2026-11-13");
  assert.equal(absoluteDate("2 weeks ago", now), "2026-11-02");
  assert.equal(absoluteDate("1 hour ago", now), "2026-11-16");
  assert.equal(absoluteDate("a month ago", now), null);
  assert.equal(absoluteDate("Nov 2, 2026", now), "2026-11-02");
  assert.equal(absoluteDate("Nov 2", now), null);
  assert.equal(absoluteDate(null, now), null);
  // A journalist found without the page's own date gets the search's date as a day.
  const j = journalistFrom(news({ date: "5 days ago" }), `<p class="byline">By Dana Whitfield</p>`, "t", "shopco.com", nobody)!;
  assert.match(j.date ?? "", /^\d{4}-\d{2}-\d{2}$/);
  const k = journalistFrom(news({ date: "3 months ago" }), `<p class="byline">By Dana Whitfield</p>`, "t", "shopco.com", nobody)!;
  assert.equal(k.date, null);
});

test("press: a temporary note is retried next week; only a permanent one stops automatic drafts", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  const day = (n: number) => new Date(now - n * 864e5).toISOString();
  assert.equal(autoDraftable({ status: "new" }, now), true);
  assert.equal(autoDraftable({ status: "new", pitchNote: "No second AI", pitchNoteKind: "temporary", pitchNoteAt: day(2) }, now), false);
  assert.equal(autoDraftable({ status: "new", pitchNote: "No second AI", pitchNoteKind: "temporary", pitchNoteAt: day(8) }, now), true);
  assert.equal(autoDraftable({ status: "new", pitchNote: "Turned down", pitchNoteKind: "permanent", pitchNoteAt: day(30) }, now), false);
  assert.equal(autoDraftable({ status: "pitched" }, now), false);
});
