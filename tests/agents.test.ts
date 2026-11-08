/**
 * Tests for the agents added on top of the autopilot: the Site Auditor's page checks, the Outreach Drafter's picks
 * (queue, failed sites), the business profile in the writer's brief, and Gemini's schema form. Every case here was a
 * real mistake found in review, so none can come back unnoticed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isArticle, pageIssues } from "../src/lib/analytics/autopilot/site-audit";
import { pickForDrafts } from "../src/lib/analytics/autopilot/backlinks";
import { siteBrief } from "../src/lib/analytics/profile";
import { toGeminiSchema } from "../src/lib/analytics/autopilot/writer";

const page = (head: string, body: string) => `<html><head>${head}</head><body>${body}</body></html>`;
const codes = (r: ReturnType<typeof pageIssues>) => r.issues.map((i) => i.code).sort();

test("audit: a sound page has no problems", () => {
  const html = page(
    `<title>Magnesium for sleep: what helps | Peremis</title><meta name="description" content="How magnesium may support sleep."><link rel="canonical" href="https://shop.com/blogs/tips/magnesium-sleep/">`,
    `<main><h1>Magnesium for sleep</h1><p>${"word ".repeat(400)}</p><img src="a.jpg" alt=""></main>`,
  );
  assert.deepEqual(codes(pageIssues("https://shop.com/blogs/tips/magnesium-sleep", 200, html)), []);
});

test("audit: decorative images (alt empty) are fine; images with no alt are noted but never sent to the autopilot", () => {
  const html = page(`<title>A good clear page title</title><meta name="description" content="d">`, `<main><h1>H</h1><img src="a.jpg"></main>`);
  const alt = pageIssues("https://shop.com/pages/about", 200, html).issues.find((i) => i.code === "alt");
  assert.ok(alt);
  assert.equal(alt.auto, false);
});

test("audit: missing title, description and heading; noindex; canonical elsewhere; thin article", () => {
  const html = page(`<meta name="robots" content="noindex"><link rel="canonical" href="https://shop.com/other">`, `<main><p>short</p></main>`);
  assert.deepEqual(codes(pageIssues("https://shop.com/blogs/tips/a-post", 200, html)), ["canonical", "description-missing", "h1-missing", "noindex", "thin", "title-missing"].sort());
});

test("audit: www, http and a trailing slash in the canonical are the same page", () => {
  const html = page(`<title>A good clear page title</title><meta name="description" content="d"><link rel="canonical" href="http://www.shop.com/pages/about/">`, `<main><h1>H</h1></main>`);
  assert.ok(!codes(pageIssues("https://shop.com/pages/about", 200, html)).includes("canonical"));
});

test("audit: a broken page is one problem only a person can fix", () => {
  const r = pageIssues("https://shop.com/pages/gone", 404, "");
  assert.deepEqual(codes(r), ["error"]);
  assert.equal(r.issues[0].auto, false);
});

test("audit: only single articles count as articles, not blog listings or tag pages", () => {
  assert.ok(isArticle("https://shop.com/blogs/news/my-post"));
  assert.ok(isArticle("https://site.com/blog/my-post"));
  assert.ok(!isArticle("https://shop.com/blogs/news"));
  assert.ok(!isArticle("https://shop.com/blogs/news/tagged/sleep"));
  assert.ok(!isArticle("https://site.com/blog/page/2"));
});

const prospect = (url: string, kind: string, authority: number | null, extra: Record<string, unknown> = {}) =>
  ({ url, domain: url, title: "", snippet: "", kind, topic: "sleep", authority, status: "new", foundAt: "", ...extra }) as never;

test("drafter: sites the Strategist queued come first, even when three emails already wait", () => {
  const draft = { draft: { subject: "s", body: "b", to: null, at: "" } };
  const list = { updatedAt: "", prospects: [prospect("a", "broken", 9), prospect("b", "resource", 1), prospect("w1", "mention", 1, draft), prospect("w2", "mention", 1, draft), prospect("w3", "mention", 1, draft)] };
  assert.deepEqual(pickForDrafts(list, 3, ["b"]).map((p) => p.url), ["b"]);
});

test("drafter: a site whose email couldn't be written safely is skipped for a week", () => {
  const list = { updatedAt: "", prospects: [prospect("a", "broken", 9, { draftTriedAt: new Date().toISOString() }), prospect("b", "resource", 1)] };
  assert.deepEqual(pickForDrafts(list).map((p) => p.url), ["b"]);
  const old = { updatedAt: "", prospects: [prospect("a", "broken", 9, { draftTriedAt: new Date(Date.now() - 8 * 864e5).toISOString() })] };
  assert.deepEqual(pickForDrafts(old).map((p) => p.url), ["a"]);
});

test("profile: the business description reaches the writer's brief; an empty one adds nothing", () => {
  const base = { brandName: "Peremis", businessType: "supplements" as const, siteDomain: "peremis.com", gaExcludeHosts: [], onboardingDismissed: false, platform: null, suggestedTypes: [], suggestedRead: false };
  const withAbout = siteBrief({ ...base, about: { offer: "Third party tested supplements", audience: "", difference: "", tone: "warm", location: "" }, aboutSource: "auto" });
  assert.match(withAbout.about ?? "", /What it offers: Third party tested supplements/);
  assert.match(withAbout.about ?? "", /How it talks: warm/);
  assert.equal(siteBrief({ ...base, about: null, aboutSource: null }).about, undefined);
});

test("gemini schema: a field that may be null becomes one type with nullable", () => {
  const out = toGeminiSchema({ type: "object", properties: { page: { type: ["string", "null"] }, n: { type: "number" } } }) as {
    type: string;
    properties: { page: { type: string; nullable?: boolean }; n: { type: string } };
  };
  assert.equal(out.type, "OBJECT");
  assert.deepEqual(out.properties.page, { type: "STRING", nullable: true });
  assert.equal(out.properties.n.type, "NUMBER");
});
