import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanLead, fromSite, leadNote, leadTags, needsCustomerAccess, splitName } from "../src/lib/analytics/autopilot/leads";

const form = {
  business: "Healing Hands Chiropractic",
  name: "Ana Maria Lopez",
  email: " Ana@Example.com ",
  phone: "484 866 0229",
  interest: "Clinic consignment",
  type: "Clinic or practitioner",
  details: "Magnesium, 12 bottles",
  source: "Wholesale page",
};

test("a request is cleaned, and a bot or a bad email is dropped", () => {
  const l = cleanLead(form)!;
  assert.equal(l.email, "ana@example.com");
  assert.equal((l as unknown as Record<string, unknown>).tag, undefined);
  assert.equal(cleanLead({ ...form, website: "http://spam" }), null);
  assert.equal(cleanLead({ ...form, email: "not an email" }), null);
  assert.equal(cleanLead(null), null);
  assert.equal(cleanLead({ ...form, email: 'a(b)*@x.com' }), null);
  assert.equal(cleanLead({ ...form, details: "x".repeat(5000) })!.details.length, 2000);
});

test("only the site's own pages may send a lead", () => {
  assert.equal(fromSite("https://peremis.com", "peremis.com"), true);
  assert.equal(fromSite("https://www.peremis.com", "peremis.com"), true);
  assert.equal(fromSite("https://peremis.myshopify.com", "peremis.com", "peremis.myshopify.com"), true);
  assert.equal(fromSite("https://evil.com", "peremis.com"), false);
  assert.equal(fromSite("https://peremis.com.evil.com", "peremis.com"), false);
  assert.equal(fromSite(null, "peremis.com"), false);
  assert.equal(fromSite("https://peremis.com", null), false);
});

test("the Shopify note and tags say what the visitor asked, with no commas in tags", () => {
  const l = cleanLead({ ...form, interest: "Custom quote, 2,000+ units" })!;
  const note = leadNote(l, new Date("2026-11-18T22:40:00Z"));
  assert.match(note, /^Website request 2026-11-18 \(Wholesale page\)/);
  assert.match(note, /Business: Healing Hands Chiropractic/);
  assert.match(note, /Phone: 484 866 0229/);
  assert.deepEqual(leadTags(l), ["Website lead", "Lead: Wholesale page", "Lead: Custom quote 2 000+ units"]);
  // A visitor can't hand themselves a tag a store uses for pricing.
  assert.deepEqual(leadTags(cleanLead({ ...form, source: "", interest: "wholesale", tag: "wholesale" })!), ["Website lead", "Lead: wholesale"]);
  for (const t of leadTags(l)) assert.doesNotMatch(t, /,/);
});

test("names split for Shopify, and a missing permission is recognised", () => {
  assert.deepEqual(splitName("Ana Maria Lopez"), { firstName: "Ana", lastName: "Maria Lopez" });
  assert.deepEqual(splitName("Ana"), { firstName: "Ana" });
  assert.deepEqual(splitName(""), {});
  assert.equal(needsCustomerAccess(new Error("Shopify request failed: Access denied for customerCreate field. Required access: `write_customers`")), true);
  assert.equal(needsCustomerAccess(new Error("Shopify rejected the change: Email has already been taken")), false);
});
