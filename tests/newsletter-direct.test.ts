import { test } from "node:test";
import assert from "node:assert/strict";
import { audienceWhere, cleanAudience, DIRECT_CONSENT, directProblem, joinSql, parseDirectTo, readAudience, REPEAT_WINDOW_MINUTES, sameRecipients, validRequestId, type SubscriberStatus } from "../src/lib/analytics/newsletter";
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
  assert.equal(DIRECT_CONSENT, "Agreed: sent directly from Write an email, for this email only");
});

test("Send now is the owner's; a team member is refused on the server", () => {
  assert.ok(memberRefusal("member", "newsletter", "sendNow"));
  assert.equal(memberRefusal("owner", "newsletter", "sendNow"), null);
});

test("people who agreed to one Send now email are never on the list: only that email's own audience reaches them", () => {
  for (const a of [
    { type: "all" as const },
    { type: "segment" as const, segments: ["recent" as const], tags: ["vip"] },
    { type: "people" as const, ids: ["5"], from: "chosen" as const },
  ]) {
    assert.ok(joinSql(audienceWhere(a, null)).strings[0].startsWith(" NOT s.direct_only AND "), a.type);
  }
  const direct = joinSql(audienceWhere({ type: "people", ids: ["5", "6"], from: "direct" }, null));
  assert.ok(!direct.strings.join("").includes("direct_only"));
  assert.deepEqual(direct.values, ["5,6"]);
});

test("the browser can never ask for the one email audience; only the server's own records carry it", () => {
  assert.equal((cleanAudience({ type: "people", ids: ["5"], from: "direct" }) as { from: string }).from, "chosen");
  assert.equal((cleanAudience({ type: "people", ids: ["5"], from: "direct" }, { allowDirect: true }) as { from: string }).from, "direct");
  assert.equal((readAudience('{"type":"people","ids":["5"],"from":"direct"}') as { from: string }).from, "direct");
});

test("a repeat Send now: the same click id, or the same words to the same people", () => {
  assert.equal(validRequestId("a1b2c3d4e5f6"), true);
  assert.equal(validRequestId("short"), false);
  assert.equal(validRequestId("has space in it!"), false);
  assert.equal(validRequestId(undefined), false);
  assert.equal(sameRecipients(["A@x.com", "b@x.com"], ["b@x.com", "a@x.com"]), true);
  assert.equal(sameRecipients(["a@x.com"], ["a@x.com", "b@x.com"]), false);
  assert.equal(sameRecipients(["a@x.com", "c@x.com"], ["a@x.com", "b@x.com"]), false);
  assert.equal(REPEAT_WINDOW_MINUTES, 10);
});

test("someone who agreed to one earlier email needs the owner's word again", () => {
  // sendNow leaves them out of the statuses it checks, so they count as new here.
  assert.match(directProblem(["once@x.com"], new Map(), false) ?? "", /once@x\.com asked for or agreed/);
});
