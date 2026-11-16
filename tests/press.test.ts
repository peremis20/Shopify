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
  const j = mergeItem<{ status: string; name: string; pitch?: unknown }>({ name: "Dana Whitfield", status: "new" }, { status: "emailed", statusAt: "2026-11-15" });
  assert.equal(j.status, "emailed");
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
  assert.match(patch.calls[0].text, /data ->> \$::text IS NULL/);
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
  assert.equal(autoDraftable({ status: "emailed" }, now), false);
});

// ---------- the journalist CRM ----------

import { emailedPatch, followUpDue, journalistsCsv, mailtoFor, manualJournalist, ownerPatch, statusPatch } from "../src/lib/analytics/autopilot/press-crm";
import { jobTitleOf, printedPhone, productTopics, takeFindNow } from "../src/lib/analytics/autopilot/press";

test("crm: the job title comes only from the page itself", () => {
  const ld = `<script type="application/ld+json">{"@type":"NewsArticle","author":{"@type":"Person","name":"Dana Whitfield","jobTitle":"Senior Health Reporter"}}</script>`;
  assert.equal(jobTitleOf(ld, "Dana Whitfield"), "Senior Health Reporter");
  // Another person's title in the structured data is not theirs.
  assert.equal(jobTitleOf(ld, "Sam Ortiz"), null);
  assert.equal(jobTitleOf(`<p class="byline">By Dana Whitfield <span class="author-title">Features Editor</span></p>`, "Dana Whitfield"), "Features Editor");
  // Their author page on the outlet (a Person page).
  assert.equal(jobTitleOf(`<script type="application/ld+json">[{"@type":"Person","name":"Dana Whitfield","jobTitle":"Staff Writer"}]</script>`, "Dana Whitfield"), "Staff Writer");
  // Nothing printed: blank, never guessed from the article's words or the outlet.
  assert.equal(jobTitleOf(`<p class="byline">By Dana Whitfield, who covers wellness</p>`, "Dana Whitfield"), null);
  assert.equal(jobTitleOf(`<span class="author-title">Dana Whitfield</span>`, "Dana Whitfield"), null);
  const j = journalistFrom(news(), ARTICLE, "t", "shopco.com", nobody)!;
  assert.equal(j.jobTitle, null); // the fixture article prints no title
});

test("crm: a phone is filled only when printed", () => {
  assert.equal(printedPhone(`<a href="tel:+1-212-555-0142">Call the desk</a>`), "+1 212 555 0142");
  assert.equal(printedPhone(`<p>Phone: (212) 555 0142</p>`), "(212) 555 0142");
  assert.equal(printedPhone(`<p>Founded in 1998, 2,500 readers, issue 1234567.</p>`), null);
  assert.equal(printedPhone(`<p>Call us any time.</p>`), null);
  assert.equal(printedPhone(""), null);
  const j = journalistFrom(news(), ARTICLE, "t", "shopco.com", nobody)!;
  assert.equal(j.phone, null); // never from the article search alone
});

test("crm: the Email button's mailto carries the address, subject and body, encoded", () => {
  const m = mailtoFor("dana@dailyhealth.example", "A quote on sleep & routines", "Hi Dana,\n\nLine two?\nhttps://shopco.com");
  assert.ok(m.startsWith("mailto:dana@dailyhealth.example?subject="));
  const q = new URLSearchParams(m.split("?")[1]);
  assert.equal(q.get("subject"), "A quote on sleep & routines");
  assert.equal(q.get("body"), "Hi Dana,\r\n\r\nLine two?\r\nhttps://shopco.com");
  // No address known (or an odd one): the owner fills it in their own app.
  assert.ok(mailtoFor(null, "s", "b").startsWith("mailto:?subject="));
  assert.ok(mailtoFor("x@y.com?cc=evil@z.com", "s", "b").startsWith("mailto:?subject="));
});

