import { test } from "node:test";
import assert from "node:assert/strict";
import { DIRECT_CONSENT, directProblem, parseDirectTo, type SubscriberStatus } from "../src/lib/analytics/newsletter";
import { MAX_DIRECT, splitTo } from "../src/lib/analytics/newsletter-audience";
import { memberRefusal } from "../src/lib/analytics/members";

test("To is split on commas, semicolons and spaces", () => {
  assert.deepEqual(splitTo(" a@x.com, b@x.com;c@x.com  d@x.com "), ["a@x.com", "b@x.com", "c@x.com", "d@x.com"]);
  assert.deepEqual(splitTo(""), []);
  assert.deepEqual(splitTo("a@x.com a@x.com"), ["a@x.com"]);
});

test("Send now takes 1 to 3 real addresses, each once", () => {
  assert.equal(MAX_DIRECT, 3);
  assert.deepEqual(parseDirectTo("Ana@X.com, ana@x.com"), ["ana@x.com"]);
  assert.deepEqual(parseDirectTo("a@x.com b@x.com c@x.com"), ["a@x.com", "b@x.com", "c@x.com"]);
  assert.throws(() => parseDirectTo("a@x.com b@x.com c@x.com d@x.com"), /up to 3/);
  assert.throws(() => parseDirectTo(""), /Type who/);
  assert.throws(() => parseDirectTo("a@x.com, nope"), /nope isn't an email address/);
  assert.throws(() => parseDirectTo(42), /Type who/);
});

test("consent: needed only for someone not already subscribed; anyone who left is refused with the reason", () => {
  const st = new Map<string, SubscriberStatus>([
    ["sub@x.com", "subscribed"],
    ["gone@x.com", "unsubscribed"],
    ["bad@x.com", "bounced"],
    ["spam@x.com", "complained"],
  ]);
  // Everyone already subscribed: no box needed.
  assert.equal(directProblem(["sub@x.com"], st, false), null);
  // Someone new: the box is needed.
  assert.match(directProblem(["sub@x.com", "new@x.com"], st, false) ?? "", /new@x\.com asked for or agreed/);
  assert.equal(directProblem(["sub@x.com", "new@x.com"], st, true), null);
  // Only a real true counts.
  assert.ok(directProblem(["new@x.com"], st, "yes"));
  // Unsubscribed, bounced or complained: refused even with the box ticked, each with its reason.
  const why = directProblem(["gone@x.com", "bad@x.com", "spam@x.com"], st, true) ?? "";
  assert.match(why, /gone@x\.com: unsubscribed/);
  assert.match(why, /bad@x\.com: their email bounced/);
  assert.match(why, /spam@x\.com: marked an email as spam/);
  assert.equal(DIRECT_CONSENT, "Agreed: sent directly from Write an email");
});

test("Send now is the owner's; a team member is refused on the server", () => {
  assert.ok(memberRefusal("member", "newsletter", "sendNow"));
  assert.equal(memberRefusal("owner", "newsletter", "sendNow"), null);
});
