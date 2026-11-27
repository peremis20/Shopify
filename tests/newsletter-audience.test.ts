import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audienceWhere,
  cleanAudience,
  cleanTag,
  cleanTestEmails,
  describeAudience,
  freezeParts,
  joinSql,
  MAX_PEOPLE,
  parseTyped,
  readAudience,
  skipReason,
  testCounts,
  testRecipients,
} from "../src/lib/analytics/newsletter";
import { memberRefusal } from "../src/lib/analytics/members";

test("audiences are checked: unknown groups dropped, tags cleaned, people capped, anything else is everyone", () => {
  assert.deepEqual(cleanAudience(undefined), { type: "all" });
  assert.deepEqual(cleanAudience({ type: "nope" }), { type: "all" });
  assert.deepEqual(cleanAudience({ type: "segment", segments: ["shopify", "bogus", "shopify"], tags: [" VIP  Club ", "", "vip club"] }), { type: "segment", segments: ["shopify"], tags: ["vip club"] });
  assert.throws(() => cleanAudience({ type: "segment", segments: [], tags: [] }), /at least one/);
  assert.deepEqual(cleanAudience({ type: "people", ids: ["3", 3, "x", "4"], from: "crm" }), { type: "people", ids: ["3", "4"], from: "crm" });
  assert.throws(() => cleanAudience({ type: "people", ids: [] }), /at least one person/);
  assert.throws(() => cleanAudience({ type: "people", ids: Array.from({ length: MAX_PEOPLE + 1 }, (_, i) => String(i + 1)) }), /up to/);
  // The weekly newsletter may only use everyone or groups.
  assert.deepEqual(cleanAudience({ type: "people", ids: ["1"] }, { allowPeople: false }), { type: "all" });
});

test("a stored audience is read leniently: anything broken is everyone, never an error while sending", () => {
  assert.deepEqual(readAudience(null), { type: "all" });
  assert.deepEqual(readAudience("{not json"), { type: "all" });
  assert.deepEqual(readAudience('{"type":"segment","segments":[],"tags":[]}'), { type: "all" });
  assert.deepEqual(readAudience('{"type":"people","ids":["7"],"from":"typed"}'), { type: "people", ids: ["7"], from: "typed" });
});

test("audiences in plain words", () => {
  assert.equal(describeAudience({ type: "all" }), "All subscribers");
  assert.equal(describeAudience({ type: "people", ids: ["1", "2"], from: "crm" }), "2 chosen people from your CRM");
  assert.equal(describeAudience({ type: "segment", segments: ["recent"], tags: ["wholesale"] }), "Added in the last 30 days, tag wholesale");
});

test("the audience condition: values are always parameters, never written into the SQL", () => {
  const people = joinSql(audienceWhere({ type: "people", ids: ["5", "9"], from: "chosen" }, null));
  assert.deepEqual(people.values, ["5,9"]);
  assert.ok(!people.strings.join("").includes("5,9"));
  const seg = joinSql(audienceWhere({ type: "segment", segments: ["shopify", "recent", "engaged", "unengaged"], tags: ["it's; DROP"] }, "2026-11-01 00:00:00+00"));
  const text = seg.strings.join("$?");
  assert.ok(text.includes("s.source = 'shopify'"));
  assert.ok(text.includes("interval '30 days'"));
  assert.ok(text.includes("email.opened"));
  assert.ok(!text.includes("DROP"));
  assert.deepEqual(seg.values, ["2026-11-01 00:00:00+00", "it's; DROP"]);
  // Groups are joined by OR inside one bracket, so they never loosen the conditions around them.
  assert.ok(/^ NOT s\.direct_only AND  \(/.test(seg.strings[0]) && /\) $/.test(seg.strings[seg.strings.length - 1]));
  assert.deepEqual(joinSql(audienceWhere({ type: "all" }, null)), { strings: [" NOT s.direct_only AND  TRUE "], values: [] });
});

test("tags and typed addresses", () => {
  assert.equal(cleanTag("  Trade   Show 2026 "), "trade show 2026");
  assert.equal(cleanTag(5), "");
  assert.deepEqual(parseTyped("ana@x.com\nBEN@x.com, ana@x.com").emails, ["ana@x.com", "ben@x.com"]);
  assert.throws(() => parseTyped(Array.from({ length: 21 }, (_, i) => `p${i}@x.com`).join("\n")), /up to 20/);
  assert.throws(() => parseTyped(""), /at least one/);
  assert.throws(() => parseTyped("not an address"), /No email/);
});

