import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { readSession, roleFor, sessionValue } from "../src/lib/analytics/accounts";
import { inviteProblem, landingFor, memberRefusal, OWNER_ONLY, ownerOnlyAction, removeProblem, TEAM_CAP } from "../src/lib/analytics/members";

process.env.SESSION_SECRET ??= "test secret for members";
const later = Math.floor(Date.now() / 1000) + 3600;

test("members: the session names the business and the person who signed in", () => {
  const v = sessionValue("1", "Info@Peremis.com", later);
  assert.deepEqual(readSession(v), { id: "1", person: "info@peremis.com", exp: later });
});

test("members: cookies from before team members still sign the owner in", () => {
  const payload = `7.${later}`;
  const sig = crypto.createHmac("sha256", process.env.SESSION_SECRET!).update(payload).digest("base64url");
  assert.deepEqual(readSession(`${payload}.${sig}`), { id: "7", person: null, exp: later });
});

test("members: a changed business, person or expiry breaks the signature", () => {
  const v = sessionValue("1", "info@peremis.com", later);
  const [id, person, exp, sig] = v.split(".");
  assert.equal(readSession(`2.${person}.${exp}.${sig}`), null);
  const other = Buffer.from("jimmy@peremis.com").toString("base64url");
  assert.equal(readSession(`${id}.${other}.${exp}.${sig}`), null);
  assert.equal(readSession(`${id}.${person}.${Number(exp) + 1}.${sig}`), null);
  // An old style signature can't be reused as a new style cookie.
  const oldSig = crypto.createHmac("sha256", process.env.SESSION_SECRET!).update(`${id}.${exp}`).digest("base64url");
  assert.equal(readSession(`${id}.${person}.${exp}.${oldSig}`), null);
  assert.equal(readSession("junk"), null);
  assert.equal(readSession(""), null);
});

test("members: an expired session is refused", () => {
  const v = sessionValue("1", "info@peremis.com", Math.floor(Date.now() / 1000) - 10);
  assert.equal(readSession(v), null);
});

test("members: the role comes from the business, rechecked on every request", () => {
  assert.equal(roleFor("jimmy@peremis.com", "Jimmy@Peremis.com", false), "owner");
  assert.equal(roleFor("info@peremis.com", "jimmy@peremis.com", true), "member");
  // Removed from the team: no access at once.
  assert.equal(roleFor("info@peremis.com", "jimmy@peremis.com", false), null);
});

test("members: where a sign in lands", () => {
  // Owner of a business with data: always their own, with a switch offered.
  assert.deepEqual(landingFor({ ownId: "5", ownHasData: true, serverAdmin: false, memberships: ["1"] }), { accountId: "5", role: "owner" });
  // Member of one business, nothing of their own: lands in it.
  assert.deepEqual(landingFor({ ownId: null, ownHasData: false, serverAdmin: false, memberships: ["1"] }), { accountId: "1", role: "member" });
  // Only an empty first sign in of their own: lands in the business they joined.
  assert.deepEqual(landingFor({ ownId: "9", ownHasData: false, serverAdmin: false, memberships: ["1", "3"] }), { accountId: "1", role: "member" });
  // Nothing accepted (a pending invite counts for nothing): their own, made on first sign in.
  assert.deepEqual(landingFor({ ownId: null, ownHasData: false, serverAdmin: false, memberships: [] }), { accountId: null, role: "owner" });
  // A platform owner set on the server is never redirected.
  assert.deepEqual(landingFor({ ownId: null, ownHasData: false, serverAdmin: true, memberships: ["1"] }), { accountId: null, role: "owner" });
  assert.deepEqual(landingFor({ ownId: "4", ownHasData: false, serverAdmin: true, memberships: ["1"] }), { accountId: "4", role: "owner" });
});

const base = {
  email: "info@peremis.com" as string | null,
  ownerEmail: "jimmy@peremis.com",
  role: "owner" as const,
  embedded: false,
  alreadyMember: false,
  members: 0,
  pending: 0,
  alreadyInvited: false,
};

test("members: only the main sign in invites, within the caps", () => {
  assert.equal(inviteProblem(base), null);
  assert.match(inviteProblem({ ...base, role: "member" })!, /Only the main sign in/);
  assert.match(inviteProblem({ ...base, embedded: true })!, /browser/);
  assert.match(inviteProblem({ ...base, email: null })!, /email address/);
  assert.match(inviteProblem({ ...base, email: "jimmy@peremis.com" })!, /main sign in/);
  assert.match(inviteProblem({ ...base, alreadyMember: true })!, /already on your team/);
  assert.match(inviteProblem({ ...base, members: TEAM_CAP })!, /Remove someone/);
  assert.match(inviteProblem({ ...base, pending: TEAM_CAP })!, /Cancel one/);
  // Renewing an invite already waiting is fine at the cap.
  assert.equal(inviteProblem({ ...base, pending: TEAM_CAP, alreadyInvited: true }), null);
});

test("members: a member removes only themselves; the owner removes anyone", () => {
  assert.equal(removeProblem({ role: "owner", person: "jimmy@peremis.com", target: "info@peremis.com", embedded: false }), null);
  assert.equal(removeProblem({ role: "member", person: "Info@Peremis.com", target: "info@peremis.com", embedded: false }), null);
  assert.match(removeProblem({ role: "member", person: "info@peremis.com", target: "other@peremis.com", embedded: false })!, /Only the main sign in/);
  assert.match(removeProblem({ role: "owner", person: "jimmy@peremis.com", target: null, embedded: false })!, /email address/);
  assert.match(removeProblem({ role: "owner", person: "jimmy@peremis.com", target: "info@peremis.com", embedded: true })!, /browser/);
});

test("members: wording for owners has no dashes", () => {
  const texts = [
    inviteProblem({ ...base, role: "member" }),
    inviteProblem({ ...base, members: TEAM_CAP }),
    inviteProblem({ ...base, pending: TEAM_CAP }),
    removeProblem({ role: "member", person: "a@b.co", target: "c@d.co", embedded: false }),
  ];
  for (const t of texts) assert.doesNotMatch(t!, /[‐-―-]/);
});

test("members: sending, publishing and settings inside shared endpoints are for the main sign in", () => {
  for (const [area, action] of [
    ["crm", "email"], ["crm", "settings"],
    ["newsletter", "settings"], ["newsletter", "import"], ["newsletter", "add"], ["newsletter", "shopify"], ["newsletter", "approve"], ["newsletter", "retry"],
    ["social", "approve"], ["storeAudit", "apply-price"], ["storeAudit", "undo-price"], ["speed", "shrink"], ["speed", "undo"],
    ["conversion", "add"], ["conversion", "undo"], ["fix", "approve"],
  ] as const) {
    assert.equal(ownerOnlyAction(area, action), true, `${area} ${action}`);
    assert.equal(memberRefusal("member", area, action), OWNER_ONLY);
    assert.equal(memberRefusal("owner", area, action), null);
  }
  // Members still draft, keep the CRM, test the newsletter on themselves and pause a send.
  for (const [area, action] of [["crm", "save"], ["crm", "draft"], ["newsletter", "save"], ["newsletter", "draft"], ["newsletter", "test"], ["newsletter", "stop"], ["social", "skip"], ["storeAudit", "run"], ["fix", null]] as const) {
    assert.equal(memberRefusal("member", area, action), null, `${area} ${action}`);
  }
  assert.equal(ownerOnlyAction("unknown", "email"), false);
  assert.equal(ownerOnlyAction("crm", undefined), false);
  assert.doesNotMatch(OWNER_ONLY, /[\u2010-\u2015-]/);
});
