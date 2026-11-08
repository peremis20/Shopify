/**
 * Site types for any niche: the likely types are read from a site's own pages,
 * health rules apply only to health sites, and nothing assumes a health store
 * when the type isn't known yet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  allowsFaith,
  BUSINESS_TYPES,
  cleanTypes,
  DEFAULT_SELLS,
  guessBusinessTypes,
  healthRulesApply,
  isHealthSite,
  siteBrief,
} from "../src/lib/analytics/profile";

const textOf = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");

test("site types: DashPatrol's own home page reads as software, not health", () => {
  const html = readFileSync(new URL("../neon/insights/public/site/index.html", import.meta.url), "utf8");
  const types = guessBusinessTypes(textOf(html));
  assert.equal(types[0], "saas");
  assert.ok(!types.some((t) => isHealthSite(t)), `no health type for a SaaS site, got ${types.join(",")}`);
});

test("site types: a supplement store reads as supplements", () => {
  const text = "Shop our magnesium supplements and vitamin D capsules. 60 servings per container. Add to cart. Free shipping on orders over $50. Our probiotic supplement supports digestion.";
  assert.equal(guessBusinessTypes(text)[0], "supplements");
});

test("site types: a local plumber reads as a local service business", () => {
  const text = "Call us today for a free estimate. Licensed and insured plumbers serving Monroe and Charlotte. Book an appointment online. Our service area covers Union County.";
  assert.equal(guessBusinessTypes(text)[0], "local_service");
});

test("site types: no clear evidence suggests nothing (never a guess)", () => {
  assert.deepEqual(guessBusinessTypes("Welcome. Hello there."), []);
  assert.deepEqual(guessBusinessTypes(""), []);
});

test("site types: suggestions keep known ids only, in order, at most four", () => {
  assert.deepEqual(cleanTypes(["saas", "nope", "saas", "agency", "blog", "ecommerce", "fashion"]), ["saas", "agency", "blog", "ecommerce"]);
  assert.deepEqual(cleanTypes("saas,,mobile_app"), ["saas", "mobile_app"]);
  assert.deepEqual(cleanTypes(null), []);
});

test("site types: every original id still exists, so saved sites keep their type", () => {
  for (const id of ["supplements", "skincare", "fitness", "health_store", "practice", "publisher", "faith_health", "other"]) {
    assert.ok(BUSINESS_TYPES.some((b) => b.id === id), id);
  }
  assert.equal(new Set(BUSINESS_TYPES.map((b) => b.id)).size, BUSINESS_TYPES.length, "ids are unique");
});

test("site types: health claim rules apply to health sites only", () => {
  assert.equal(isHealthSite("supplements"), true);
  assert.equal(isHealthSite("faith_health"), true);
  assert.equal(isHealthSite("saas"), false);
  assert.equal(isHealthSite("other_business"), false);
  assert.equal(isHealthSite(null), false);
});

test("site types: an unknown type never makes the writer assume a health store", () => {
  const brief = siteBrief({
    brandName: "DashPatrol", businessType: null, siteDomain: "dashpatrol.io", gaExcludeHosts: [], onboardingDismissed: false,
    platform: "custom", about: null, aboutSource: null, suggestedTypes: [], suggestedRead: false,
  });
  assert.equal(brief.sells, DEFAULT_SELLS);
  assert.doesNotMatch(brief.sells, /health|wellness/);
});

test("site types: faith topics fit a church or a faith and health publication", () => {
  assert.equal(allowsFaith("nonprofit"), true);
  assert.equal(allowsFaith("faith_health"), true);
  assert.equal(allowsFaith("saas"), false);
});

test("site types: health rules stay on until the site is known not to be a health site", () => {
  const p = (businessType: string | null, suggestedTypes: string[], suggestedRead: boolean) =>
    healthRulesApply({ businessType: businessType as never, suggestedTypes: suggestedTypes as never, suggestedRead });
  assert.equal(p("saas", [], true), false);
  assert.equal(p("supplements", [], true), true);
  assert.equal(p(null, [], false), true, "not read yet: a health store that skipped setup keeps its guardrail");
  assert.equal(p(null, [], true), true, "read but unclear: stays on");
  assert.equal(p(null, ["saas", "agency"], true), false, "read as software: off");
  assert.equal(p(null, ["ecommerce", "supplements"], true), true, "any health suggestion: on");
});

test("site types: weak words alone don't suggest a type", () => {
  assert.deepEqual(guessBusinessTypes("Big sale on our platform. Read the news about our strategy and upcoming tax changes."), []);
});
