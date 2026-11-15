import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionsArticle, pageKind, pickLanding, refreshNotes, type LandingCandidate } from "../src/lib/analytics/landing";

const calm = "A calm guide to an evening routine with plain, everyday steps.";
const product = (slug: string, title: string, text = calm): LandingCandidate => ({ url: `https://shop.com/products/${slug}`, title: `${title} | ShopCo`, h1: title, text, kind: "product" });
const landing = (slug: string, h1: string, text = calm): LandingCandidate => ({ url: `https://shop.com/pages/${slug}`, title: `${h1} | ShopCo`, h1, text, kind: "landing" });
const url = (topic: string, pages: LandingCandidate[], searches: string[] = []) => pickLanding(topic, pages, "ShopCo", searches).page?.url ?? null;

test("landing: pages and products are told apart by their address", () => {
  assert.equal(pageKind("https://shop.com/products/magnesium-glycinate"), "product");
  assert.equal(pageKind("https://shop.com/pages/sleep"), "landing");
  assert.equal(pageKind("https://shop.com/blogs/news/sleep"), null);
});

test("landing: a glycinate post goes to the glycinate product, or to a landing page that is about glycinate", () => {
  const all = [product("magnesium-glycinate", "Magnesium Glycinate"), product("magnesium-threonate", "Magnesium Threonate"), landing("sleep", "Magnesium Glycinate for Deep Sleep")];
  assert.equal(url("magnesium glycinate", all), "https://shop.com/products/magnesium-glycinate");
  // /pages/sleep about magnesium glycinate: general words (deep, sleep) after a glue word are fine.
  assert.equal(url("Magnesium glycinates", [landing("sleep", "Magnesium Glycinate for Deep Sleep")]), "https://shop.com/pages/sleep");
  assert.equal(url("magnesium glycinate", [landing("sleep", "Magnesium Glycinate for Deep Sleep")], ["magnesium threonate", "magnesium glycinate for sleep"]), "https://shop.com/pages/sleep");
  assert.equal(url("magnesium glycinate", [landing("guide", "The Best Magnesium Glycinate Guide")]), "https://shop.com/pages/guide");
  // Sizes don't change which product it is; a form the post names is fine.
  assert.equal(url("magnesium glycinate", [product("magnesium-glycinate-120-ct", "Magnesium Glycinate 120 ct")]), "https://shop.com/products/magnesium-glycinate-120-ct");
  assert.equal(url("magnesium glycinate capsules", [product("magnesium-glycinate-capsules", "Magnesium Glycinate Capsules")]), "https://shop.com/products/magnesium-glycinate-capsules");
});

test("landing: a threonate post never goes to a glycinate page", () => {
  assert.equal(url("magnesium threonate", [product("magnesium-glycinate", "Magnesium Glycinate"), landing("sleep", "Magnesium Glycinate for Deep Sleep")]), null);
});

test("landing: blends, comparisons and pages narrowed to a variant are never used, even with no product page read", () => {
  assert.equal(url("magnesium threonate", [landing("magnesium-threonate-glycinate-blend", "Magnesium Threonate Glycinate Blend")]), null);
  assert.equal(url("magnesium glycinate", [landing("magnesium-glycinate-blend", "Magnesium Glycinate Blend")]), null);
  assert.equal(url("magnesium threonate", [landing("magnesium-threonate-vs-glycinate", "Magnesium Threonate vs Glycinate")]), null);
  assert.equal(url("magnesium", [landing("magnesium-glycinate", "Magnesium Glycinate")]), null);
  assert.equal(url("magnesium glycinate", [landing("calm", "Magnesium Glycinate and Threonate")]), null);
  // "with" or "or" joining another variant is a combination too.
  assert.equal(url("magnesium threonate", [landing("focus", "Magnesium Threonate with Glycinate")]), null);
  assert.equal(url("magnesium threonate", [landing("magnesium-threonate-with-glycinate", "Focus")]), null);
  assert.equal(url("magnesium threonate", [landing("focus", "Magnesium Threonate or Glycinate")]), null);
  // A niche word the site's own searches use as a variant is not waved through as general.
  assert.equal(url("magnesium", [landing("magnesium-sleep", "Magnesium Sleep")], ["magnesium sleep"]), null);
  // A word the site's own searches put next to the topic is a variant.
  assert.equal(url("magnesium", [landing("calm", "Magnesium for calm evenings, with threonate")], ["magnesium threonate"]), null);
  // Another product's name word, and another form.
  assert.equal(url("magnesium", [product("zinc", "Zinc"), landing("calm", "Magnesium for Zinc Lovers")]), null);
  assert.equal(url("magnesium", [product("magnesium-oil", "Magnesium Oil")]), null);
  assert.equal(url("magnesium glycinate", [product("magnesium-glycinate-120-capsules", "Magnesium Glycinate 120 Capsules")]), null);
  assert.equal(url("magnesium glycinate", [product("magnesium-glycinate-zinc", "Magnesium Glycinate Zinc")]), null);
});

test("landing: a page with risky wording isn't linked, the article is used, and the note clears once it is fixed or gone", () => {
  const risky = landing("sleep", "Magnesium Glycinate", "Our magnesium glycinate cures insomnia for good.");
  const out = pickLanding("magnesium glycinate", [risky], "ShopCo");
  assert.equal(out.page, null);
  assert.equal(out.blocked[0].url, "https://shop.com/pages/sleep");
  assert.ok(out.blocked[0].phrases.some((p) => /cures insomnia/i.test(p)));
  assert.equal(url("magnesium glycinate", [risky, product("magnesium-glycinate", "Magnesium Glycinate")]), "https://shop.com/products/magnesium-glycinate");
  const notes = refreshNotes([], out.blocked, [risky], "t1");
  assert.equal(notes.length, 1);
  // Still risky: kept. Fixed: dropped. No longer read from the site: dropped.
  assert.equal(refreshNotes(notes, [], [risky], "t2").length, 1);
  assert.equal(refreshNotes(notes, [], [{ ...risky, text: calm }], "t2").length, 0);
  assert.equal(refreshNotes(notes, [], [], "t2").length, 0);
});

test("landing: with nothing matching exactly, the article is used; text about the article only links to the article", () => {
  assert.equal(url("chamomile tea", [product("magnesium-glycinate", "Magnesium Glycinate")]), null);
  assert.equal(url("", [product("magnesium-glycinate", "Magnesium Glycinate")]), null);
  assert.ok(mentionsArticle("Read the full article for more."));
  assert.ok(mentionsArticle("Our guide walks through it."));
  assert.ok(!mentionsArticle("A warm cup before bed is a calm way to end the day. Learn more."));
});
