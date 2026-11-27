import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  addressProblem,
  ADDRESS_REFUSAL_LIMIT,
  allowance,
  resendFits,
  todayStartUtc,
  batchKey,
  batchSizes,
  BATCH_PAUSE_MS,
  isSingleKey,
  pendingAction,
  RESEND_WINDOW_MS,
  retryAfterMs,
  semicolonsToCommas,
  singleKey,
  buildEmail,
  chunk,
  failureKind,
  footer,
  fromHeader,
  iso,
  mergeImport,
  missingSetup,
  newToken,
  normalizeEmail,
  onSubdomain,
  parseSubscriberList,
  renderBody,
  unsubscribeUrl,
  validToken,
  verifySvix,
  type SubscriberStatus,
} from "../src/lib/analytics/newsletter";

test("emails are trimmed, lowercased and checked", () => {
  assert.equal(normalizeEmail("  Ana.Lopez@Example.COM "), "ana.lopez@example.com");
  assert.equal(normalizeEmail("mailto:ben@shop.co"), "ben@shop.co");
  assert.equal(normalizeEmail("<cara@shop.co>"), "cara@shop.co");
  assert.equal(normalizeEmail("not an email"), null);
  assert.equal(normalizeEmail("a..b@shop.co"), null);
  assert.equal(normalizeEmail("a@b"), null);
  assert.equal(normalizeEmail("two@x.com, three@y.com"), null);
  assert.equal(normalizeEmail(42), null);
});

test("a CSV with a header finds the email and name columns", () => {
  const r = parseSubscriberList('First Name,Last Name,Email Address\nAna,Lopez,ANA@x.com\nBen,,ben@x.com\n,,nope\nAna,L,ana@x.com\n');
  assert.deepEqual(r.rows, [
    { email: "ana@x.com", name: "Ana Lopez" },
    { email: "ben@x.com", name: "Ben" },
  ]);
  assert.equal(r.invalid, 1);
  assert.equal(r.duplicates, 1);
});

test("a pasted list: one per line, commas or semicolons, names in angle brackets", () => {
  const r = parseSubscriberList("ana@x.com\nBen Ortiz <BEN@x.com>; cara@x.com, ana@x.com\njunk");
  assert.deepEqual(r.rows.map((x) => x.email), ["ana@x.com", "ben@x.com", "cara@x.com"]);
  assert.equal(r.rows[1].name, "Ben Ortiz");
  assert.equal(r.duplicates, 1);
  assert.equal(r.invalid, 1);
});

test("an import never subscribes again anyone who unsubscribed, bounced or complained", () => {
  const existing = new Map<string, SubscriberStatus>([
    ["gone@x.com", "unsubscribed"],
    ["bad@x.com", "bounced"],
    ["spam@x.com", "complained"],
    ["here@x.com", "subscribed"],
  ]);
  const plan = mergeImport(existing, ["gone@x.com", "bad@x.com", "spam@x.com", "here@x.com", "new@x.com"].map((email) => ({ email, name: "" })));
  assert.deepEqual(plan.add.map((r) => r.email), ["new@x.com"]);
  assert.equal(plan.blocked, 3);
  assert.equal(plan.already, 1);
});

test("unsubscribe tokens are random, unguessable and only their exact shape is accepted", () => {
  const a = newToken();
  const b = newToken();
  assert.notEqual(a, b);
  assert.ok(validToken(a));
  assert.equal(a.length, 43);
  assert.equal(validToken("test"), false);
  assert.equal(validToken(`${a}x`), false);
  assert.equal(validToken("' OR 1=1 --".padEnd(43, "a")), false);
  assert.equal(validToken(null), false);
  assert.equal(unsubscribeUrl("https://app.example.com/", a), `https://app.example.com/api/newsletter/unsubscribe?t=${a}`);
});

