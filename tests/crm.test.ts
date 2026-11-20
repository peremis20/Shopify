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

test("a shelf count works out what sold and what is owed, and refuses more than was there", async () => {
  const { countMath, digestText, sumOrders } = await import("../src/lib/analytics/crm");
  assert.deepEqual(countMath(12, 5, 17.49), { sold: 7, owed: 122.43 });
  assert.deepEqual(countMath(12, 12, 17.49), { sold: 0, owed: 0 });
  assert.equal(countMath(12, 13, 17.49), null);
  assert.equal(digestText([{ subject: "Call back", due: "2026-12-01", who: "Ana" }], "2026-11-30"), null);
  const text = digestText([{ subject: "Call back", due: "2026-11-28", who: "Ana" }, { subject: "Count the shelf", due: "2026-11-30", who: "Healing Hands" }], "2026-11-30")!;
  assert.match(text, /2 things to do/);
  assert.match(text, /Late, since Nov 28: Call back for Ana/);
  assert.match(text, /Today: Count the shelf for Healing Hands/);
  assert.doesNotMatch(text, /[\u2010-\u2015-]/);
  const o = sumOrders([
    { name: "#1003", createdAt: "2026-11-10T00:00:00Z", cancelledAt: null, displayFinancialStatus: "PAID", net: "41.99", currency: "USD" },
    { name: "#1002", createdAt: "2026-10-01T00:00:00Z", cancelledAt: "2026-10-02T00:00:00Z", displayFinancialStatus: "REFUNDED", net: "0", currency: "USD" },
    { name: "#1001", createdAt: "2026-09-01T00:00:00Z", cancelledAt: null, displayFinancialStatus: "PARTIALLY_REFUNDED", net: "10.00", currency: "USD" },
  ], false);
  // The cancelled order doesn't count; paid and partly refunded ones do.
  assert.equal(o.count, 2);
  assert.equal(o.total, 51.99);
  assert.equal(sumOrders([{ name: "#9", createdAt: "2026-11-10T00:00:00Z", cancelledAt: null, displayFinancialStatus: "PENDING", net: "30", currency: "USD" }], false).count, 0);
  assert.equal(o.last, "2026-11-10T00:00:00Z");
  assert.equal(o.recent[1].status, "partially refunded");
});

test("a clinic list with Contact Person, Clinic, City and Notes columns is read in full", () => {
  const rows = parseCsv('Clinic,Contact Person,Email,Phone,Address,City,Notes\n"Atlas Chiropractic & Wellness","Dr. Brown M. Hamer III, DC","info@atlas.net","(214) 999-1019","2811 McKinney Ave #240","Dallas","4.9 stars"\n"Uptown Chiropractic","Dr. Lynne Auerbach, DC","","(214) 979-9013","2909 Cole Ave","Dallas","No email"\n');
  const list = rowsToContacts(rows);
  assert.equal(list[0].company, "Atlas Chiropractic & Wellness");
  assert.equal(list[0].name, "Dr. Brown M. Hamer III, DC");
  assert.equal(list[0].address, "2811 McKinney Ave #240, Dallas");
  assert.equal(list[0].notes, "4.9 stars");
  assert.equal(list[1].email, "");
  // A row without an email is still a contact.
  assert.ok(cleanContact(list[1], DEFAULT_STAGES));
  assert.ok(cleanContact({ phone: "(817) 413-0080" }, DEFAULT_STAGES));
});

test("any column layout: best names win, unknown columns can go to notes, the address isn't repeated", async () => {
  const { guessMapping, mapRows } = await import("../src/lib/analytics/csv");
  assert.deepEqual(guessMapping(["Contact", "Contact Person", "Type", "Business Type", "Rating"]), ["", "name", "", "kind", ""]);
  const rows = [["Practice", "Dr", "Full address", "City", "Rating"], ["Hanks Chiropractic", "Dr. Ricky Hanks", "11411 E Northwest Hwy, Dallas", "Dallas", "4.8"]];
  const out = mapRows(rows, ["company", "name", "address", "city", "note"]);
  assert.equal(out[0].company, "Hanks Chiropractic");
  assert.equal(out[0].name, "Dr. Ricky Hanks");
  assert.equal(out[0].address, "11411 E Northwest Hwy, Dallas");
  assert.equal(out[0].notes, "Rating: 4.8");
});

