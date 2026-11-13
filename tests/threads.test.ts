import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { needsReconnect, taggedUrl, THREADS_MAX_CHARS, THREADS_SCOPES, threadsText, ThreadsApiError, WEEKLY_POST_CAP } from "../src/lib/analytics/threads";
import { threadsSignedUser } from "../src/lib/analytics/handlers";

const kit = (x: string) => ({ linkedin: "", facebook: "", instagram: "", x, video: { hook: "", script: "", caption: "" } });

test("threads: only permission to read the username and to post, and a small weekly cap", () => {
  assert.deepEqual(THREADS_SCOPES, ["threads_basic", "threads_content_publish"]);
  assert.ok(WEEKLY_POST_CAP > 0 && WEEKLY_POST_CAP <= 5);
});

test("threads: the article link is tagged so Analytics shows Threads as the source", () => {
  const u = new URL(taggedUrl("https://shop.com/blogs/news/tea?ref=a"));
  assert.equal(u.searchParams.get("utm_source"), "threads");
  assert.equal(u.searchParams.get("utm_medium"), "social");
  assert.equal(u.searchParams.get("ref"), "a");
  assert.equal(u.pathname, "/blogs/news/tea");
});

test("threads: the post uses the checked short post with the tagged link, within the limit", () => {
  const url = "https://shop.com/blogs/news/tea";
  const text = threadsText({ url, kit: kit(`Why loose leaf tea tastes better ${url}`) });
  assert.ok(text.startsWith("Why loose leaf tea tastes better https://shop.com/blogs/news/tea?utm_source=threads"));
  assert.ok(!text.includes(`${url} `));
  // No link in the post: it is added at the end.
  assert.ok(threadsText({ url, kit: kit("A calm guide to tea") }).endsWith(taggedUrl(url)));
  // The same link written another way is not left in twice.
  for (const v of [`${url}/`, url.replace("https://", "http://"), url.replace("https://", "https://www.")]) {
    const t = threadsText({ url, kit: kit(`Tea guide ${v}`) });
    assert.equal(t, `Tea guide ${taggedUrl(url)}`, v);
  }
  // A different article whose address starts the same stays.
  assert.ok(threadsText({ url, kit: kit(`See ${url}-two`) }).includes(`${url}-two`));
  // Too long: cut on a word, link kept.
  const long = threadsText({ url, kit: kit(`${"word ".repeat(200)}${url}`) });
  assert.ok(long.length <= THREADS_MAX_CHARS);
  assert.ok(long.endsWith(taggedUrl(url)));
});

test("threads: an expired or removed connection asks the owner to reconnect", () => {
  assert.ok(needsReconnect(new ThreadsApiError("Threads: Error validating access token", 400, 190)));
  assert.ok(!needsReconnect(new ThreadsApiError("Threads: text too long", 400, 100)));
  assert.ok(!needsReconnect(new Error("network")));
});

test("threads: Meta's removal request is trusted only with the app secret's signature", () => {
  const secret = "app-secret";
  const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "1789" })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  assert.equal(threadsSignedUser(`${sig}.${payload}`, secret), "1789");
  assert.equal(threadsSignedUser(`${sig}.${payload}`, "other"), null);
  assert.equal(threadsSignedUser("nope", secret), null);
  assert.equal(threadsSignedUser(null, secret), null);
});

test("threads: a Google connect link can't be used to connect Threads, or the other way round", async () => {
  process.env.SESSION_SECRET ||= "test-secret";
  const { googleLinkTicket, readLinkTicket } = await import("../src/lib/analytics/embedded");
  assert.equal(readLinkTicket(googleLinkTicket("7", "/back", true))?.purpose, "google");
  assert.equal(readLinkTicket(googleLinkTicket("7", "/back", true, "threads"))?.purpose, "threads");
});
