import { test } from "node:test";
import assert from "node:assert/strict";
import { addressIn, buildReply, decodeEntities, htmlOf, htmlToText, replyRecipients, replySubject, seal, sign, textOf, unseal, verify } from "../inbox-app/core";

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

test("inbox: the designed (HTML) part of an email is found for the sandboxed view", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: b64("Balance alert") } },
      { mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: { data: b64("<h1>Balance alert</h1><p>$42.10</p>") } },
    ],
  };
  assert.equal(htmlOf(payload), "<h1>Balance alert</h1><p>$42.10</p>");
  assert.equal(htmlOf({ mimeType: "text/plain", body: { data: b64("hi") } }), null);
});

test("inbox: character codes in previews and text are decoded", () => {
  assert.equal(decodeEntities("It&#39;s Jimmy&#8217;s &amp; Co &#x2019;"), "It's Jimmy’s & Co ’");
  assert.equal(decodeEntities("&bogus; &#0;"), "&bogus; &#0;");
  assert.equal(htmlToText("<p>Tom&#8217;s&nbsp;order</p>"), "Tom’s order");
});

import {
  attachmentsOf,
  buildMessage,
  citedCids,
  contentDisposition,
  forwardBody,
  forwardSubject,
  inlineImages,
  mailQuery,
  parseAddressList,
  partById,
  quoteOriginal,
  rewriteCids,
  safeFilename,
  threadAction,
} from "../inbox-app/core";

