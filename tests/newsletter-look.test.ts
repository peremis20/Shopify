import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEmail, cleanColor, cleanLogoUrl, draftBody, draftParagraphs, renderBody } from "../src/lib/analytics/newsletter";

test("email look: the first heading is the large title, later ones are section headings, numbered steps keep their bold number", () => {
  const r = renderBody("# You are not lazy\n\nIt is 3 p.m.\n\nTry this:\n\n1. Step outside\n2) Drink water\n\n# Later\n\n* a\n* b", undefined, "#5f3d7a");
  assert.ok(r.html.startsWith('<h1 style="font-size:40px'));
  assert.ok(r.html.includes("color:#5f3d7a"));
  assert.ok(r.html.includes("<h2"));
  assert.ok(r.html.includes("<strong style=\"color:#333333\">1.</strong> Step outside"));
  assert.ok(r.html.includes("<strong style=\"color:#333333\">2.</strong> Drink water"));
  assert.ok(r.html.includes("<ul"));
  assert.ok(r.text.startsWith("You are not lazy\n\n"));
  assert.ok(r.text.includes("1. Step outside\n2. Drink water"));
  assert.ok(r.text.includes("LATER"));
});

test("email look: a heading after the first block stays a section heading", () => {
  const r = renderBody("Hello there.\n\n# Section");
  assert.ok(!r.html.includes("<h1"));
  assert.ok(r.html.includes("<h2"));
});

test("email look: logo and color are checked and escaped", () => {
  assert.equal(cleanColor("#5F3D7A"), "#5f3d7a");
  assert.equal(cleanColor("red"), null);
  assert.equal(cleanColor("#fff;x"), null);
  assert.equal(cleanLogoUrl("http://x.com/a.png"), null);
  assert.equal(cleanLogoUrl('https://x.com/a.png" onerror="x'), null);
  assert.equal(cleanLogoUrl("https://cdn.x.com/logo.png?v=1"), "https://cdn.x.com/logo.png?v=1");
  const base = { from: "a@b.co", replyTo: null, to: "c@d.co", subject: "s", preview: "", body: "# T\n\nHi", brand: "B <x>", postalAddress: "1 Main", unsubscribe: "https://app/u" };
  const e = buildEmail({ ...base, logoUrl: "https://cdn.x.com/logo.png?v=1&w=2", color: "#5f3d7a" });
  const html = String(e.html);
  assert.ok(html.includes('src="https://cdn.x.com/logo.png?v=1&#38;w=2"'));
  assert.ok(html.includes('alt="B &#60;x&#62;"'));
  assert.ok(html.includes("color:#5f3d7a"));
  assert.ok(html.includes("Helvetica"));
  const plain = String(buildEmail({ ...base, logoUrl: "javascript:x", color: "bad" }).html);
  assert.ok(!plain.includes("<img"));
  assert.ok(plain.includes("color:#2b2a27"));
});

test("weekly draft: the AI's body becomes clean blocks, at most three steps, numbered in order", () => {
  const paras = draftParagraphs("It is 3 p.m. And then it hits.\nThe fog.\n\n# Try this:\n\n1. One\n3. Two\n4. Three\n5. Four\n\nRead more at https://x.com/a today.");
  assert.deepEqual(paras, ["It is 3 p.m. And then it hits. The fog.", "Try this:", "1. One\n2. Two\n3. Three", "Read more at today."]);
  const body = draftBody({ headline: "You are running on empty", paras, link: "https://x.com/a", brand: "Peremis" });
  assert.ok(body.startsWith("# You are running on empty\n\n"));
  assert.ok(body.endsWith("[Read the article](https://x.com/a)\n\nTalk soon,\nThe Peremis team"));
  assert.ok(!draftBody({ headline: "", paras: ["x"], link: "https://x.com", brand: "" }).includes("#"));
});
