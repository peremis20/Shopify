import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTopics } from "../src/lib/analytics/autopilot/backlinks";

const kw = (list: string[], source = 1) => list.map((keyword) => ({ keyword, source }));

test("backlink topics: meaning words only, about what the business offers", () => {
  const offer = "an app that automates keyword research, page optimization, article writing and weekly SEO updates for websites business owners";
  const topics = pickTopics(
    [...kw(["website and seo", "seo your website", "ai and business"], 0), ...kw(["answer all questions", "terms of law", "create and invoice", "seo tools"], 2)],
    offer,
  );
  assert.deepEqual(topics, ["website seo", "ai business"]);
  for (const t of topics) assert.doesNotMatch(t, /\b(and|your|all)\b/);
});

test("backlink topics: without a profile, the site's own searches still give topics", () => {
  assert.deepEqual(pickTopics(kw(["herbal tea for sleep", "loose leaf tea"]), null), ["herbal tea sleep", "loose leaf tea"]);
  assert.deepEqual(pickTopics([], "anything"), []);
});