test("a city that is part of a street name is still added", async () => {
  const { mapRows } = await import("../src/lib/analytics/csv");
  assert.equal(mapRows([["Street", "City"], ["100 Dallas Pkwy", "Dallas"]], ["address", "city"])[0].address, "100 Dallas Pkwy, Dallas");
  assert.equal(mapRows([["Street", "City", "State"], ["5 Main St, Dallas, TX", "Dallas", "TX"]], ["address", "city", "state"])[0].address, "5 Main St, Dallas, TX");
});

test("emails written for the owner: greeting, city, and the owner's offer kept word for word", async () => {
  const { greetingFor, cityOf, composeDraft } = await import("../src/lib/analytics/crm");
  assert.equal(greetingFor("Dr. Brown M. Hamer III, DC"), "Hi Dr. Hamer,");
  assert.equal(greetingFor("Dr. Jeffery (Jeff) Johnson"), "Hi Dr. Johnson,");
  assert.equal(greetingFor("Dr. Mark Mathis Jr., DC"), "Hi Dr. Mathis,");
  assert.equal(greetingFor("Ana Lopez"), "Hi Ana,");
  assert.equal(greetingFor(""), "Hello,");
  assert.equal(cityOf("2811 McKinney Ave #240, Dallas"), "Dallas");
  assert.equal(cityOf("5 Main St, Plano, TX 75024"), "Plano");
  assert.equal(cityOf("3600 Hulen St, Ste A4"), "");
  assert.equal(cityOf("3825 Yucca Ave"), "");
  const offer = "Clinics keep 30% of every sale. 12 bottles, nothing up front.";
  const body = composeDraft({ name: "Dr. Tim Davis", opening: "I run Peremis.", offer, link: "https://peremis.com/pages/wholesale", signoff: "Jimmy, Peremis", brand: "Peremis" });
  assert.match(body, /^Hi Dr\. Davis,\n\nI run Peremis\.\n\nClinics keep 30% of every sale\. 12 bottles, nothing up front\.\n\nMore here: https:\/\/peremis\.com\/pages\/wholesale\n\nThank you,\nJimmy, Peremis$/);
});

test("greetings use Mr, Mrs and Ms with the last name", async () => {
  const { greetingFor } = await import("../src/lib/analytics/crm");
  assert.equal(greetingFor("Mr. John Smith"), "Hi Mr. Smith,");
  assert.equal(greetingFor("mrs Ana Lopez"), "Hi Mrs. Lopez,");
});

test("templates greet a doctor as Dr. Lastname", async () => {
  const { fillTemplate } = await import("../src/lib/analytics/crm");
  assert.equal(fillTemplate("Hi {first_name},", { name: "Dr. Brown M. Hamer III, DC", company: "" }), "Hi Dr. Hamer,");
  assert.equal(fillTemplate("Hi {first_name},", { name: "Ana Lopez", company: "" }), "Hi Ana,");
});

test("a lone title is no name", async () => {
  const { greetingFor } = await import("../src/lib/analytics/crm");
  assert.equal(greetingFor("Dr."), "Hello,");
});

test("two word surnames and legal endings", async () => {
  const { fillTemplate } = await import("../src/lib/analytics/crm");
  assert.equal(fillTemplate("{first_name}", { name: "Dr. Troy Van Biezen, DC", company: "" }), "Dr. Van Biezen");
  assert.equal(fillTemplate("{first_name}", { name: "Dr. Brown M. Hamer III, DC", company: "" }), "Dr. Hamer");
  assert.equal(fillTemplate("{first_name}", { name: "Dr. Van", company: "" }), "Dr. Van");
  assert.equal(fillTemplate("{company}", { name: "", company: "Expressions Chiropractic of Dallas PC" }), "Expressions Chiropractic of Dallas");
  assert.equal(fillTemplate("{company}", { name: "", company: "Atlas Chiropractic & Wellness" }), "Atlas Chiropractic & Wellness");
});

