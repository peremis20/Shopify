import { test } from "node:test";
import assert from "node:assert/strict";
import { orderSource } from "../src/lib/analytics/autopilot/shopify-sales";

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
