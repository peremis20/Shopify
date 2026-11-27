import { test } from "node:test";
import assert from "node:assert/strict";
import { COPY_RULES, MAX_HEADLINE_WORDS, wordCount } from "../src/lib/analytics/autopilot/writer";

test("copy rules: the frameworks, the 2 second rule, the headline limit and no medical claims are all in the rules", () => {
  for (const must of ["2 seconds", "what the business offers and the problem it solves", "10 words or fewer", "StoryBrand", "without [painful trade off]", "Audience + category + outcome + differentiator", "We help [who] get [result] without [worry]", "No medical claims", "Never round up, never invent"]) {
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
