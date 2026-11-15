import { test } from "node:test";
import assert from "node:assert/strict";
import { pageKind, pickLanding, type LandingCandidate } from "../src/lib/analytics/landing";
import { taggedUrl, threadsText } from "../src/lib/analytics/threads";
import { facebookText } from "../src/lib/analytics/facebook";

const calm = "A calm guide to an evening routine with plain, everyday steps.";
const product = (slug: string, title: string, text = calm): LandingCandidate => ({ url: `https://shop.com/products/${slug}`, title: `${title} | ShopCo`, h1: title, text, kind: "product" });
const landing = (slug: string, h1: string, text = calm): LandingCandidate => ({ url: `https://shop.com/pages/${slug}`, title: `${h1} | ShopCo`, h1, text, kind: "landing" });

test("landing: pages and products are told apart by their address", () => {
  assert.equal(pageKind("https://shop.com/products/magnesium-glycinate"), "product");
  assert.equal(pageKind("https://shop.com/pages/sleep"), "landing");
  assert.equal(pageKind("https://shop.com/blogs/news/sleep"), null);
});

test("landing: a glycinate post goes to the glycinate product, or to a landing page that is about glycinate", () => {
  const all = [product("magnesium-glycinate", "Magnesium Glycinate"), product("magnesium-threonate", "Magnesium Threonate"), landing("sleep", "Magnesium Glycinate")];
  assert.equal(pickLanding("magnesium glycinate", all, "ShopCo").url, "https://shop.com/products/magnesium-glycinate");
  assert.equal(pickLanding("Magnesium glycinates", [landing("sleep", "Magnesium Glycinate")], "ShopCo").url, "https://shop.com/pages/sleep");
  // Sizes and forms don't change which product it is.
  assert.equal(pickLanding("magnesium glycinate", [product("magnesium-glycinate-120-capsules", "Magnesium Glycinate 120 Capsules")], "ShopCo").url, "https://shop.com/products/magnesium-glycinate-120-capsules");
});

test("landing: a threonate post never goes to a glycinate page, and a page that adds another variant is never used", () => {
  const all = [product("magnesium-glycinate", "Magnesium Glycinate"), landing("sleep", "Magnesium Glycinate")];
  assert.equal(pickLanding("magnesium threonate", all, "ShopCo").url, null);
  const blend = [product("magnesium-threonate", "Magnesium Threonate"), landing("blend", "Magnesium Glycinate and Threonate")];
  assert.equal(pickLanding("magnesium glycinate", blend, "ShopCo").url, null);
  // A product with another word in its own name is another product.
  assert.equal(pickLanding("magnesium glycinate", [product("magnesium-glycinate-zinc", "Magnesium Glycinate Zinc")], "ShopCo").url, null);
});

test("landing: a page with risky wording isn't linked; the article is used and the wording is noted for the owner", () => {
  const risky = landing("sleep", "Magnesium Glycinate", "Our magnesium glycinate cures insomnia for good.");
  const out = pickLanding("magnesium glycinate", [risky], "ShopCo");
  assert.equal(out.url, null);
  assert.equal(out.blocked[0].url, "https://shop.com/pages/sleep");
  assert.ok(out.blocked[0].phrases.some((p) => /cures insomnia/i.test(p)));
  // A clean matching page is used instead when there is one.
  assert.equal(pickLanding("magnesium glycinate", [risky, product("magnesium-glycinate", "Magnesium Glycinate")], "ShopCo").url, "https://shop.com/products/magnesium-glycinate");
});

test("landing: with nothing matching exactly, the post links to the article, tagged the same way", () => {
  assert.equal(pickLanding("chamomile tea", [product("magnesium-glycinate", "Magnesium Glycinate")], "ShopCo").url, null);
  assert.equal(pickLanding("", [product("magnesium-glycinate", "Magnesium Glycinate")], "ShopCo").url, null);
  const kit = { linkedin: "", facebook: "Read the guide https://shop.com/blogs/news/mg", instagram: "", x: "Read the guide https://shop.com/blogs/news/mg", video: { hook: "", script: "", caption: "" } };
  const item = { url: "https://shop.com/blogs/news/mg", kit };
  assert.ok(threadsText(item).endsWith(taggedUrl(item.url)));
  const target = "https://shop.com/products/magnesium-glycinate";
  const t = threadsText(item, target);
  assert.ok(t.endsWith(taggedUrl(target)));
  assert.ok(!t.includes("/blogs/news/mg"));
  const f = facebookText(item, target);
  assert.ok(f.endsWith(taggedUrl(target, "facebook")));
  assert.ok(!f.includes("/blogs/news/mg"));
});