test("crm: confirming the email marks Emailed with today and a follow up a week later", () => {
  const now = Date.parse("2026-11-16T15:00:00Z");
  assert.deepEqual(emailedPatch(now), { status: "emailed", statusAt: "2026-11-16T15:00:00.000Z", lastContacted: "2026-11-16", followUp: "2026-11-23" });
  const yes = ownerPatch({ kind: "emailed" }, now);
  assert.ok(yes.ok && yes.patch.status === "emailed" && yes.patch.lastContacted === "2026-11-16");
  // Picking Emailed in the dropdown does the same; other statuses don't touch the dates.
  assert.equal(statusPatch("emailed", now).followUp, "2026-11-23");
  assert.deepEqual(Object.keys(statusPatch("replied", now)), ["status", "statusAt"]);
  assert.equal(ownerPatch({ kind: "status", status: "pitched" }, now).ok, false);
  assert.equal(ownerPatch({ kind: "edit", subject: "", body: "x" }, now).ok, false);
});

test("crm: follow ups are due on or after their day, while the journalist is Emailed", () => {
  assert.equal(followUpDue({ status: "emailed", followUp: "2026-11-23" }, "2026-11-23"), true);
  assert.equal(followUpDue({ status: "emailed", followUp: "2026-11-20" }, "2026-11-23"), true);
  assert.equal(followUpDue({ status: "emailed", followUp: "2026-11-24" }, "2026-11-23"), false);
  assert.equal(followUpDue({ status: "replied", followUp: "2026-11-20" }, "2026-11-23"), false);
  assert.equal(followUpDue({ status: "emailed", followUp: null }, "2026-11-23"), false);
  const set = ownerPatch({ kind: "followUp", date: "2026-12-01" });
  assert.ok(set.ok && set.patch.followUp === "2026-12-01");
  assert.equal(ownerPatch({ kind: "followUp", date: "next week" }).ok, false);
  const clear = ownerPatch({ kind: "followUp", date: "" });
  assert.ok(clear.ok && clear.patch.followUp === null);
});

test("crm: the owner adds a journalist by hand, kept as entered", () => {
  const ok = manualJournalist({ name: "  Sam Ortiz ", jobTitle: "Editor", outlet: "Wellness Weekly", email: "Sam@Wellness.example", phone: "+1 (415) 555 0100", articleUrl: "https://wellness.example/a" });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.value.name, "Sam Ortiz");
    assert.equal(ok.value.email, "sam@wellness.example");
    assert.equal(ok.value.articleTitle, null);
  }
  assert.equal(manualJournalist({ outlet: "X" }).ok, false);
  assert.equal(manualJournalist({ name: "Sam", outlet: "" }).ok, false);
  assert.equal(manualJournalist({ name: "Sam", outlet: "X", email: "not an email" }).ok, false);
  assert.equal(manualJournalist({ name: "Sam", outlet: "X", phone: "call me" }).ok, false);
  assert.equal(manualJournalist({ name: "Sam", outlet: "X", articleUrl: "javascript:alert(1)" }).ok, false);
});

test("crm: the CSV has one row per journalist, quoted, never read as a formula", () => {
  const csv = journalistsCsv([
    { name: "Dana Whitfield", jobTitle: "Reporter", outlet: "Daily Health", email: "dana@dailyhealth.example", phone: null, articleTitle: 'Sleep, "routines"', articleUrl: "https://dailyhealth.example/a", status: "emailed", lastContacted: "2026-11-16", followUp: "2026-11-23", notes: "=HYPERLINK(1)" },
  ]);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^"Name","Job title","Outlet","Email","Phone","Location","Field","Profile link","Lists","Article title","Article link","Status","Last contacted","Follow up","Notes"$/);
  assert.match(lines[1], /"Sleep, ""routines"""/);
  assert.match(lines[1], /"Emailed"/);
  assert.match(lines[1], /"'=HYPERLINK\(1\)"$/);
});

