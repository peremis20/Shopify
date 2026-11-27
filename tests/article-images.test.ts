import { test } from "node:test";
import assert from "node:assert/strict";
import { bestProductImage, distinctiveWords } from "../src/lib/analytics/autopilot/article-images";

const p = (title: string, imageUrl: string | null = `https://cdn.example.com/${encodeURIComponent(title)}.jpg`, imageAlt: string | null = null) => ({ title, imageUrl, imageAlt });

const store = [
  p("Acme Magnesium Glycinate 60 Capsules"),
  p("Acme Magnesium L-Threonate 90 Count", undefined, "Acme Magnesium L-Threonate bottle"),
  p("Acme Vitamin D3 + K2 Daily Complex"),
  p("Acme Ashwagandha KSM-66 Supplement"),
  p("Acme Sleep Bundle: Magnesium Glycinate + Ashwagandha"),
];

test("sizes, counts, generic words and the brand are not distinctive", () => {
  assert.deepEqual(distinctiveWords("Acme Magnesium Glycinate 60 Capsules", new Set(["acme"])), ["magnesium", "glycinate"]);
  assert.deepEqual(distinctiveWords("Zinc 50mg Daily Supplement 90 Count"), ["zinc"]);
});

test("a magnesium threonate article picks the magnesium threonate product, with its alt text", () => {
  const img = bestProductImage(store, "<p>Magnesium threonate crosses into the brain. Threonate is studied for memory and sleep.</p>", {
    title: "Magnesium Threonate Benefits",
    brand: "Acme",
  });
  assert.ok(img);
  assert.match(img.url, /Threonate/);
  assert.equal(img.altText, "Acme Magnesium L-Threonate bottle");
});

test("a general magnesium article picks a magnesium product, and the alt text falls back to the title", () => {
  const img = bestProductImage(store, "<p>Which magnesium is best? Glycinate is gentle on the stomach.</p>", { title: "Which Magnesium Is Best", brand: "Acme" });
  assert.ok(img);
  assert.match(img.altText, /Magnesium Glycinate/);
});

test("a single product goes before a bundle when the scores tie", () => {
  const img = bestProductImage([p("Sleep Bundle: Magnesium Glycinate"), p("Magnesium Glycinate")], "magnesium glycinate benefits", { title: "Magnesium glycinate" });
  assert.equal(img?.altText, "Magnesium Glycinate");
});

test("an article about jet lag with no product match returns null", () => {
  assert.equal(bestProductImage(store, "<p>Jet lag fades faster with morning light and a steady schedule on arrival.</p>", { title: "How to Beat Jet Lag", brand: "Acme" }), null);
});

test("the brand name alone is not a match", () => {
  assert.equal(bestProductImage(store, "<p>At Acme we care about travel. Acme ships worldwide.</p>", { title: "Acme travel tips", brand: "Acme" }), null);
});

test("products without an image are never picked", () => {
  assert.equal(bestProductImage([p("Magnesium Threonate", null)], "magnesium threonate", { title: "Magnesium threonate" }), null);
});
