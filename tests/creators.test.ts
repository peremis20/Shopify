import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canDraft,
  claimFlags,
  cleanHandle,
  competitorFlag,
  composeCreatorMessage,
  CREATOR_DRAFT_CAP,
  creatorLink,
  creatorScore,
  engagementRate,
  HASHTAG_WEEKLY_LIMIT,
  hashtagOf,
  hashtagsAllowed,
  mentionsIn,
  missingMessages,
  showCreators,
  siteTopicWords,
  topicFit,
} from "../src/lib/analytics/creators";
import { CREATOR_SCOPES, REQUESTED_SCOPES } from "../src/lib/analytics/facebook";

test("creators: engagement rate comes only from fetched posts with real numbers", () => {
  const posts = [
    { like_count: 90, comments_count: 10 },
    { like_count: 40, comments_count: 10 },
    { like_count: 140, comments_count: 10 },
    { like_count: null, comments_count: 5 },
  ];
  const er = engagementRate(posts, 2000);
  assert.equal(er?.posts, 3);
  assert.equal(er?.rate, 100 / 2000);
  // Too few posts with numbers, or no follower count: no rate is made up.
  assert.equal(engagementRate(posts.slice(0, 2), 2000), null);
  assert.equal(engagementRate(posts, 0), null);
  assert.equal(engagementRate(posts, null), null);
});

test("creators: the fit score weighs topic fit to the site's own searches and products, then engagement", () => {
  const topics = siteTopicWords(["magnesium for sleep", "evening routine"], ["Magnesium Glycinate"], null, "ShopCo");
  assert.ok(topics.has("magnesium") && topics.has("glycinate") && !topics.has("shopco"));
  const good = topicFit("Sleep coach. My evening routine with magnesium glycinate.", topics);
  const poor = topicFit("Travel photos from Lisbon.", topics);
  assert.ok(good.fit > poor.fit);
  assert.equal(poor.fit, 0);
  assert.ok(good.matched.includes("magnesium"));
  assert.equal(creatorScore(1, 0.05), 100);
  assert.equal(creatorScore(1, null), 60);
  assert.equal(creatorScore(0, 0.1), 40);
  assert.ok(creatorScore(good.fit, 0.03) > creatorScore(poor.fit, 0.03));
});

test("creators: recent captions with medical claims are flagged", () => {
  assert.ok(claimFlags(["This magnesium cures insomnia, trust me", "Morning walk"]).length > 0);
  assert.deepEqual(claimFlags(["A calm evening routine", "Tea and a book"]), []);
});

test("creators: a sponsored post for a product like the site's own is flagged as a possible competitor", () => {
  const products = ["Magnesium Glycinate", "Chamomile Tea"];
  assert.ok(competitorFlag(["Loving this magnesium glycinate from @otherbrand #ad use code SAVE"], products, "ShopCo"));
  // Not sponsored, or our own brand, or another product: no flag.
  assert.equal(competitorFlag(["I take magnesium glycinate at night"], products, "ShopCo"), null);
  assert.equal(competitorFlag(["ShopCo magnesium glycinate #ad"], products, "ShopCo"), null);
  assert.equal(competitorFlag(["New protein bar #ad"], products, "ShopCo"), null);
});

test("creators: at most 30 different hashtags in seven days, searching one again doesn't count twice", () => {
  const now = Date.parse("2026-11-15T12:00:00Z");
  const day = 86400_000;
  const used = Array.from({ length: 29 }, (_, i) => ({ tag: `t${i}`, at: new Date(now - day).toISOString() }));
  assert.deepEqual(hashtagsAllowed(used, ["t1", "new1", "new2"], now), ["t1", "new1"]);
  const old = [...used, { tag: "t29", at: new Date(now - 8 * day).toISOString() }];
  assert.equal(hashtagsAllowed(old, ["t29"], now).length, 1);
  assert.equal(HASHTAG_WEEKLY_LIMIT, 30);
  assert.equal(hashtagOf("Magnesium for Sleep!"), "magnesiumforsleep");
  assert.deepEqual(mentionsIn("Thanks @Sleep.Coach and @tea_lover. email me@x.com"), ["sleep.coach", "tea_lover"]);
});

test("creators: each creator gets a tagged link for Analytics", () => {
  const u = new URL(creatorLink("https://shop.com/", "@Sleep.Coach"));
  assert.equal(u.searchParams.get("utm_source"), "instagram");
  assert.equal(u.searchParams.get("utm_medium"), "creator");
  assert.equal(u.searchParams.get("utm_campaign"), "creator_sleep.coach");
  assert.equal(cleanHandle(" @A-b c "), "abc");
});

test("creators: at most five message drafts a week, each asking for the paid partnership label with approved wording", () => {
  assert.equal(CREATOR_DRAFT_CAP, 5);
  assert.ok(canDraft(4));
  assert.ok(!canDraft(5));
  const m = composeCreatorMessage("Hi, I like your evening posts.", "A calm magnesium routine for the evening.", "https://shop.com/?utm_source=instagram");
  assert.match(m, /paid partnership/);
  assert.match(m, /Approved wording: A calm magnesium routine/);
  assert.match(m, /don't say it cures, treats or prevents/);
  assert.ok(!/[‐-―]| - /.test(m));
});

test("creators: the card is hidden without Instagram connected", () => {
  assert.equal(showCreators(null), false);
  assert.equal(showCreators({ igUserId: null }), false);
  assert.equal(showCreators({ igUserId: "178" }), true);
});

test("creators: a missing permission is told to the owner in plain words, and the scopes are in one constant", () => {
  const msgs = missingMessages({ marketplace: "missing", hashtags: "ok", discovery: "missing" });
  assert.equal(msgs.length, 2);
  assert.match(msgs[0], /Creator Marketplace/);
  assert.match(msgs[1], /instagram_manage_insights/);
  for (const m of msgs) assert.ok(!/[‐-―]| - /.test(m));
  assert.deepEqual(missingMessages({ marketplace: "ok", hashtags: "ok", discovery: "ok" }), []);
  assert.ok(CREATOR_SCOPES.includes("instagram_manage_insights"));
  assert.ok(REQUESTED_SCOPES.includes("instagram_basic") && REQUESTED_SCOPES.includes("instagram_manage_insights"));
});
