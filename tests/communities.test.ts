import { test } from "node:test";
import assert from "node:assert/strict";
import { communityLine, localPlace, suggestCommunities } from "../src/lib/analytics/communities";

const searches = [
  { query: "magnesium for sleep", page: "https://shop.com/blogs/news/magnesium", weight: 80 },
  { query: "how much magnesium before bed", page: "https://shop.com/blogs/news/magnesium", weight: 20 },
  { query: "chamomile tea benefits", page: "https://shop.com/blogs/news/chamomile", weight: 50 },
  { query: "shopco magnesium", page: "https://shop.com/products/m", weight: 900 },
  { query: "tea", page: "https://shop.com/blogs/news/tea", weight: 900 },
  { query: "evening routine ideas", page: "https://shop.com/blogs/news/routine", weight: 10 },
  { query: "sleep hygiene tips", page: "https://shop.com/blogs/news/hygiene", weight: 5 },
];

test("communities: suggestions are the site's own searches on well known community types, never made up groups", () => {
  const out = suggestCommunities(searches, "Online, worldwide", "ShopCo");
  assert.equal(out.length, 3);
  // Questions first, one per page, the brand's own searches and one word searches left out.
  assert.equal(out[0].search, "how much magnesium before bed");
  assert.deepEqual(out.map((o) => o.page), ["https://shop.com/blogs/news/magnesium", "https://shop.com/blogs/news/chamomile", "https://shop.com/blogs/news/routine"]);
  for (const o of out) {
    assert.ok(["Facebook Groups", "Reddit", "Quora", "Nextdoor"].includes(o.where));
    assert.ok(searches.some((s) => s.query === o.search));
    assert.ok(!/\d/.test(o.search));
  }
  assert.equal(communityLine(out[1]), `Search Reddit for: chamomile tea benefits`);
  assert.deepEqual(suggestCommunities([], null, null), []);
});

test("communities: a local business also gets its town on a local community", () => {
  assert.equal(localPlace("Austin, Texas"), "Austin");
  assert.equal(localPlace("Online everywhere"), null);
  assert.equal(localPlace(""), null);
  const out = suggestCommunities(searches, "Austin, Texas", "ShopCo");
  assert.equal(out[0].where, "Nextdoor");
  assert.equal(out[0].search, "how much magnesium before bed Austin");
  assert.equal(communityLine(out[0]), "Search Nextdoor for: how much magnesium before bed Austin");
});
