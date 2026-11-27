import { test } from "node:test";
import assert from "node:assert/strict";
import { CONVERSION_RULES, COPY_RULES, OUTREACH_RULES, headlineProblem, MAX_HEADLINE_WORDS, wordCount } from "../src/lib/analytics/autopilot/writer";

test("copy rules: the frameworks, the 2 second rule, the headline limit and no medical claims are all in the rules", () => {
  for (const must of ["2 seconds", "what the business offers and the problem it solves", "10 words or fewer", "StoryBrand", "without [painful trade off]", "Audience + category + outcome + differentiator", "We help [who] get [result] without [worry]", "No medical claims", "may help", "Never round up, never invent", "Article titles, informational sections and FAQs follow the search"]) {
    assert.ok(COPY_RULES.includes(must), must);
  }
  assert.ok(!/[–—]/.test(COPY_RULES));
});

test("copy rules: headline word count", () => {
  assert.equal(MAX_HEADLINE_WORDS, 10);
  assert.equal(wordCount("Better sleep, focus and energy."), 5);
  assert.equal(wordCount("  Clean   supplements, nothing hidden. "), 4);
  assert.ok(wordCount("Clean supplements for better sleep, focus and energy, without guessing what is inside.") > MAX_HEADLINE_WORDS);
});

test("copy rules: separators are not words, and an 11 word headline is refused", () => {
  assert.equal(wordCount("Sleep & Calm | Brand"), 3);
  assert.equal(headlineProblem("Tired, wired or foggy? Supplements that support all three."), null);
  assert.equal(headlineProblem("one two three four five six seven eight nine ten eleven"), "The headline is longer than 10 words.");
});

test("newsletter checks: the local checks get the plain text, so a draft opening with Imagine is still caught", async () => {
  const { newsletterCheckText } = await import("../src/lib/analytics/newsletter");
  const { hasAiTell } = await import("../src/lib/analytics/autopilot/writer");
  const d = { subject: "Imagine sleeping through the night", preview: "p", headline: "h", paras: ["x"] };
  assert.ok(newsletterCheckText(d).startsWith("Imagine"));
  assert.ok(hasAiTell(newsletterCheckText(d)));
  assert.ok(newsletterCheckText(d, true).includes("Headline: h"));
});

test("conversion rules: research the customer's words, product page anatomy, direct response, one change at a time", () => {
  for (const must of ["customers' own words", "never invent a quote", "beside the buy button", "never written into a product page draft", "one clear button", "one problem, one benefit", "no medical claims", "one change per page at a time", "evidence, not proof"]) {
    assert.ok(CONVERSION_RULES.includes(must), must);
  }
  assert.ok(!/[\u2013\u2014]/.test(CONVERSION_RULES));
});

test("outreach rules: a real reason, about them, short, an easy yes or no question, respectful follow ups, a no is respected", () => {
  for (const must of ["real, specific reason", "Never fake familiarity", "about them", "under 120 words", "yes or no", "never a request for a meeting", "follow up adds something new", "stop", "Never argue with an objection"]) {
    assert.ok(OUTREACH_RULES.includes(must), must);
  }
  assert.ok(!/[\u2013\u2014]/.test(OUTREACH_RULES));
});
