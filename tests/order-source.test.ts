import { test } from "node:test";
import assert from "node:assert/strict";
import { inAnalyticsWeek, newsletterTag, orderSource } from "../src/lib/analytics/autopilot/shopify-sales";

test("analytics week: seven whole days ending yesterday, in the shop's time zone", () => {
  const now = Date.parse("2026-11-25T23:00:00Z"); // 5 PM on Nov 25 in Chicago
  const tz = "America/Chicago";
  assert.equal(inAnalyticsWeek("2026-11-25T15:00:00Z", now, tz), false); // today
  assert.equal(inAnalyticsWeek("2026-11-25T03:00:00Z", now, tz), true); // Nov 24 evening in Chicago
  assert.equal(inAnalyticsWeek("2026-11-18T07:00:00Z", now, tz), true); // Nov 18, first day
  assert.equal(inAnalyticsWeek("2026-11-18T04:00:00Z", now, tz), false); // Nov 17 in Chicago
  assert.equal(inAnalyticsWeek("2026-11-24T12:00:00Z", now, null), true);
  assert.equal(inAnalyticsWeek("2026-11-24T12:00:00Z", now, "Not/AZone"), true);
});

const visit = (source: string | null, referrerUrl: string | null = null, medium: string | null = null) => ({ source, referrerUrl, landingPage: "https://x.com/", utmParameters: medium ? { medium } : null });

test("order source: names where each order came from", () => {
  assert.equal(orderSource("web", { firstVisit: visit("Google", "https://www.google.com/"), lastVisit: visit("direct") }), "Google search");
  assert.equal(orderSource("web", { firstVisit: visit("Google", null, "cpc"), lastVisit: null }), "Google ads");
  assert.equal(orderSource("web", { firstVisit: visit("https://www.tiktok.com/"), lastVisit: visit("https://www.tiktok.com/") }), "TikTok");
  assert.equal(orderSource("web", { firstVisit: visit("ChatGPT"), lastVisit: visit("ChatGPT") }), "ChatGPT");
  assert.equal(orderSource("web", { firstVisit: visit("direct"), lastVisit: visit("direct") }), "Direct or unknown");
  assert.equal(orderSource("web", { firstVisit: null, lastVisit: visit("https://www.thecinnamonhollow.com/post") }), "thecinnamonhollow.com");
  assert.equal(orderSource("tiktok", { firstVisit: null, lastVisit: null }), "TikTok Shop");
  assert.equal(orderSource("pos", null), "In person");
  assert.equal(orderSource(null, null), "Direct or unknown");
});

test("order source: other Google products, page paths and odd names are not misread", () => {
  assert.equal(orderSource("web", { firstVisit: null, lastVisit: visit("gemini.google.com", "https://gemini.google.com/") }), "Gemini");
  assert.equal(orderSource("web", { firstVisit: null, lastVisit: visit("Gmail", "https://mail.google.com/") }), "Gmail");
  assert.equal(orderSource("web", { firstVisit: null, lastVisit: visit("https://myblog.com/best-tiktok-finds", "https://myblog.com/email-tips") }), "myblog.com");
  assert.equal(orderSource("web", { firstVisit: null, lastVisit: visit("reddit.com", "https://reddit.com/r/x?utm=google") }), "reddit.com");
  assert.equal(orderSource("web", { firstVisit: null, lastVisit: visit("Partner - Spring promo") }), "Partner Spring promo");
  assert.equal(orderSource("5363377", null), "Other app");
  assert.equal(orderSource("iphone", null), "Shop app");
  assert.equal(orderSource("web", { firstVisit: visit("Google", "https://www.google.co.uk/"), lastVisit: null }), "Google search");
});

test("order source: Google app, Shopping, ads names, unknown and the store's own pages", () => {
  assert.equal(orderSource("web", { firstVisit: null, lastVisit: visit("android-app://com.google.android.googlequicksearchbox") }), "Google search");
  assert.equal(orderSource("web", { firstVisit: null, lastVisit: visit("Google Shopping") }), "Google search");
  assert.equal(orderSource("web", { firstVisit: null, lastVisit: visit("google_ads", null, "cpc") }), "Google ads");
  assert.equal(orderSource("web", { firstVisit: null, lastVisit: visit("unknown") }), "Direct or unknown");
  assert.equal(orderSource("web", { firstVisit: null, lastVisit: visit("direct", "https://peremis.com/") }), "Direct or unknown");
  assert.equal(orderSource("web", { firstVisit: null, lastVisit: visit("Other") }), "Other");
  assert.equal(orderSource("web", { firstVisit: null, lastVisit: visit("google.evil.com") }), "google.evil.com");
});

test("order source: the last visit from a DashPatrol newsletter link counts as Newsletter, after Google search", () => {
  const letter = { source: "dashpatrol", referrerUrl: null, landingPage: "https://x.com/a", utmParameters: { medium: "newsletter", source: "dashpatrol", campaign: "12_spring" } };
  assert.equal(orderSource("web", { firstVisit: null, lastVisit: letter }), "Newsletter");
  // The last visit only, as for every other source.
  assert.notEqual(orderSource("web", { firstVisit: letter, lastVisit: visit("direct") }), "Newsletter");
  assert.equal(orderSource("web", { firstVisit: visit("Google", "https://www.google.com/"), lastVisit: letter }), "Google search");
});

test("newsletter tags: the distinctive tag, the old one only with an email id, anything else not", () => {
  const v = (source: string, medium: string, campaign: string) => ({ source, referrerUrl: null, landingPage: null, utmParameters: { source, medium, campaign } });
  assert.equal(newsletterTag(v("dashpatrol", "newsletter", "12_a")), "dashpatrol");
  assert.equal(newsletterTag(v("newsletter", "email", "12_a")), "legacy");
  assert.equal(newsletterTag(v("newsletter", "email", "spring_sale")), null);
  assert.equal(newsletterTag(v("klaviyo", "email", "12")), null);
  assert.equal(newsletterTag(null), null);
});