const bodyOf = (raw: string) => Buffer.from(decode(raw).split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");

test("inbox: a new message keeps its subject, has no threading headers and can't inject headers", () => {
  const raw = decode(buildMessage({ from: "info@peremis.com", to: ["ann@x.com", "bob@y.com"], cc: ["cat@z.com"], subject: "Hi\nBcc: evil@x.com", body: "Line 1\nLine 2" }));
  const head = raw.split("\r\n\r\n")[0];
  assert.match(head, /^Subject: Hi Bcc: evil@x\.com$/m);
  assert.ok(!/^Bcc:/im.test(head));
  assert.ok(!/^In-Reply-To:/im.test(head) && !/^References:/im.test(head));
  assert.match(head, /^To: ann@x\.com, bob@y\.com$/m);
  assert.match(head, /^Cc: cat@z\.com$/m);
  assert.equal(bodyOf(buildMessage({ from: "a@b.com", to: ["c@d.com"], cc: [], subject: "x", body: "Line 1\nLine 2" })), "Line 1\r\nLine 2");
});

test("inbox: replies quote the original and forwards carry it", () => {
  assert.equal(quoteOriginal("Hello\n\n> old\nBye\n", "Ann <ann@x.com>", "Mon, 2 Nov 2026"), "On Mon, 2 Nov 2026, Ann <ann@x.com> wrote:\n> Hello\n>\n>> old\n> Bye");
  assert.equal(quoteOriginal("x", "A\r\nBcc: e@x.com", "d"), "On d, A Bcc: e@x.com wrote:\n> x");
  assert.equal(forwardSubject("Hello"), "Fwd: Hello");
  assert.equal(forwardSubject("FW: Hello"), "FW: Hello");
  const f = forwardBody("See below", { from: "Ann <ann@x.com>", date: "d", subject: "Hi", to: "me@y.com", text: "Body" });
  assert.match(f, /^See below\n\nBegin forwarded message:\n\nFrom: Ann <ann@x\.com>\nDate: d\nSubject: Hi\nTo: me@y\.com\n\nBody$/);
  assert.ok(forwardBody("", { from: "a", date: "d", subject: "s", to: "t", text: "b" }).startsWith("Begin forwarded message:"));
});

test("inbox: typed addresses are checked and nothing else gets through", () => {
  assert.deepEqual(parseAddressList("ann@x.com, Bob <BOB@y.com>; ann@x.com\ncat@z.com"), { ok: ["ann@x.com", "bob@y.com", "cat@z.com"], bad: [] });
  assert.deepEqual(parseAddressList("ann@x.com, nope").bad, ["nope"]);
  // Only bare addresses come out, so nothing typed can add a header line.
  for (const e of parseAddressList("evil@x.com\r\nBcc: z@q.com").ok) assert.match(e, /^[^\s:]+@[^\s:]+$/);
  assert.deepEqual(parseAddressList(""), { ok: [], bad: [] });
});

test("inbox: folders and search build one Gmail query", () => {
  assert.equal(mailQuery("inbox", false, ""), "in:inbox");
  assert.equal(mailQuery("trash", true, "invoice"), "in:trash is:unread (invoice)");
  assert.equal(mailQuery("starred", false, "a\nb"), "is:starred (a b)");
  assert.equal(mailQuery("constructor", false, ""), "in:inbox");
  assert.equal(mailQuery("sent", false, "  "), "in:sent");
  assert.deepEqual(threadAction("trash", "t1"), { path: "threads/t1/trash" });
  assert.deepEqual(threadAction("untrash", "t1"), { path: "threads/t1/untrash" });
  assert.deepEqual(threadAction("star", "t1"), { path: "threads/t1/modify", body: { addLabelIds: ["STARRED"] } });
  assert.equal(threadAction("delete", "t1"), null);
});

test("inbox: inline cid images become data addresses and the rest is listed as attachments", () => {
  const payload = {
    partId: "",
    mimeType: "multipart/related",
    parts: [
      { partId: "0", mimeType: "text/html", body: { data: "x" } },
      { partId: "1", mimeType: "image/png", filename: "logo.png", headers: [{ name: "Content-ID", value: "<Logo@X>" }], body: { attachmentId: "att1", size: 10 } },
      { partId: "2", mimeType: "application/octet-stream", filename: "pic.JPG", headers: [{ name: "Content-ID", value: "<pic@x>" }], body: { attachmentId: "att2", size: 20 } },
      { partId: "3", mimeType: "application/pdf", filename: "../../Invoice\r\n.pdf", body: { attachmentId: "att3", size: 3000 } },
      { partId: "4", mimeType: "text/html", headers: [{ name: "Content-ID", value: "<page@x>" }], body: { attachmentId: "att4" } },
    ],
  };
  const imgs = inlineImages(payload);
  assert.deepEqual(imgs.map((i) => [i.cid, i.type, i.attachmentId]), [["logo@x", "image/png", "att1"], ["pic@x", "image/jpeg", "att2"]]);
  const html = `<img src="cid:logo@x"><img src='CID:Logo%40X'><div style="background:url(cid:pic@x)"></div><img src="cid:missing">`;
  assert.deepEqual([...citedCids(html)], ["logo@x", "pic@x", "missing"]);
  const out = rewriteCids(html, new Map([["logo@x", "data:image/png;base64,AAA="]]));
  assert.equal(out, `<img src="data:image/png;base64,AAA="><img src='data:image/png;base64,AAA='><div style="background:url(cid:pic@x)"></div><img src="cid:missing">`);
  assert.deepEqual(attachmentsOf(payload, new Set(["logo@x"])), [{ part: "2", name: "pic.JPG", size: 20 }, { part: "3", name: "_.._Invoice.pdf", size: 3000 }]);
  assert.equal(partById(payload, "3")?.body?.attachmentId, "att3");
  assert.equal(partById(payload, "9"), null);
});

test("inbox: download names are safe", () => {
  assert.equal(safeFilename("../../etc/passwd"), "_.._etc_passwd");
  assert.equal(safeFilename('a"b<c>.txt'), "a_b_c_.txt");
  assert.equal(safeFilename("\u0000\n"), "attachment");
  assert.equal(safeFilename(".htaccess"), "htaccess");
  const long = safeFilename("x".repeat(300) + ".pdf");
  assert.equal(long.length, 150);
  assert.ok(long.endsWith(".pdf"));
  const cd = contentDisposition('Résumé "final"; x.pdf');
  assert.match(cd, /^attachment; filename="R_sum_ _final__ x\.pdf"; filename\*=UTF-8''R%C3%A9sum%C3%A9%20_final_%3B%20x\.pdf$/);
  assert.ok(!/[\r\n]/.test(contentDisposition("a\r\nSet-Cookie: x")));
});

import {
  groupSenders as gs,
  isOneClick,
  isPrivateIp,
  parseListUnsubscribe,
  parseMailto,
  ruleQueries,
  ruleSender,
  safeUnsubUrl,
  senderMatches,
  senderTotals,
  unsubscribePlan,
} from "../inbox-app/core";

test("inbox: List-Unsubscribe gives its https and mailto addresses", () => {
  const h = "<mailto:leave@news.shop.com?subject=unsub>, <https://news.shop.com/u?id=1>,\r\n <http://plain.com/u>";
  assert.deepEqual(parseListUnsubscribe(h), { https: ["https://news.shop.com/u?id=1"], mailto: ["mailto:leave@news.shop.com?subject=unsub"] });
  assert.deepEqual(parseListUnsubscribe(undefined), { https: [], mailto: [] });
  assert.ok(isOneClick("List-Unsubscribe=One-Click"));
  assert.ok(!isOneClick("List-Unsubscribe=Other"));
  assert.equal(unsubscribePlan(h, "List-Unsubscribe=One-Click")?.kind, "post");
  assert.equal(unsubscribePlan(h, undefined)?.kind, "mailto");
  assert.equal(unsubscribePlan("<https://news.shop.com/u>", undefined)?.kind, "link");
  assert.equal(unsubscribePlan("<https://127.0.0.1/u>", "List-Unsubscribe=One-Click"), null);
  assert.equal(unsubscribePlan("<http://news.shop.com/u>", "List-Unsubscribe=One-Click"), null);
});

test("inbox: mailto unsubscribe links become a safe email", () => {
  assert.deepEqual(parseMailto("mailto:leave@x.com?subject=Unsubscribe%20me&body=please"), { to: "leave@x.com", subject: "Unsubscribe me", body: "please" });
  assert.deepEqual(parseMailto("mailto:LEAVE@x.com"), { to: "leave@x.com", subject: "Unsubscribe", body: "Unsubscribe" });
  assert.equal(parseMailto("mailto:?subject=x"), null);
  assert.equal(parseMailto("https://x.com"), null);
  const evil = parseMailto("mailto:a@x.com%0D%0ABcc:evil@y.com?subject=hi%0D%0ABcc:%20evil@y.com");
  assert.equal(evil, null);
  const inj = parseMailto("mailto:a@x.com?subject=hi%0D%0ABcc:%20evil@y.com");
  assert.equal(inj?.subject, "hi Bcc: evil@y.com");
  const raw = decode(buildReply({ from: "info@peremis.com", to: [inj!.to], cc: [], subject: inj!.subject, inReplyTo: null, references: null, body: inj!.body }));
  assert.ok(!/^Bcc:/im.test(raw.split("\r\n\r\n")[0]));
});

test("inbox: senders are grouped per inbox, counted and sorted", () => {
  const g = gs([
    { inboxId: "1", from: '"Shop" <news@shop.com>', date: 10, listUnsubscribe: "<https://shop.com/u>", listUnsubscribePost: "List-Unsubscribe=One-Click" },
    { inboxId: "1", from: "NEWS@shop.com", date: 30 },
    { inboxId: "1", from: "ann@x.com", date: 20 },
    { inboxId: "2", from: "news@shop.com", date: 5 },
    { inboxId: "1", from: "info@peremis.com", date: 40, self: "info@peremis.com" },
    { inboxId: "1", from: "not an address", date: 50 },
  ]);
  assert.deepEqual(g.map((x) => [x.inboxId, x.address, x.count, x.last, x.unsub, x.name]), [
    ["1", "news@shop.com", 2, 30, "post", "Shop"],
    ["1", "ann@x.com", 1, 20, null, ""],
    ["2", "news@shop.com", 1, 5, null, ""],
  ]);
  assert.deepEqual(senderTotals(g), { total: 4, unsubscribable: 2 });
});

test("inbox: rules match an exact address or a whole domain", () => {
  assert.equal(ruleSender(" News@Shop.com "), "news@shop.com");
  assert.equal(ruleSender("@Shop.com"), "@shop.com");
  assert.equal(ruleSender("shop.com"), null);
  assert.equal(ruleSender("@shop"), null);
  assert.equal(ruleSender("@-bad.com"), null);
  assert.equal(ruleSender("a@b.com) OR (x"), null);
  assert.ok(senderMatches("@shop.com", "a@shop.com"));
  assert.ok(!senderMatches("@shop.com", "a@mail.shop.com"));
  assert.ok(!senderMatches("@shop.com", "a@notshop.com"));
  assert.ok(senderMatches("a@shop.com", "A@shop.com"));
  assert.ok(!senderMatches("a@shop.com", "b@shop.com"));
  assert.deepEqual(ruleQueries(["a@x.com", "@shop.com", "bad", "a@x.com"], "newer_than:2d"), ["in:inbox newer_than:2d from:(a@x.com OR shop.com)"]);
  const many = ruleQueries(Array.from({ length: 45 }, (_, i) => `u${i}@x.com`));
  assert.equal(many.length, 3);
  assert.ok(many[0].startsWith("in:inbox from:(u0@x.com OR "));
  assert.equal(mailQuery("inbox", false, "", true), "in:inbox category:primary");
  assert.equal(mailQuery("sent", false, "", true), "in:sent");
});

test("inbox: the unsubscribe call never reaches private or internal hosts", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "2002:c0a8:0101::1", "nonsense"]) {
    assert.ok(isPrivateIp(ip), ip);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "142.250.80.46", "2607:f8b0:4004:800::200e"]) assert.ok(!isPrivateIp(ip), ip);
  assert.equal(safeUnsubUrl("https://news.shop.com/u?x=1"), "https://news.shop.com/u?x=1");
  for (const u of ["http://news.shop.com/u", "https://localhost/u", "https://127.0.0.1/u", "https://[::1]/u", "https://metadata.google.internal/x",
    "https://printer.local/x", "https://intranet/x", "https://user:pw@shop.com/u", "https://shop.com:8443/u", "https://0x7f000001/u", "https://2130706433/u", "javascript:alert(1)"]) {
    assert.equal(safeUnsubUrl(u), null, u);
  }
});
