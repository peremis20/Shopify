import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addMetrics,
  buildEmail,
  campaignSlug,
  cleanAuto,
  emptyMetrics,
  eventFields,
  localTime,
  metricRates,
  parseSchedule,
  pickArticle,
  renderBody,
  slugCampaign,
  unsubscribeUrl,
  validZone,
  weekOf,
  weeklyDue,
  weekSeries,
  withUtm,
} from "../src/lib/analytics/newsletter";

test("UTM tags go only on links to the site's own domain, and never replace the owner's", () => {
  assert.equal(withUtm("https://shop.com/blogs/a", "shop.com", "7_tips"), "https://shop.com/blogs/a?utm_source=newsletter&utm_medium=email&utm_campaign=7_tips");
  assert.equal(withUtm("https://www.shop.com/a?x=1", "shop.com", "7"), "https://www.shop.com/a?x=1&utm_source=newsletter&utm_medium=email&utm_campaign=7");
  assert.equal(withUtm("https://other.com/a", "shop.com", "7"), "https://other.com/a");
  assert.equal(withUtm("https://shop.com.evil.com/a", "shop.com", "7"), "https://shop.com.evil.com/a");
  assert.equal(withUtm("https://shop.com/a?utm_source=ig", "shop.com", "7"), "https://shop.com/a?utm_source=ig&utm_medium=email&utm_campaign=7");
  assert.equal(withUtm("https://shop.com/a", null, "7"), "https://shop.com/a");
});

test("campaign slugs: the id first, plain words, and read back to the id", () => {
  assert.equal(campaignSlug("12", "Spring tips: 5 ways to sleep better!"), "12_spring_tips_5_ways_to");
  assert.equal(campaignSlug("3", "¡Hola!"), "3_hola");
  assert.equal(slugCampaign("12_spring_tips"), "12");
  assert.equal(slugCampaign("12"), "12");
  assert.equal(slugCampaign("spring"), null);
});

test("links in the email carry the tags in both the HTML and the text, other links stay as they are", () => {
  const r = renderBody("See [the post](https://shop.com/p) and https://shop.com/q or https://other.com/z", (u) => withUtm(u, "shop.com", "9"));
  assert.ok(r.html.includes('href="https://shop.com/p?utm_source=newsletter&#38;utm_medium=email&#38;utm_campaign=9"'));
  assert.ok(r.text.includes("the post (https://shop.com/p?utm_source=newsletter&utm_medium=email&utm_campaign=9)"));
  assert.ok(r.text.includes("https://shop.com/q?utm_source=newsletter"));
  assert.ok(r.text.includes("https://other.com/z"));
  assert.ok(!r.text.includes("other.com/z?utm"));
  const e = buildEmail({ from: "a@b.co", replyTo: null, to: "c@d.co", subject: "s", preview: "", body: "[x](https://shop.com/)", brand: "B", postalAddress: "1 Main", unsubscribe: "https://app/u", utm: { domain: "shop.com", slug: "4_s" } });
  assert.ok(String(e.html).includes("utm_campaign=4_s"));
  assert.ok(!String(e.html).includes("https://app/u?utm"), "the unsubscribe link is never tagged");
});

test("the unsubscribe link names the email it came from", () => {
  assert.equal(unsubscribeUrl("https://app.x.com", "tok", "12"), "https://app.x.com/api/newsletter/unsubscribe?t=tok&c=12");
  assert.equal(unsubscribeUrl("https://app.x.com", "tok", "bad"), "https://app.x.com/api/newsletter/unsubscribe?t=tok");
});

test("rates: against delivered once known, else sent; never a made up rate", () => {
  const m = { ...emptyMetrics(), sent: 200, delivered: 0, uniqueOpens: 50, uniqueClicks: 10, bounced: 4, unsubscribed: 2 };
  assert.deepEqual(metricRates(m), { delivered: 0, bounced: 2, complained: 0, unsubscribed: 1, opens: 25, clicks: 5 });
  assert.equal(metricRates({ ...m, delivered: 100 }).opens, 50);
  assert.deepEqual(metricRates(emptyMetrics()), { delivered: null, bounced: null, complained: null, unsubscribed: null, opens: null, clicks: null });
  assert.equal(addMetrics({ ...emptyMetrics(), sent: 2, opens: 3 }, { ...emptyMetrics(), sent: 5, opens: 1 }).opens, 4);
});