test("nobody unsubscribed, bounced or complained is added back, and the reason is said", () => {
  assert.equal(skipReason("unsubscribed"), "unsubscribed");
  assert.equal(skipReason("bounced"), "their email bounced");
  assert.equal(skipReason("complained"), "marked an email as spam");
  assert.equal(skipReason("subscribed"), null);
  assert.equal(skipReason(undefined), null);
});

test("test emails: the presser first, up to 3 more, and it counts only when someone who can approve got it", () => {
  assert.deepEqual(cleanTestEmails("a@x.com, B@x.com; owner@x.com", "owner@x.com"), ["a@x.com", "b@x.com"]);
  assert.throws(() => cleanTestEmails(["a@x.com", "b@x.com", "c@x.com", "d@x.com"], null), /up to 3/);
  assert.throws(() => cleanTestEmails(["nope"], null), /isn't an email/);
  assert.deepEqual(testRecipients("Owner@x.com", ["a@x.com", "owner@x.com"]), ["owner@x.com", "a@x.com"]);
  // The owner pressed it and got it.
  assert.equal(testCounts({ canApprove: true, presser: "owner@x.com", reached: ["owner@x.com"], ownerEmail: "owner@x.com" }), true);
  // A member pressed it: it reached only them and a teammate.
  assert.equal(testCounts({ canApprove: false, presser: "m@x.com", reached: ["m@x.com", "a@x.com"], ownerEmail: "owner@x.com" }), false);
  // A member pressed it and the owner's address is one of the extra test addresses: it reached the owner.
  assert.equal(testCounts({ canApprove: false, presser: "m@x.com", reached: ["m@x.com", "owner@x.com"], ownerEmail: "owner@x.com" }), true);
  // The owner pressed it but only the extra addresses got it (their own failed).
  assert.equal(testCounts({ canApprove: true, presser: "owner@x.com", reached: ["a@x.com"], ownerEmail: "owner@x.com" }), false);
});

test("adding CRM contacts or typed addresses and tagging people are the owner's; members may still choose an audience", () => {
  assert.ok(memberRefusal("member", "newsletter", "crm"));
  assert.ok(memberRefusal("member", "newsletter", "typed"));
  assert.ok(memberRefusal("member", "newsletter", "tag"));
  assert.equal(memberRefusal("member", "newsletter", "audience"), null);
  assert.equal(memberRefusal("owner", "newsletter", "tag"), null);
  assert.equal(memberRefusal("owner", "newsletter", "crm"), null);
});

test("approval and its exact audience are one statement; nothing is saved unless the approval happened", () => {
  const q = joinSql(freezeParts("4", "77", { type: "segment", segments: ["shopify"], tags: ["vip"] }, { origin: "https://app.x.com", scheduledAt: null, auto: false, from: ["draft", "stopped"] }));
  const text = q.strings.join("$?");
  // approved_at is the moment of this approval, never an older one.
  assert.ok(text.includes("approved_at = now()"));
  assert.ok(text.includes("frozen = true"));
  assert.ok(text.includes("INSERT INTO insights_newsletter_recipients"));
  // Saved only when the update returned the email, and only people still subscribed and in the audience.
  assert.ok(text.includes("WHERE EXISTS (SELECT 1 FROM upd)"));
  assert.ok(text.includes("s.status = 'subscribed'"));
  assert.ok(text.includes("s.source = 'shopify'"));
  // Every value is a parameter.
  assert.ok(!text.includes("app.x.com") && !text.includes("vip"));
  assert.ok(q.values.includes("https://app.x.com") && q.values.includes("vip") && q.values.includes("draft,stopped"));
});

test("a team member's test goes only to them; the extra test addresses are the owner's", () => {
  // sendTest passes the extra addresses only for someone who can approve.
  assert.deepEqual(testRecipients("m@x.com", []), ["m@x.com"]);
  assert.deepEqual(testRecipients("owner@x.com", ["a@x.com"]), ["owner@x.com", "a@x.com"]);
});
