import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACEBOOK_SCOPES,
  facebookText,
  FB_GRAPH_VERSION,
  imageUrlOf,
  INSTAGRAM_MAX_CHARS,
  instagramCaption,
  instagramPlan,
  MetaApiError,
  needsFbReconnect,
  NO_IMAGE,
  SOCIAL_WEEKLY_CAP,
} from "../src/lib/analytics/facebook";

const kit = (facebook: string, instagram: string) => ({ linkedin: "", facebook, instagram, x: "", video: { hook: "", script: "", caption: "" } });
const url = "https://shop.com/blogs/news/tea";

test("facebook: asks only for Pages, posting and Instagram publishing, on a fixed Graph version, with a small weekly cap", () => {
  assert.deepEqual(FACEBOOK_SCOPES, ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"]);
  assert.ok(!FACEBOOK_SCOPES.includes("business_management"));
  assert.match(FB_GRAPH_VERSION, /^v\d+\.0$/);
  assert.equal(SOCIAL_WEEKLY_CAP, 3);
});

test("facebook: the post keeps the checked text and ends with the article link tagged for Facebook, once", () => {
  const text = facebookText({ url, kit: kit(`A calm guide to loose leaf tea.\n${url}`, "") });
  const lines = text.split("\n");
  const link = new URL(lines[lines.length - 1]);
  assert.equal(link.pathname, "/blogs/news/tea");
  assert.equal(link.searchParams.get("utm_source"), "facebook");
  assert.equal(link.searchParams.get("utm_medium"), "social");
  assert.ok(text.startsWith("A calm guide to loose leaf tea."));
  assert.equal(text.split("shop.com/blogs/news/tea").length, 2);
  // The same link written another way is taken out too.
  assert.equal(facebookText({ url, kit: kit(`Tea ${url.replace("https://", "https://www.")}/`, "") }).split("shop.com").length, 2);
});

test("instagram: the caption has no links (they can't be clicked there) and stays within the limit", () => {
  const c = instagramCaption({ title: "Tea", kit: kit("", `Loose leaf tea, made simple. Link in bio. ${url} #tea`) });
  assert.ok(!c.includes("http"));
  assert.ok(c.includes("Link in bio"));
  assert.equal(instagramCaption({ title: "Tea guide", kit: kit("", "") }), "Tea guide");
  assert.ok(instagramCaption({ title: "T", kit: kit("", "word ".repeat(1000)) }).length <= INSTAGRAM_MAX_CHARS);
});

test("instagram: an article without its own image is skipped, with the reason", () => {
  assert.deepEqual(instagramPlan({ url, title: "Tea", kit: kit("", "Tea") }, null), { skip: NO_IMAGE });
  assert.deepEqual(instagramPlan({ url, title: "Tea", kit: kit("", "Tea") }, "  "), { skip: NO_IMAGE });
  assert.deepEqual(instagramPlan({ url, title: "Tea", kit: kit("", "Tea") }, "data:image/png;base64,AAAA"), { skip: NO_IMAGE });
  const plan = instagramPlan({ url, title: "Tea", kit: kit("", "Tea") }, "/cdn/tea.jpg");
  assert.deepEqual(plan, { caption: "Tea", image: "https://shop.com/cdn/tea.jpg" });
  assert.equal(imageUrlOf("http://cdn.shop.com/a.jpg", url), "https://cdn.shop.com/a.jpg");
});

test("facebook: a removed or expired connection asks the owner to reconnect", () => {
  assert.ok(needsFbReconnect(new MetaApiError("Error validating access token", 400, 190)));
  assert.ok(!needsFbReconnect(new MetaApiError("(#200) permission", 403, 200)));
  assert.ok(!needsFbReconnect(new Error("network")));
});

test("connect links: a ticket made for one service is refused by every other connect flow", async () => {
  process.env.SESSION_SECRET ||= "test-secret";
  const { googleLinkTicket, readLinkTicket, ticketFor } = await import("../src/lib/analytics/embedded");
  const fb = googleLinkTicket("7", "/back", true, "facebook");
  const th = googleLinkTicket("7", "/back", true, "threads");
  const g = googleLinkTicket("7", "/back", true);
  assert.equal(ticketFor(fb, "facebook")?.accountId, "7");
  assert.equal(ticketFor(fb, "threads"), null);
  assert.equal(ticketFor(fb, "google"), null);
  assert.equal(ticketFor(th, "facebook"), null);
  assert.equal(ticketFor(g, "facebook"), null);
  assert.equal(readLinkTicket(fb)?.purpose, "facebook");
  // A ticket whose purpose this version doesn't know is never taken as a Google one.
  const crypto = await import("crypto");
  const payload = Buffer.from(JSON.stringify({ a: "7", r: "/b", e: Date.now() + 60_000, s: 0, n: "x", p: "other" })).toString("base64url");
  const key = crypto.createHmac("sha256", process.env.SESSION_SECRET!).update("google-link").digest();
  const forged = `${payload}.${crypto.createHmac("sha256", key).update(payload).digest("base64url")}`;
  assert.equal(readLinkTicket(forged), null);
});
