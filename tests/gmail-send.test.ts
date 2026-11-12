import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRaw, DAILY_SEND_CAP, GMAIL_OAUTH_SCOPES, sameOwner, sendOneEmail, singleAddress } from "../src/lib/analytics/gmail";

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

test("gmail: To must be one plain address", () => {
  assert.equal(singleAddress(" editor@site.com "), "editor@site.com");
  assert.equal(singleAddress("a.b+c@mail.example.co.uk"), "a.b+c@mail.example.co.uk");
  for (const bad of ["", "nobody", "a@b", "a@b.com, c@d.com", "a@b.com;c@d.com", "Name <a@b.com>", "a@b.com\r\nBcc: x@y.com", "a b@c.com", ".a@b.com", "a..b@c.com", "a@-b.com", 42, null]) {
    assert.equal(singleAddress(bad), null, String(bad));
  }
});

test("gmail: the message has one To, a one line subject and the body intact", () => {
  const raw = buildRaw({ from: "me@shop.com", to: "you@site.com", subject: "Hi there\r\nBcc: evil@x.com", body: "Line one\nLine two é" });
  const text = decode(raw);
  const [head, body] = text.split("\r\n\r\n");
  assert.match(head, /^From: me@shop\.com\r\nTo: you@site\.com\r\nSubject: Hi there Bcc: evil@x\.com\r\n/);
  assert.doesNotMatch(head, /^Bcc:/m);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), "Line one\r\nLine two é");
  const utf = decode(buildRaw({ from: "a@b.com", to: "c@d.com", subject: "Café", body: "x" }));
  assert.match(utf, /Subject: =\?UTF-8\?B\?Q2Fmw6k=\?=/);
});

test("gmail: only permission to send is asked for, with a small daily cap", () => {
  assert.deepEqual(GMAIL_OAUTH_SCOPES, ["openid", "email", "https://www.googleapis.com/auth/gmail.send"]);
  assert.ok(DAILY_SEND_CAP > 0 && DAILY_SEND_CAP <= 20);
});

test("gmail: a bad address or empty email is refused before anything is sent", async () => {
  let called = false;
  const send = async () => ((called = true), {});
  const r1 = await sendOneEmail("1", { prospectUrl: "https://x.com", to: "a@b.com, c@d.com", subject: "s", body: "b" }, send);
  assert.equal(r1.ok, false);
  const r2 = await sendOneEmail("1", { prospectUrl: "https://x.com", to: "a@b.com", subject: " ", body: "b" }, send);
  assert.equal(r2.ok, false);
  assert.equal(called, false);
});

test("gmail: only the owner's own Google account can be attached", () => {
  assert.equal(sameOwner("Owner@Shop.com", ["owner@shop.com", null]), true);
  assert.equal(sameOwner("owner@shop.com", [null, "Owner@shop.com "]), true);
  assert.equal(sameOwner("stranger@gmail.com", ["owner@shop.com", "owner@gmail.com"]), false);
  assert.equal(sameOwner("a@b.com", [null, undefined]), false);
});
