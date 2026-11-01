import { test } from "node:test";
import assert from "node:assert/strict";
import { addressIn, buildReply, htmlToText, replyRecipients, replySubject, seal, sign, textOf, unseal, verify } from "../inbox-app/core";

const S = "x".repeat(40);
const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

test("inbox: sealed logins open only with the same secret", () => {
  const v = seal("refresh-token", S);
  assert.equal(unseal(v, S), "refresh-token");
  assert.equal(unseal(v, "y".repeat(40)), null);
  assert.equal(unseal(v.slice(0, -2) + "AA", S), null);
});

test("inbox: signed tokens reject tampering and expiry", () => {
  const t = sign({ email: "a@b.com" }, S, 60);
  assert.equal(verify<{ email: string }>(t, S)?.email, "a@b.com");
  assert.equal(verify(t.replace(/^./, "x"), S), null);
  assert.equal(verify(sign({ email: "a@b.com" }, S, -1), S), null);
  assert.equal(verify(t, "z".repeat(40)), null);
});

test("inbox: a reply goes from the inbox to the sender, never to itself", () => {
  const r = replyRecipients("info@peremis.com", { from: '"Ann" <ann@x.com>', to: "info@peremis.com, bob@y.com", cc: "INFO@peremis.com, cat@z.com" }, true);
  assert.deepEqual(r, { to: ["ann@x.com"], cc: ["bob@y.com", "cat@z.com"] });
  assert.deepEqual(replyRecipients("info@peremis.com", { from: "ann@x.com", replyTo: "help@x.com" }, false), { to: ["help@x.com"], cc: [] });
  assert.deepEqual(replyRecipients("info@peremis.com", { from: "info@peremis.com", to: "ann@x.com" }, false), { to: ["ann@x.com"], cc: [] });
});

test("inbox: headers can't be injected and threading headers are kept", () => {
  const raw = decode(buildReply({ from: "info@peremis.com", to: ["ann@x.com"], cc: [], subject: "Hello\r\nBcc: evil@x.com", inReplyTo: "<m1@x>", references: "<m0@x>", body: "Thanks!\nJimmy" }));
  const head = raw.split("\r\n\r\n")[0];
  assert.ok(!/^Bcc:/im.test(head), head);
  assert.match(head, /^Subject: Re: Hello Bcc: evil@x\.com$/m);
  assert.match(head, /^In-Reply-To: <m1@x>$/m);
  assert.match(head, /^References: <m0@x> <m1@x>$/m);
  assert.match(head, /^From: info@peremis\.com$/m);
  assert.equal(Buffer.from(raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8"), "Thanks!\r\nJimmy");
});

test("inbox: subjects get one Re: and non ASCII subjects are encoded", () => {
  assert.equal(replySubject("Re: Hi"), "Re: Hi");
  assert.equal(replySubject("Hi"), "Re: Hi");
  const raw = decode(buildReply({ from: "a@b.com", to: ["c@d.com"], cc: [], subject: "Café", inReplyTo: null, references: null, body: "x" }));
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m);
});

test("inbox: messages show as plain text only", () => {
  assert.equal(htmlToText("<p>Hi<script>alert(1)</script></p><p>A &amp; B</p>"), "Hi\nA & B");
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  assert.equal(textOf({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64("<b>x</b>") } }, { mimeType: "text/plain", body: { data: b64("plain") } }] }), "plain");
  assert.equal(addressIn('"Jane" <Jane@X.com>'), "jane@x.com");
  assert.equal(addressIn("not an address"), null);
});

import { encodeHeader, isEmail } from "../inbox-app/core";

test("inbox: long non ASCII subjects are split into short encoded words", () => {
  const h = encodeHeader("Réunion de l'équipe ".repeat(5));
  for (const w of h.split("\r\n ")) assert.ok(w.length <= 75, w);
  const back = h.split("\r\n ").map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8")).join("");
  assert.equal(back, "Réunion de l'équipe ".repeat(5).trim());
});

test("inbox: addresses are plain ASCII, IDN top level domains allowed", () => {
  assert.equal(isEmail("josé@exämple.de"), false);
  assert.equal(isEmail("ivan@shop.xn--p1ai"), true);
  assert.equal(isEmail("info@peremis.com"), true);
});

test("inbox: a message in another character set reads correctly", () => {
  const latin1 = Buffer.from([0x43, 0x61, 0x66, 0xe9]).toString("base64url"); // "Café" in ISO-8859-1
  assert.equal(textOf({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: 'text/plain; charset="ISO-8859-1"' }], body: { data: latin1 } }), "Café");
});