test("weeks: Monday starts, the last twelve with zeros filled in", () => {
  assert.equal(weekOf(Date.parse("2026-11-27T10:00:00Z")), "2026-11-23");
  assert.equal(weekOf(Date.parse("2026-11-23T00:00:00Z")), "2026-11-23");
  const s = weekSeries([{ week: "2026-11-23", subscribed: 5, unsubscribed: 1 }], 3, Date.parse("2026-11-27T10:00:00Z"));
  assert.deepEqual(s.map((x) => x.week), ["2026-11-09", "2026-11-16", "2026-11-23"]);
  assert.deepEqual(s[2], { week: "2026-11-23", subscribed: 5, unsubscribed: 1 });
  assert.equal(s[0].subscribed, 0);
});

test("the weekly newsletter is due on the owner's day and hour, in their time zone, once that day", () => {
  assert.equal(validZone("America/Chicago"), true);
  assert.equal(validZone("Not/AZone"), false);
  // Tuesday Dec 1 2026, 15:30 UTC is 9:30 in Chicago.
  const now = Date.parse("2026-12-01T15:30:00Z");
  assert.deepEqual(localTime(now, "America/Chicago"), { weekday: 2, hour: 9, date: "2026-12-01" });
  assert.deepEqual(weeklyDue({ now, tz: "America/Chicago", day: 2, hour: 9, lastKey: null }), { due: true, key: "2026-12-01" });
  assert.equal(weeklyDue({ now, tz: "America/Chicago", day: 2, hour: 9, lastKey: "2026-12-01" }).due, false);
  assert.equal(weeklyDue({ now, tz: "America/Chicago", day: 2, hour: 10, lastKey: null }).due, false);
  assert.equal(weeklyDue({ now, tz: "America/Chicago", day: 3, hour: 9, lastKey: null }).due, false);
  // The same moment is already Wednesday in Tokyo.
  assert.equal(weeklyDue({ now, tz: "Asia/Tokyo", day: 3, hour: 0, lastKey: null }).due, true);
});

test("a scheduled send: in the future and within 60 days", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");
  assert.equal(parseSchedule(undefined, now), null);
  assert.equal(parseSchedule("", now), null);
  assert.equal(parseSchedule("2026-11-28T09:00:00Z", now)?.toISOString(), "2026-11-28T09:00:00.000Z");
  assert.throws(() => parseSchedule("2026-11-27T11:00:00Z", now), /future/);
  assert.throws(() => parseSchedule("2027-03-01T00:00:00Z", now), /60 days/);
  assert.throws(() => parseSchedule("soon", now), /date/);
});

test("Resend events: the tracked ones are read, anything else is ignored", () => {
  const e = eventFields({ type: "email.clicked", created_at: "2026-11-27T10:00:00.000Z", data: { email_id: "abc", to: ["a@x.com"], click: { link: "https://shop.com/p" } } });
  assert.deepEqual(e, { type: "email.clicked", resendId: "abc", emails: ["a@x.com"], link: "https://shop.com/p", at: "2026-11-27T10:00:00.000Z", bounceType: null });
  assert.equal(eventFields({ type: "domain.updated", data: {} }), null);
  assert.equal(eventFields(null), null);
  assert.equal(eventFields({ type: "email.bounced", data: { email_id: "z", to: "b@x.com", bounce: { type: "Transient" } } })?.bounceType, "Transient");
});

test("the weekly article: the newest one no newsletter used yet", () => {
  const arts = [{ url: "/blogs/a/new", title: "New" }, { url: "/blogs/a/old", title: "Old" }];
  assert.equal(pickArticle(arts, new Set(), "shop.com")?.link, "https://shop.com/blogs/a/new");
  assert.equal(pickArticle(arts, new Set(["https://shop.com/blogs/a/new"]), "shop.com")?.title, "Old");
  assert.equal(pickArticle(arts, new Set(["https://shop.com/blogs/a/new", "https://shop.com/blogs/a/old"]), "shop.com"), null);
  assert.equal(pickArticle(arts, new Set(), null), null);
});

test("automatic sending choices: kept unless given, checked when given", () => {
  const cur = { welcomeOn: false, weeklyOn: true, weeklyAutoSend: false, weeklyDay: 2, weeklyHour: 9, timeZone: "America/Chicago" };
  assert.deepEqual(cleanAuto({}, cur), cur);
  assert.equal(cleanAuto({ welcomeOn: true }, cur).welcomeOn, true);
  assert.equal(cleanAuto({ welcomeOn: "yes" }, cur).welcomeOn, false, "only a real true turns it on");
  assert.equal(cleanAuto({ timeZone: "" }, cur).timeZone, null);
  assert.throws(() => cleanAuto({ weeklyDay: 7 }, cur), /day/);
  assert.throws(() => cleanAuto({ weeklyHour: 24 }, cur), /hour/);
  assert.throws(() => cleanAuto({ timeZone: "Mars/Base" }, cur), /time zone/);
});