test("crm: Find more is taken once a day in one conditional statement", async () => {
  const calls: string[] = [];
  const q = (rows: number): Sql => async (strings) => {
    calls.push(strings.join("$").replace(/\s+/g, " "));
    return Array.from({ length: rows }, () => ({ key: "k" }));
  };
  assert.equal(await takeFindNow("1", q(1)), true);
  assert.equal(await takeFindNow("1", q(0)), false); // within a day: refused
  assert.equal(calls.length, 2);
  assert.match(calls[0], /ON CONFLICT \(key\) DO UPDATE SET .* WHERE insights_settings\.updated_at < now\(\) - interval '1 day' RETURNING key/);
});

test("crm: journalists are searched on the site's product names and searches about them", () => {
  const t = productTopics(["ShopCo Magnesium Glycinate 120 Capsules", "ShopCo Ashwagandha Gummies"], ["shopco login", "best magnesium for sleep", "garden tips"], "ShopCo");
  assert.deepEqual(t, ["magnesium glycinate", "best magnesium for sleep", "ashwagandha"]);
  assert.deepEqual(productTopics([], ["anything"], null), []);
});

// ---------- CRM review fixes and Hunter ----------

import { normalStatus } from "../src/lib/analytics/autopilot/press-crm";
import { authorPagePhone, HUNTER_WEEKLY_CAP, hunterAccept, HunterError, hunterFind, takeHunterSlot } from "../src/lib/analytics/autopilot/press";

test("crm: a phone on the author page is theirs only from their Person data or bio; otherwise the outlet's", () => {
  const ld = `<script type="application/ld+json">{"@type":"Person","name":"Dana Whitfield","telephone":"+1 212 555 0142"}</script>`;
  assert.deepEqual(authorPagePhone(ld, "Dana Whitfield"), { phone: "+1 212 555 0142", own: true });
  const bio = `<div class="author-bio"><p>Dana Whitfield covers wellness. Phone: (212) 555 0199</p></div><footer>Tel: 212 555 0000</footer>`;
  assert.deepEqual(authorPagePhone(bio, "Dana Whitfield"), { phone: "(212) 555 0199", own: true });
  // Only a newsroom number elsewhere on the page: shown, but as the outlet's.
  assert.deepEqual(authorPagePhone(`<h1>Dana Whitfield</h1><footer>Tel: 212 555 0000</footer>`, "Dana Whitfield"), { phone: "212 555 0000", own: false });
  // Someone else's Person data is not theirs.
  assert.equal(authorPagePhone(`<script type="application/ld+json">{"@type":"Person","name":"Sam Ortiz","telephone":"+1 415 555 0100"}</script>`, "Dana Whitfield"), null);
  assert.equal(authorPagePhone("<p>No numbers.</p>", "Dana Whitfield"), null);
});

test("crm: a byline title counts only inside the same byline container as the author's name", () => {
  const same = `<div class="byline"><span class="author-name">Dana Whitfield</span><span class="author-title">Health Editor</span></div>`;
  assert.equal(jobTitleOf(same, "Dana Whitfield"), "Health Editor");
  const elsewhere = `<div class="byline">By Dana Whitfield</div><aside><span class="author-title">Editor in Chief</span></aside>`;
  assert.equal(jobTitleOf(elsewhere, "Dana Whitfield"), null);
  const otherBox = `<div class="byline">By Sam Ortiz <span class="author-title">Editor</span></div><p>Dana Whitfield</p>`;
  assert.equal(jobTitleOf(otherBox, "Dana Whitfield"), null);
  // Nested elements inside the container are fine.
  const nested = `<div class="author-box"><div><a href="/authors/dana">Dana Whitfield</a></div><div><p class="job-title">Senior Reporter</p></div></div>`;
  assert.equal(jobTitleOf(nested, "Dana Whitfield"), "Senior Reporter");
});

test("crm: CSV values that a spreadsheet could run are shown as text", () => {
  const row = (notes: string) => journalistsCsv([{ name: "A B", outlet: "X", status: "new", notes }]).trim().split("\r\n")[1];
  assert.match(row("  =1+1"), /"'  =1\+1"$/);
  assert.match(row("|cmd"), /"'\|cmd"$/);
  assert.match(row("-5"), /"'-5"$/);
  assert.match(row("\tx"), /"'\tx"$/);
  assert.match(row("\rx"), /"'\rx"$/);
  assert.match(row("plain note"), /"plain note"$/);
});

