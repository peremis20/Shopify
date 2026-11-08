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

import { badText, fitView, ruleProblems, visibleText } from "../src/lib/analytics/autopilot/app-check";

const fullShape = { visits: true, plan: true, backlinks: true, keywords: true, pages: true, ranks: true, business: true, changes: true };
const emptyShape = { visits: false, plan: false, backlinks: false, keywords: false, pages: false, ranks: false, business: false, changes: false };

test("app check: leaked values and dashes in customer text are caught, addresses are not", () => {
  assert.equal(badText("Visits: NaN"), "a broken value");
  assert.equal(badText("Fix the page - now"), "a dash");
  assert.equal(badText("All good"), null);
  assert.deepEqual(visibleText({ url: "https://a-b.com/x-y", path: "/a-b", text: "ok" }), [{ path: "text", text: "ok" }]);
});

test("app check: a section empty long after connecting is flagged when most sites have it", () => {
  const peers = [{ shape: fullShape, age: 30 }, { shape: fullShape, age: 20 }];
  const okReport = { week: { changes: 1, articles: 0, links: 0, suggested: 0 }, visitors: null, focus: null, plan: [], traffic: [], totals: { visits: 0, leads: 0, revenue: 0 }, backlinks: null, agents: [], shopify: null } as never;
  const base = { report: okReport, reportError: null, reportMs: 100, conn: { ga: true, gsc: true }, verified: true, autopilotOn: true, peers };
  const ids = ruleProblems({ ...base, shape: { ...fullShape, backlinks: false }, age: 10 }).map((p) => p.id);
  assert.deepEqual(ids, ["app:empty:backlinks"]);
  // A brand new site is given time.
  assert.deepEqual(ruleProblems({ ...base, shape: emptyShape, age: 1 }), []);
  // Empty on most other sites too: it depends on the site, not a fault.
  assert.deepEqual(ruleProblems({ ...base, peers: [{ shape: emptyShape, age: 30 }], shape: emptyShape, age: 30 }), []);
  // With the autopilot off, the agents rightly leave their sections empty.
  assert.deepEqual(ruleProblems({ ...base, autopilotOn: false, shape: { ...fullShape, backlinks: false }, age: 30 }), []);
  // No other site to compare with: nothing is flagged.
  assert.deepEqual(ruleProblems({ ...base, peers: [], shape: emptyShape, age: 30 }), []);
  // On the free trial, the plan, backlinks and changes may stay empty.
  // A Report that failed to load is one finding, not one per empty section.
  assert.deepEqual(ruleProblems({ ...base, report: null, reportError: "boom", shape: emptyShape, age: 30 }).map((p) => p.id), ["app:report-fails"]);
  assert.deepEqual(ruleProblems({ ...base, verified: false, shape: { ...fullShape, backlinks: false, plan: false, changes: false }, age: 30 }), []);
});

test("app check: a report that fails, or reads a connected source as an error, is flagged", () => {
  const report = { week: { changes: 0, articles: 0, links: 0, suggested: 0 }, visitors: null, focus: null, plan: [], traffic: "error", totals: null, backlinks: null, agents: [], shopify: "error" } as const;
  const ids = ruleProblems({ report: report as never, reportError: null, reportMs: 100, conn: { ga: true, gsc: true }, verified: true, autopilotOn: true, shape: fullShape, age: 30, peers: [] }).map((p) => p.id);
  assert.deepEqual(ids, ["app:ga-unread", "app:shop-unread"]);
  assert.equal(ruleProblems({ report: null, reportError: "boom", reportMs: 100, conn: { ga: true, gsc: true }, verified: true, autopilotOn: true, shape: fullShape, age: 30, peers: [] })[0].id, "app:report-fails");
});

test("app check: broken numbers are caught and a long view is shortened, never cut midway", () => {
  assert.deepEqual(visibleText({ totals: { visits: NaN, leads: 3 } }), [{ path: "totals.visits", text: "NaN" }]);
  const view = { site: "x.com", report: { agents: Array.from({ length: 400 }, (_, i) => ({ agent: `a${i}`, did: "did a thing" })), plan: [] } };
  const out = fitView(view, 2000);
  assert.ok(out.length <= 2000);
  assert.deepEqual(JSON.parse(out).shortenedByChecker, ["report.agents"]);
});

import { cleanReport } from "../src/lib/analytics/autopilot/client-errors";

test("browser errors: the app's own problems are kept, extension noise and junk are not", () => {
  assert.deepEqual(cleanReport({ kind: "layout", message: "The page is 40px wider", where: "/#report", width: 390 }), { kind: "layout", message: "The page is 40px wider", where: "/#report", width: 390 });
  assert.equal(cleanReport({ kind: "script", message: "ResizeObserver loop limit exceeded" }), null);
  assert.equal(cleanReport({ kind: "evil", message: "x" }), null);
  assert.equal(cleanReport(null), null);
  assert.equal(cleanReport({ kind: "script", message: "x".repeat(900) })?.message.length, 500);
});
