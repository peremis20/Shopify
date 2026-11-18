import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanContact, cleanStages, DEFAULT_STAGES, fillTemplate } from "../src/lib/analytics/crm";
import { parseCsv, rowsToContacts } from "../src/lib/analytics/csv";

test("a contact is cleaned: stage matched, value read, tags split, bad email refused", () => {
  const c = cleanContact({ name: " Ana Lopez ", email: "ANA@Example.com", stage: "proposal", value: "$1,250.50", tags: "clinic, vip, clinic", followUp: "2026-12-01" }, DEFAULT_STAGES)!;
  assert.equal(c.name, "Ana Lopez");
  assert.equal(c.email, "ana@example.com");
  assert.equal(c.stage, "Proposal");
  assert.equal(c.value, 1250.5);
  assert.deepEqual(c.tags, ["clinic", "vip"]);
  assert.equal(c.followUp, "2026-12-01");
  assert.equal(cleanContact({ name: "x", email: "not an email" }, DEFAULT_STAGES), null);
  assert.equal(cleanContact({}, DEFAULT_STAGES), null);
  assert.equal(cleanContact({ company: "Acme", stage: "Nope", value: "-5", followUp: "tomorrow" }, DEFAULT_STAGES)!.stage, "New");
  assert.equal(cleanContact({ company: "Acme", value: "-5" }, DEFAULT_STAGES)!.value, 0);
  assert.equal(cleanContact({ company: "Acme", followUp: "tomorrow" }, DEFAULT_STAGES)!.followUp, null);
});

test("stages: 2 to 12, no repeats", () => {
  assert.deepEqual(cleanStages(["New", " new ", "Won", ""]), ["New", "Won"]);
  assert.equal(cleanStages(["Only"]), null);
  assert.equal(cleanStages("New"), null);
  assert.equal(cleanStages(Array.from({ length: 13 }, (_, i) => `S${i}`)), null);
});

test("templates fill in the contact's names", () => {
  assert.equal(fillTemplate("Hi {first_name} at {company}", { name: "Ana Lopez", company: "Healing Hands" }), "Hi Ana at Healing Hands");
  assert.equal(fillTemplate("Hi {First_Name}, {company}", { name: "", company: "" }), "Hi there, your business");
});

test("a CSV with quotes, commas and line breaks is read, and columns are matched by name", () => {
  const rows = parseCsv('First Name,Last Name,E-mail,Company,Notes\r\nAna,Lopez,ana@x.com,"Healing Hands, LLC","line one\nline two"\n\n,,bob@y.com,,\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[1][3], "Healing Hands, LLC");
  const list = rowsToContacts(rows);
  assert.equal(list[0].name, "Ana Lopez");
  assert.equal(list[0].email, "ana@x.com");
  assert.equal(list[0].company, "Healing Hands, LLC");
  assert.equal(list[1].email, "bob@y.com");
  assert.deepEqual(rowsToContacts([["Name"]]), []);
});

test("renaming a stage in place keeps its contacts; removing one sends them to the first stage", async () => {
  const { stageMoves } = await import("../src/lib/analytics/crm");
  assert.deepEqual(stageMoves(["New", "Meeting", "Won"], ["New", "Meetings", "Won"]), [{ from: "Meeting", to: "Meetings", renamed: true }]);
  assert.deepEqual(stageMoves(["New", "Meeting", "Won"], ["New", "Won"]), [{ from: "Meeting", to: "New", renamed: false }]);
  assert.deepEqual(stageMoves(["New", "Won"], ["New", "Won", "Lost"]), []);
});