test("crm: the earlier statuses read as today's", () => {
  assert.equal(normalStatus("pitched"), "emailed");
  assert.equal(normalStatus("dismissed"), "not_interested");
  assert.equal(normalStatus("covered"), "covered");
  assert.equal(normalStatus(undefined), "new");
  assert.equal(normalStatus("anything"), "new");
});

test("crm: someone the owner added with no article is never drafted automatically", () => {
  assert.equal(autoDraftable({ status: "new", source: "owner", articleTitle: "" }), false);
  assert.equal(autoDraftable({ status: "new", source: "owner", articleTitle: "Sleep routines" }), true);
  assert.equal(autoDraftable({ status: "new", source: "search", articleTitle: "" }), true);
});

test("hunter: an email is shown only on the outlet's domain with a score of at least 70, labeled as Hunter's", () => {
  const none = () => false;
  const ok = hunterAccept({ email: "Dana@DailyHealth.example", score: 91, position: "Health Reporter", verification: { status: "valid" } }, "dailyhealth.example", none, false)!;
  assert.equal(ok.email, "dana@dailyhealth.example");
  assert.equal(ok.emailSource, "hunter");
  assert.equal(ok.hunterScore, 91);
  assert.equal(ok.emailIsOutlets, false);
  assert.equal(ok.jobTitle, "Health Reporter");
  assert.equal(ok.jobTitleFromHunter, true);
  // The page's own title stays: Hunter's position isn't used.
  assert.equal(hunterAccept({ email: "dana@dailyhealth.example", score: 91, position: "Reporter" }, "dailyhealth.example", none, true)!.jobTitle, undefined);
  assert.equal(hunterAccept({ email: "dana@dailyhealth.example", score: 69 }, "dailyhealth.example", none, false), null);
  assert.equal(hunterAccept({ email: "dana@gmail.com", score: 99 }, "dailyhealth.example", none, false), null);
  assert.equal(hunterAccept({ email: "dana@dailyhealth.example", score: 95, verification: { status: "invalid" } }, "dailyhealth.example", none, false), null);
  assert.equal(hunterAccept({ email: "dana@other.example", score: 95 }, "other.example", (d) => d === "other.example", false), null);
  assert.equal(hunterAccept({ email: null, score: 95 }, "dailyhealth.example", none, false), null);
  assert.equal(hunterAccept({ email: "dana@dailyhealth.example" }, "dailyhealth.example", none, false), null); // no score, not shown
});

test("hunter: a refused key or a used up quota is a plain message without the key; lookups are capped atomically", async () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const secret = "hk_secret_123";
  await assert.rejects(hunterFind(secret, "x.example", "Dana Whitfield", reply(401, { errors: [{ id: "authentication_failed" }] })), (e: Error) => e instanceof HunterError && /refused the API key/.test(e.message) && !e.message.includes(secret));
  await assert.rejects(hunterFind(secret, "x.example", "Dana Whitfield", reply(429, {})), (e: Error) => /quota is used up/.test(e.message) && !e.message.includes(secret));
  await assert.rejects(hunterFind(secret, "x.example", "Dana Whitfield", reply(403, { errors: [{ details: "You have reached your monthly quota" }] })), /quota/);
  const down = (async () => Promise.reject(new Error(`fetch failed for https://api.hunter.io/?api_key=${secret}`))) as unknown as typeof fetch;
  await assert.rejects(hunterFind(secret, "x.example", "Dana Whitfield", down), (e: Error) => !e.message.includes(secret));
  const found = await hunterFind(secret, "x.example", "Dana Whitfield", reply(200, { data: { email: "dana@x.example", score: 80 } }));
  assert.equal(found?.email, "dana@x.example");
  // The weekly cap in one conditional statement.
  const calls: { text: string; values: unknown[] }[] = [];
  const q: Sql = async (strings, ...values) => (calls.push({ text: strings.join("$").replace(/\s+/g, " "), values }), []);
  assert.equal(await takeHunterSlot("1", q), false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /ON CONFLICT \(account_id\) DO UPDATE SET hunter = .* WHERE \(SELECT count\(\*\) FROM unnest\(insights_press_drafts\.hunter\).*< \$ RETURNING/);
  assert.ok(calls[0].values.includes(HUNTER_WEEKLY_CAP));
});

