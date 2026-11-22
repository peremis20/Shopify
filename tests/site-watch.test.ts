import { test } from "node:test";
import assert from "node:assert/strict";
import { downAnswer, pageNoindex, pageTitle, registeredDomain, robotsBlocksAll, tagDiagnosis, tagIds, titleIsLive, trackingGap } from "../src/lib/analytics/autopilot/site-watch";

test("robots.txt: Google's own group wins, and only Disallow / with no Allow closes the site", () => {
  assert.equal(robotsBlocksAll("User-agent: *\nDisallow: /"), true);
  assert.equal(robotsBlocksAll("﻿User-agent: *\r\nDisallow: /\r\n"), true);
  assert.equal(robotsBlocksAll("User-agent: *\nDisallow: /\nAllow: /blog"), false);
  assert.equal(robotsBlocksAll("User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nDisallow:"), false);
  assert.equal(robotsBlocksAll("User-agent: Googlebot\nUser-agent: *\nDisallow: / # all"), true);
  // Google follows its own group, even when every other crawler is shut out.
  assert.equal(robotsBlocksAll("User-agent: Googlebot\nDisallow: /admin\n\nUser-agent: *\nDisallow: /"), false);
  assert.equal(robotsBlocksAll("User-agent: *\nDisallow: /search"), false);
  assert.equal(robotsBlocksAll(""), false);
});

test("noindex: exact directives, for Google, in the robots meta tag or the header", () => {
  assert.equal(pageNoindex('<meta name="robots" content="noindex, follow">', null), true);
  assert.equal(pageNoindex('<meta name="googlebot" content="none">', null), true);
  assert.equal(pageNoindex('<meta content="index,follow" name="robots">', null), false);
  assert.equal(pageNoindex('<meta name="bingbot" content="noindex">', null), false);
  assert.equal(pageNoindex('<meta name="robots" content="noindexing-later">', null), false);
  assert.equal(pageNoindex("<p>hi</p>", "noindex"), true);
  assert.equal(pageNoindex("<p>hi</p>", "otherbot: noindex"), false);
  assert.equal(pageNoindex("<p>hi</p>", "googlebot: noindex"), true);
  assert.equal(pageNoindex("<p>hi</p>", "max-snippet: 50"), false);
  assert.equal(pageNoindex('<meta name="description" content="noindex is a word">', null), false);
});

test("why Analytics undercounts, from the page, in careful words", () => {
  assert.match(tagDiagnosis(tagIds("<html></html>"), null)!.cause, /no Google Analytics tag/);
  assert.match(tagDiagnosis(tagIds('<script src="https://www.googletagmanager.com/gtag/js?id=G-AAAA1111"></script>'), ["G-BBBB2222"])!.cause, /not one of the connected/);
  // Named in the page's data but not loaded with it: a tag waiting for consent, as on the magazine before the fix.
  assert.match(tagDiagnosis(tagIds('{"id":"G-G36ZTCVCEN","allowed":false}'), ["G-G36ZTCVCEN"])!.cause, /may wait for something first/);
  assert.equal(tagDiagnosis(tagIds('<script async src="https://www.googletagmanager.com/gtag/js?id=G-G36ZTCVCEN"></script>'), ["G-G36ZTCVCEN"]), null);
  // Next.js preloads the tag rather than writing a script tag.
  assert.equal(tagDiagnosis(tagIds('<link rel="preload" href="https://www.googletagmanager.com/gtag/js?id=G-G36ZTCVCEN" as="script"> {"id":"G-G36ZTCVCEN"}'), ["G-G36ZTCVCEN"]), null);
  assert.equal(tagDiagnosis(tagIds('<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD12"></script>'), ["G-X"]), null);
  // Shopify loads Google's tag through its pixels, outside the page's HTML.
  assert.equal(tagDiagnosis(tagIds('<script id="web-pixels-manager-setup"></script>'), ["G-X"]), null);
  // A G- word in plain text is not a tag id.
  assert.deepEqual(tagIds("<p>Our G-FORCE12 model</p>").ga, []);
});

test("a tracking gap needs enough clicks and a big shortfall", () => {
  assert.equal(trackingGap(18, 0), false);
  assert.equal(trackingGap(40, 5), true);
  assert.equal(trackingGap(40, 30), false);
});

test("a bot check, rate limit or login is not a site that is down", () => {
  assert.equal(downAnswer(200, null, null), "up");
  assert.equal(downAnswer(301, null, null), "up");
  assert.equal(downAnswer(403, "cloudflare", null), "blocked");
  assert.equal(downAnswer(429, null, null), "blocked");
  assert.equal(downAnswer(503, "cloudflare", null), "blocked");
  assert.equal(downAnswer(200, null, "challenge"), "up");
  assert.equal(downAnswer(500, null, "challenge"), "blocked");
  assert.equal(downAnswer(500, "nginx", null), "down");
  assert.equal(downAnswer(503, "Apache", null), "down");
});

test("live titles and registered domains", () => {
  assert.equal(pageTitle("<title>\n  Magnesium &amp; Sleep | Peremis </title>"), "Magnesium & Sleep | Peremis");
  assert.equal(pageTitle("<p>none</p>"), null);
  // WordPress writes curly quotes and dashes as numeric entities.
  assert.equal(titleIsLive(pageTitle("<title>Don&#8217;t Skip Sleep &#8211; Peremis</title>"), "Don't Skip Sleep - Peremis"), true);
  assert.equal(pageTitle("<title>A &#x26; B</title>"), "A & B");
  assert.equal(titleIsLive("Magnesium & Sleep | Peremis", "Magnesium & sleep"), true);
  assert.equal(titleIsLive("Old title | Peremis", "Magnesium & Sleep"), false);
  assert.equal(titleIsLive(null, "x"), false);
  assert.equal(registeredDomain("www.peremis.com"), "peremis.com");
  assert.equal(registeredDomain("shop.example.co.uk"), "example.co.uk");
  assert.equal(registeredDomain("centralhealthmag.com"), "centralhealthmag.com");
});
