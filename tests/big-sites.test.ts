/**
 * Giant platforms (app stores, social networks, marketplaces) are never treated as a
 * rival to outrank or a site to study for backlinks; ordinary sites still are.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBig } from "../src/lib/analytics/autopilot/site-keywords";

test("app stores and giant platforms are big", () => {
  for (const d of ["play.google.com", "apps.apple.com", "www.linkedin.com", "x.com", "github.com", "www.etsy.com"]) assert.equal(isBig(d), true, d);
});

test("ordinary sites, including ones with a giant's name inside, are not", () => {
  for (const d of ["myshop.com", "googleseoexperts.com", "applepiebakery.com", "fox.com", "boxstore.net"]) assert.equal(isBig(d), false, d);
});