test("the owner's format becomes safe HTML: no tags, no script links", () => {
  const r = renderBody('# Hello\n\nA <b>bold</b> move & **this**.\nSee [our shop](https://shop.com/a).\n\n* one\n* two\n\n[bad](javascript:alert(1)) https://shop.com/b');
  assert.ok(r.html.includes("<h1"));
  assert.ok(r.html.includes("&#60;b&#62;bold&#60;/b&#62;"));
  assert.ok(!r.html.includes("<b>"));
  assert.ok(r.html.includes("<strong>this</strong>"));
  assert.ok(r.html.includes('<a href="https://shop.com/a"'));
  assert.ok(r.html.includes("<li"));
  assert.ok(!/href="javascript/i.test(r.html));
  assert.ok(r.html.includes('href="https://shop.com/b"'));
  assert.ok(r.text.includes("our shop (https://shop.com/a)"));
  assert.ok(r.text.includes("* one"));
});

test("every email has the one click unsubscribe headers and a footer with the link and postal address", () => {
  const unsub = "https://app.example.com/api/newsletter/unsubscribe?t=abc";
  const e = buildEmail({
    from: fromHeader('Shop "Best" <x>', "news@news.shop.com"),
    replyTo: "owner@shop.com",
    to: "ana@x.com",
    subject: "Hello\r\nBcc: evil@x.com",
    preview: "A short note",
    body: "Hi there.",
    brand: "Shop",
    postalAddress: "1 Main St\nTown, TX 76009",
    unsubscribe: unsub,
  });
  assert.equal(e.from, '"Shop Best x" <news@news.shop.com>');
  assert.deepEqual(e.to, ["ana@x.com"]);
  assert.equal(e.subject, "Hello Bcc: evil@x.com");
  assert.equal(e.reply_to, "owner@shop.com");
  assert.deepEqual(e.headers, { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  assert.ok(String(e.text).includes(`Unsubscribe: ${unsub}`));
  assert.ok(String(e.text).includes("1 Main St\nTown, TX 76009"));
  assert.ok(String(e.html).includes("1 Main St<br>Town, TX 76009"));
  assert.ok(String(e.html).includes("A short note"));
  assert.equal("tags" in e, false, "no tags in batch emails");
  const f = footer({ brand: "Shop", postalAddress: "PO Box 9", unsubscribe: unsub });
  assert.ok(!/[‐-―]|\s-\s/.test(f.text), "no dashes in the footer wording");
});

test("sending is blocked until the key, from address and postal address are set", () => {
  assert.deepEqual(missingSetup({ resendKey: null, fromAddress: "", postalAddress: " " }), ["your Resend key", "a from address", "your business postal address"]);
  assert.deepEqual(missingSetup({ resendKey: "re_x", fromAddress: "news@news.shop.com", postalAddress: "1 Main St" }), []);
});

test("daily cap and batches of 100", () => {
  assert.equal(allowance(500, 0), 500);
  assert.equal(allowance(500, 480), 20);
  assert.equal(allowance(500, 600), 0);
  assert.deepEqual(batchSizes(250, 500), [100, 100, 50]);
  assert.deepEqual(batchSizes(1000, 230), [100, 100, 30]);
  assert.deepEqual(batchSizes(5000, 50_000, 2000).length, 20);
  assert.deepEqual(batchSizes(10, 0), []);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("a Resend failure: refused stops, a rate limit waits, no answer is never resent", () => {
  assert.equal(failureKind(401), "fatal");
  assert.equal(failureKind(403), "fatal");
  assert.equal(failureKind(422), "invalid");
  assert.equal(failureKind(429), "retry");
  assert.equal(failureKind(409), "retry");
  assert.equal(failureKind(500), "unknown");
  assert.equal(failureKind(null), "unknown");
});

test("from addresses on a subdomain", () => {
  assert.equal(onSubdomain("news@news.shop.com"), true);
  assert.equal(onSubdomain("news@shop.com"), false);
  assert.equal(onSubdomain("news@shop.co.uk"), false);
  assert.equal(onSubdomain("news@mail.shop.co.uk"), true);
});

test("Resend webhook signatures (Svix) are checked, with a time limit", () => {
  const key = crypto.randomBytes(24);
  const secret = `whsec_${key.toString("base64")}`;
  const body = '{"type":"email.bounced"}';
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const sig = crypto.createHmac("sha256", key).update(`msg_1.${ts}.${body}`).digest("base64");
  assert.equal(verifySvix(secret, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, body, now), true);
  assert.equal(verifySvix(secret, { id: "msg_1", timestamp: ts, signature: `v1,bad v1,${sig}` }, body, now), true);
  assert.equal(verifySvix(secret, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, `${body} `, now), false);
  assert.equal(verifySvix(secret, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, body, now + 10 * 60_000), false);
  assert.equal(verifySvix(secret, { id: null, timestamp: ts, signature: `v1,${sig}` }, body, now), false);
});

test("database timestamps become ISO for the browser", () => {
  assert.equal(iso("2026-11-26 10:00:00.5+00"), "2026-11-26T10:00:00.500Z");
  assert.equal(iso(null), null);
});

test("a semicolon inside a quoted name stays; the others split the list", () => {
  assert.equal(semicolonsToCommas('a@x.com; "Lopez; Ana" <ana@x.com>'), 'a@x.com, "Lopez; Ana" <ana@x.com>');
  const r = parseSubscriberList('"Lopez; Ana" <ana@x.com>; ben@x.com');
  assert.deepEqual(r.rows, [{ email: "ana@x.com", name: "Lopez; Ana" }, { email: "ben@x.com", name: "" }]);
});

test("a 422 for one email: an address problem skips that person, anything else stops the email", () => {
  assert.equal(addressProblem({ name: "validation_error", message: "Invalid `to` field. The email address needs to follow the email@example.com format." }), true);
  assert.equal(addressProblem({ name: "invalid_to_address", message: "x" }), true);
  assert.equal(addressProblem({ name: "validation_error", message: "The news.shop.com domain is not verified." }), false);
  assert.equal(addressProblem(null, ""), false);
});

test("Retry-After in seconds or as a date", () => {
  const now = Date.parse("2026-11-26T10:00:00Z");
  assert.equal(retryAfterMs("2", now), 2000);
  assert.equal(retryAfterMs("Thu, 26 Nov 2026 10:00:05 GMT", now), 5000);
  assert.equal(retryAfterMs(null, now), null);
  assert.equal(retryAfterMs("soon", now), null);
  assert.ok(BATCH_PAUSE_MS >= 500);
});

test("idempotency keys: a fresh claim gets a fresh key; only an unanswered batch is resent with its key, within 24 hours", () => {
  const a = batchKey("7");
  const b = batchKey("7");
  assert.notEqual(a, b);
  assert.ok(a.startsWith("newsletter-7-"));
  assert.ok(a.length <= 256);
  assert.equal(isSingleKey(a), false);
  assert.equal(isSingleKey(singleKey(a, "42")), true);
  assert.equal(singleKey(a, "42"), `${a}-one-42`);
  const now = Date.now();
  assert.equal(pendingAction(now - 3_600_000, now), "resend");
  assert.equal(pendingAction(now - RESEND_WINDOW_MS - 1, now), "unknown");
  assert.ok(RESEND_WINDOW_MS < 24 * 3_600_000);
});

test("only a refusal naming the to field counts as one subscriber's address, never the sender's", () => {
  assert.equal(addressProblem({ name: "validation_error", message: "Invalid `to` field." }), true);
  assert.equal(addressProblem({ name: "validation_error", message: "Invalid `from` field. The email address needs to follow the email@example.com format." }), false);
  assert.equal(addressProblem({ name: "validation_error", message: "Invalid `reply_to` field." }), false);
  assert.equal(addressProblem({ name: "validation_error", message: "Invalid email address." }), false);
  assert.equal(ADDRESS_REFUSAL_LIMIT, 3);
});

test("resending unanswered batches stays within the daily cap and the run's limit", () => {
  const now = Date.parse("2026-11-26T15:00:00Z");
  assert.equal(todayStartUtc(now), Date.parse("2026-11-26T00:00:00Z"));
  const today = Date.parse("2026-11-26T09:00:00Z");
  const yesterday = Date.parse("2026-11-25T22:00:00Z");
  // Claimed today: already counted against today's cap.
  assert.equal(resendFits(100, today, 0, 500, now), true);
  // Claimed yesterday: needs room today.
  assert.equal(resendFits(100, yesterday, 50, 500, now), false);
  assert.equal(resendFits(100, yesterday, 100, 500, now), true);
  // Never past the run's own limit.
  assert.equal(resendFits(100, today, 500, 0, now), false);
  assert.equal(resendFits(100, today, 500, 99, now), false);
});