test("only documents and images can be uploaded", async () => {
  const { uploadType } = await import("../src/lib/analytics/crm");
  assert.equal(uploadType("Signed agreement.PDF"), "application/pdf");
  assert.equal(uploadType("w9.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(uploadType("page.html"), null);
  assert.equal(uploadType("image.svg"), null);
  assert.equal(uploadType("run.exe"), null);
  assert.equal(uploadType("noextension"), null);
});

test("the owner's first email template fills Dr. and the last name, and a missing name reads well", () => {
  const body = "Hi {first_name},\n\nI'm Jimmy with Peremis.";
  assert.equal(fillTemplate(body, { name: "Dr. Paul L. Fowler", company: "Expressions Chiropractic of Dallas PC" }).split("\n")[0], "Hi Dr. Fowler,");
  assert.equal(fillTemplate(body, { name: "", company: "Inwood Chiropractic" }).split("\n")[0], "Hi there,");
});

test("segments: the owner's list cleaned, and a business put in the segment its type or name fits", async () => {
  const { cleanSegments, guessSegment } = await import("../src/lib/analytics/crm");
  const segs = cleanSegments("Users\nChiropractors\nFunctional medicine\nNaturopaths\nWalk in only\nchiropractors\n");
  assert.deepEqual(segs, ["Users", "Chiropractors", "Functional medicine", "Naturopaths", "Walk in only"]);
  assert.equal(guessSegment("Chiropractor Uptown Chiropractic", segs), "Chiropractors");
  assert.equal(guessSegment("Naturopathic practitioner", segs), "Naturopaths");
  assert.equal(guessSegment("Functional medicine doctor", segs), "Functional medicine");
  // One word of two is not enough, so a sports medicine clinic is not put in Functional medicine.
  assert.equal(guessSegment("Highland Park Spine & Sports Medicine", segs), "");
  assert.equal(guessSegment("", segs), "");
});

test("a Segment column is read from a spreadsheet", async () => {
  const rows = rowsToContacts(parseCsv("Clinic,Email,Specialty\nInwood Chiropractic,a@b.co,Chiropractors\n"));
  assert.equal(rows[0].segment, "Chiropractors");
});

test("products to pitch: matched by the practice's type, segment and name, best match first, with the reason", async () => {
  const { matchProducts, productsFromLines, productsToLines } = await import("../src/lib/analytics/pitch");
  const products = productsFromLines("Magnesium Complex: chiropract, sports, sleep\nTurmeric w/BioPerine: chiropract, joint, sports, injury\nEye Health: optometr, vision\nNo words");
  assert.equal(products.length, 4);
  assert.equal(productsToLines(products).split("\n")[0], "Magnesium Complex: chiropract, sports, sleep");
  const m = matchProducts("Chiropractor Chiropractors Premier Injury Clinics Auto Accident Chiropractic", products);
  assert.deepEqual(m.map((x) => x.name), ["Turmeric w/BioPerine", "Magnesium Complex"]);
  assert.deepEqual(m[0].why, ["chiropract", "injury"]);
  assert.deepEqual(matchProducts("Family Optometry Center", products).map((x) => x.name), ["Eye Health"]);
  assert.deepEqual(matchProducts("Bakery", products), []);
});

test("{product} is filled in a template, with a plain fallback", () => {
  assert.equal(fillTemplate("Try {product}", { name: "", company: "" }, "", "Magnesium Complex"), "Try Magnesium Complex");
  assert.equal(fillTemplate("Try {product}", { name: "", company: "" }), "Try our products");
});