// ---------- the metrics strip ----------

import { crmMetrics, type MetricItem } from "../src/lib/analytics/autopilot/press-crm";

test("metrics: counts come from the list itself, with a seven day window", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  const ago = (d: number) => new Date(now - d * 864e5).toISOString();
  const day = (d: number) => ago(d).slice(0, 10);
  const items: MetricItem[] = [
    { status: "new", foundAt: ago(1) },
    { status: "new", foundAt: ago(10), pitch: { subject: "s" } },
    { status: "new", foundAt: ago(2), pitchEdit: { subject: "s", body: "b" } },
    { status: "emailed", foundAt: ago(20), lastContacted: day(3), followUp: day(-4), pitch: {} },
    { status: "emailed", foundAt: ago(30), lastContacted: day(9), followUp: day(2) },
    { status: "replied", foundAt: ago(40), lastContacted: day(20), followUp: day(13) },
    { status: "covered", foundAt: ago(50), lastContacted: day(30) },
    { status: "not_interested", foundAt: ago(1), lastContacted: day(1), followUp: day(1) },
  ];
  const m = crmMetrics(items, now);
  assert.equal(m.total, 7); // Not interested left out
  assert.equal(m.newThisWeek, 2); // found 1 and 2 days ago; the Not interested one doesn't count
  assert.equal(m.emailedThisWeek, 2); // 3 and 1 days ago; 9 days ago is outside the week
  assert.equal(m.emailedEver, 5);
  assert.equal(m.replies, 2);
  assert.equal(m.replyRate, 40);
  assert.equal(m.coverage, 1);
  assert.equal(m.followUpsToday, 1); // due 2 days ago and still Emailed; not Replied, not Not interested, not in the future
  assert.equal(m.readyToSend, 2); // a draft or an edit, still New; the Emailed one with a pitch doesn't count
  assert.deepEqual(m.funnel, { found: 8, emailed: 5, replied: 2, covered: 1 });
});

test("metrics: the reply rate shows only once someone was emailed, and an empty list is all zeros", () => {
  const empty = crmMetrics([], Date.parse("2026-11-16T12:00:00Z"));
  assert.equal(empty.replyRate, null);
  assert.deepEqual(
    [empty.total, empty.newThisWeek, empty.emailedThisWeek, empty.emailedEver, empty.replies, empty.coverage, empty.followUpsToday, empty.readyToSend],
    [0, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.equal(crmMetrics([{ status: "new", foundAt: "2026-11-15T00:00:00Z" }], Date.parse("2026-11-16T12:00:00Z")).replyRate, null);
  assert.equal(crmMetrics([{ status: "emailed", foundAt: "2026-11-01T00:00:00Z", lastContacted: "2026-11-10" }], Date.parse("2026-11-16T12:00:00Z")).replyRate, 0);
});

test("metrics: a follow up is due today or earlier unless they replied, covered or said no", () => {
  const today = "2026-11-16";
  assert.equal(followUpDue({ status: "new", followUp: "2026-11-16" }, today), true);
  assert.equal(followUpDue({ status: "emailed", followUp: "2026-11-15" }, today), true);
  assert.equal(followUpDue({ status: "covered", followUp: "2026-11-10" }, today), false);
  assert.equal(followUpDue({ status: "not_interested", followUp: "2026-11-10" }, today), false);
  assert.equal(followUpDue({ status: "emailed", followUp: "2026-11-17" }, today), false);
});
