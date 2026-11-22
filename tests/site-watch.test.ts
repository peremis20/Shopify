import { test } from "node:test";
import assert from "node:assert/strict";
import { pageNoindex, robotsBlocksAll, tagDiagnosis, tagIds, trackingGap } from "../src/lib/analytics/autopilot/site-watch";

test("robots.txt: only a whole site block for every crawler counts", () => {
  assert.equal(robotsBlocksAll("User-agent: *\nDisallow: /"), true);
  assert.equal(robotsBlocksAll("User-agent: *\nDisallow: /admin\nAllow: /"), false);
  assert.equal(robotsBlocksAll("User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nDisallow:"), false);
  assert.equal(robotsBlocksAll("User-agent: Googlebot\nUser-agent: *\nDisallow: / # all"), true);
  assert.equal(robotsBlocksAll(""), false);
});

test("noindex is found in a meta tag or the X-Robots-Tag header", () => {
  assert.equal(pageNoindex('<meta name="robots" content="noindex, follow">', null), true);
  assert.equal(pageNoindex('<meta content="index,follow" name="robots">', null), false);
  assert.equal(pageNoindex("<p>hi</p>", "noindex"), true);
  assert.equal(pageNoindex('<meta name="description" content="noindex is a word">', null), false);
});

test("why Analytics undercounts, from the page", () => {
  assert.match(tagDiagnosis(tagIds("<html></html>"), null)!.cause, /no Google Analytics tag/);
  assert.match(tagDiagnosis(tagIds('<script src="https://www.googletagmanager.com/gtag/js?id=G-AAAA1111"></script>'), ["G-BBBB2222"])!.cause, /different Analytics property/);
  // Named in the page's data but not loaded with it: a tag waiting for consent, as on the magazine before the fix.
  assert.match(tagDiagnosis(tagIds('{"id":"G-G36ZTCVCEN","allowed":false}'), ["G-G36ZTCVCEN"])!.cause, /waits for something first/);
  assert.equal(tagDiagnosis(tagIds('<script async src="https://www.googletagmanager.com/gtag/js?id=G-G36ZTCVCEN"></script>'), ["G-G36ZTCVCEN"]), null);
  assert.equal(tagDiagnosis(tagIds('<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD12"></script>'), ["G-X"]), null);
});

test("a tracking gap needs enough clicks and a big shortfall", () => {
  assert.equal(trackingGap(18, 0), false);
  assert.equal(trackingGap(40, 5), true);
  assert.equal(trackingGap(40, 30), false);
});
