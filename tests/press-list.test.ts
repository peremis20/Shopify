import { test } from "node:test";
import assert from "node:assert/strict";
import { composeCurrent, composeDone, composeStart, composeStep, fillTemplate } from "../src/lib/analytics/autopilot/press-crm";
import { dedupeKey, guessColumns, IMPORT_BATCH, IMPORT_ORDER, mapRow, NOT_LISTED, outletFromEmail, parseCsv, planImport, rejectsCsv } from "../src/lib/analytics/autopilot/press-import";
import {
  bulkJournalists,
  cleanTemplate,
  importJournalists,
  likePattern,
  listJournalists,
  listMetrics,
  migrateOwnerNotes,
  parseListQuery,
  saveTemplate,
  splitNotes,
  TEMPLATE_MAX,
} from "../src/lib/analytics/autopilot/press-list";
import type { Sql } from "../src/lib/analytics/autopilot/press";

/** A stand in for the database: records each statement, answers with `answer`. */
const recorder = (answer: (text: string, values: unknown[]) => Record<string, unknown>[] = () => []) => {
  const calls: { text: string; values: unknown[] }[] = [];
  const q: Sql = async (strings, ...values) => {
    const text = strings.join("$").replace(/\s+/g, " ");
    calls.push({ text, values });
    return answer(text, values) as never;
  };
  return { q, calls };
};

test("import: the columns are guessed from the headers, each field once", () => {
  assert.deepEqual(
    guessColumns(["First Name", "Last Name", "Email Address", "Phone Number", "Job Title", "Company", "City", "Beat", "LinkedIn", "Article URL", "Notes", "Shoe size"]),
    ["firstName", "lastName", "email", "phone", "jobTitle", "outlet", "location", "field", "profileUrl", "articleUrl", "notes", "ignore"],
  );
  assert.deepEqual(guessColumns(["Name", "Publication", "Industry", "Article Title", "Article Link"]), ["fullName", "outlet", "field", "articleTitle", "articleUrl"]);
  assert.deepEqual(guessColumns(["email", "e-mail"]), ["email", "ignore"]);
});

test("import: CSV cells with commas, quotes and line breaks are read whole", () => {
  const rows = parseCsv('﻿Name,Notes\r\n"Ortiz, Sam","Said ""hi""\nthen left"\r\n\r\nDana,plain\n');
  assert.deepEqual(rows, [["Name", "Notes"], ["Ortiz, Sam", 'Said "hi"\nthen left'], ["Dana", "plain"]]);
  assert.deepEqual(parseCsv("a;b\n1;2"), [["a", "b"], ["1", "2"]]);
});

test("import: an empty outlet comes from a work email's domain; a free email is Not listed", () => {
  assert.equal(outletFromEmail("dana@DailyHealth.example"), "dailyhealth.example");
  assert.equal(outletFromEmail("dana@gmail.com"), NOT_LISTED);
  assert.equal(outletFromEmail("x@yahoo.co.uk"), NOT_LISTED);
  assert.equal(outletFromEmail("x@verizon.net"), NOT_LISTED);
  assert.equal(outletFromEmail(""), "");
  const map = guessColumns(["Name", "Email", "Outlet"]);
  const r = mapRow(["Dana Whitfield", "dana@wellness.example", ""], map);
  assert.ok("row" in r && r.row.outlet === "wellness.example");
  const kept = mapRow(["Dana Whitfield", "dana@gmail.com", "Daily Health"], map);
  assert.ok("row" in kept && kept.row.outlet === "Daily Health"); // a given outlet is never replaced
});

test("import: duplicates by email (any case), else by name and outlet, in the file and against the list", () => {
  const map = guessColumns(["Name", "Email", "Outlet"]);
  const rows = [
    ["Dana Whitfield", "Dana@Daily.example", "Daily"],
    ["Dana W.", "dana@daily.example", "Daily"], // same email
    ["Sam Ortiz", "", "Wellness Weekly"],
    ["sam  ortiz", "", "wellness weekly"], // same name and outlet
    ["Sam Ortiz", "", "Other Outlet"], // another outlet: someone else
    ["Lee Park", "lee@known.example", "Known"], // already on the list
  ];
  const existing = new Set([dedupeKey({ email: "LEE@known.example", name: "x", outlet: "y" })]);
  const plan = planImport(rows, map, existing);
  assert.deepEqual(plan.add.map((r) => r.name), ["Dana Whitfield", "Sam Ortiz", "Sam Ortiz"]);
  assert.equal(plan.duplicates, 3);
  assert.equal(plan.rejects.length, 0);
});

test("import: rows that can't be imported are listed with their row and reason, and offered as a CSV", () => {
  const headers = ["Name", "Email", "Outlet", "Profile"];
  const map = guessColumns(headers);
  const plan = planImport(
    [
      ["", "a@b.example", "B"],
      ["Sam", "not an email", "X"],
      ["Lee", "", ""],
      ["Kim Ray", "", "Y", "javascript:alert(1)"],
      ["Ok Person", "", "Z"],
    ],
    map,
  );
  assert.equal(plan.add.length, 1);
  assert.deepEqual(plan.rejects.map((r) => [r.line, r.reason]), [
    [2, "Add their name."],
    [3, "That email doesn't look right."],
    [4, "Add where they publish."],
    [5, "The profile link should start with https://."],
  ]);
  const csv = rejectsCsv(headers, plan.rejects).trim().split("\r\n");
  assert.equal(csv[0], '"Row","Why it was skipped","Name","Email","Outlet","Profile"');
  assert.equal(csv.length, 5);
  assert.match(csv[2], /^"3","That email doesn't look right.","Sam","not an email","X"$/);
});

test("import: rows go in 500 per statement, checked again on the server, as the owner's own with the list name", async () => {
  const rows = Array.from({ length: 1200 }, (_, i) => ["Person " + i, "", `p${i}@outlet.example`].slice(0, 0).concat([`Person ${i}`, "", "Outlet", `p${i}@outlet.example`, "", "", "", "", "", "", ""]));
  const { q, calls } = recorder((text, values) => {
    if (/^SELECT data ->> 'email'/.test(text.trim())) return [{ email: "p5@outlet.example", name: "Person 5", outlet: "Outlet" }];
    if (/INSERT INTO insights_press_items/.test(text)) return JSON.parse(String(values[1])).map((x: { id: string }) => ({ item_id: x.id }));
    return [];
  });
  let n = 0;
  const out = await importJournalists("1", rows, "Help a Reporter November", () => (n++).toString(16).padStart(16, "0"), q);
  const inserts = calls.filter((c) => /INSERT INTO insights_press_items/.test(c.text));
  assert.equal(inserts.length, 3);
  const sizes = inserts.map((c) => JSON.parse(String(c.values[1])).length);
  assert.deepEqual(sizes, [500, 500, 199]);
  assert.ok(sizes.every((s) => s <= IMPORT_BATCH));
  assert.match(inserts[0].text, /ON CONFLICT \(account_id, kind, item_id\) DO NOTHING RETURNING item_id/);
  const first = JSON.parse(String(inserts[0].values[1]))[0];
  assert.equal(first.data.source, "owner");
  assert.equal(first.data.outlet, "Outlet");
  assert.deepEqual(first.owner.tags, ["Help a Reporter November"]);
  assert.equal(out.added, 1199);
  assert.equal(out.duplicates, 1);
  // More than one request's worth is refused.
  await assert.rejects(importJournalists("1", Array.from({ length: 2001 }, () => []), null, () => "x", q), /at most 2000/);
  assert.equal(IMPORT_ORDER.length, 11);
});

test("list: paging, search and filters run in one SQL statement with every value as a parameter", async () => {
  const { q, calls } = recorder(() => [{ data: JSON.stringify({ id: "a", name: "Dana", outlet: "D", source: "owner" }), owner: JSON.stringify({ status: "pitched", tags: ["Nov"] }), total: "123" }]);
  const query = parseListQuery(new URLSearchParams("q=O_Brien%25&status=emailed&tag=Nov&field=Health&due=1&hasEmail=true&sort=last&page=2"));
  assert.deepEqual(query, { q: "O_Brien%", status: "emailed", tag: "Nov", field: "Health", due: true, hasEmail: true, sort: "last", page: 2 });
  const out = await listJournalists("1", query, ["othercustomer.com"], "2026-11-16", q);
  assert.equal(out.total, 123);
  assert.equal(out.rows[0].status, "emailed"); // an earlier "pitched" reads as Emailed
  assert.deepEqual(out.rows[0].tags, ["Nov"]);
  assert.equal(calls.length, 1);
  const { text, values } = calls[0];
  assert.match(text, /WHERE account_id = \$ AND kind = 'journalist'/);
  assert.match(text, /LIMIT \$ OFFSET \$$/);
  assert.equal(values.at(-1), 100);
  assert.equal(values.at(-2), 50);
  assert.ok(values.includes("%o\\_brien\\%%")); // the search's own % and _ are literal
  assert.ok(values.includes("emailed") && values.includes("Nov") && values.includes("Health") && values.includes("last"));
  assert.ok(values.includes('["othercustomer.com"]'));
  assert.ok(!/O_Brien|othercustomer/.test(text)); // nothing from the owner is in the statement's text
  // Without the customer list only the owner's own rows can show.
  const safe = recorder();
  await listJournalists("1", parseListQuery(null), null, "2026-11-16", safe.q);
  assert.ok(safe.calls[0].values.includes(false));
  assert.equal(likePattern(null), null);
  assert.deepEqual(parseListQuery({ status: "evil", sort: "drop table", page: -3 }), { q: null, status: null, tag: null, field: null, due: false, hasEmail: false, sort: "recent", page: 0 });
  // The metrics strip: one aggregate query.
  const m = recorder(() => [{ total: "10", new_week: "2", emailed_week: "1", emailed_ever: "4", replies: "1", coverage: "1", due: "3", ready: "2", found: "12" }]);
  const metrics = await listMetrics("1", [], Date.parse("2026-11-16T12:00:00Z"), m.q);
  assert.equal(m.calls.length, 1);
  assert.match(m.calls[0].text, /count\(\*\) FILTER/);
  assert.equal(metrics.replyRate, 25);
  assert.deepEqual(metrics.funnel, { found: 12, emailed: 4, replied: 1, covered: 1 });
});

test("bulk: a status for many rows is one statement, with a history line, and only for this account", async () => {
  const ids = ["0123456789abcdef", "fedcba9876543210", "not an id", "0123456789abcdef"];
  const { q, calls } = recorder(() => [{ item_id: "x" }, { item_id: "y" }]);
  const n = await bulkJournalists("1", ids, { kind: "status", status: "emailed" }, q, Date.parse("2026-11-16T12:00:00Z"));
  assert.equal(n, 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /UPDATE insights_press_items SET owner = owner \|\| \$::jsonb \|\| jsonb_build_object\('history'/);
  assert.match(calls[0].text, /WHERE account_id = \$ AND kind = 'journalist' AND item_id IN/);
  const patch = JSON.parse(String(calls[0].values[0]));
  assert.equal(patch.status, "emailed");
  assert.equal(patch.lastContacted, "2026-11-16");
  assert.equal(patch.followUp, "2026-11-23");
  assert.deepEqual(JSON.parse(String(calls[0].values[1])), [{ at: patch.statusAt, status: "emailed" }]);
  assert.deepEqual(JSON.parse(String(calls[0].values.find((v) => typeof v === "string" && v.startsWith("[\"0")))), ["0123456789abcdef", "fedcba9876543210"]);
  await assert.rejects(bulkJournalists("1", ids, { kind: "status", status: "pitched" }, q), /Pick a status/);
  assert.equal(await bulkJournalists("1", [], { kind: "status", status: "new" }, q), 0);
  const tag = recorder(() => []);
  await bulkJournalists("1", ["0123456789abcdef"], { kind: "tag", tag: "  Help a Reporter  " }, tag.q);
  assert.ok(tag.calls[0].values.includes("Help a Reporter"));
});

test("bulk: delete removes only rows the owner added or imported", async () => {
  const { q, calls } = recorder(() => [{ item_id: "x" }]);
  assert.equal(await bulkJournalists("1", ["0123456789abcdef", "fedcba9876543210"], { kind: "delete" }, q), 1);
  assert.match(calls[0].text, /^\s*DELETE FROM insights_press_items WHERE account_id = \$ AND kind = 'journalist' AND data ->> 'source' = 'owner' AND item_id IN/);
});

test("migration: Location and Field move out of the notes into their own fields, once", async () => {
  assert.deepEqual(splitNotes("Location: Austin, TX; Field: Health; met at expo"), { location: "Austin, TX", field: "Health", rest: "met at expo" });
  assert.deepEqual(splitNotes("Field: Food"), { location: null, field: "Food", rest: null });
  assert.deepEqual(splitNotes("location:Paris|field: Travel"), { location: "Paris", field: "Travel", rest: null });
  assert.equal(splitNotes("Prefers phone calls"), null);
  assert.equal(splitNotes(null), null);
  const { q, calls } = recorder((text) => (/^SELECT item_id/.test(text.trim()) ? [{ item_id: "abc", notes: "Location: Austin; Field: Health; likes data" }] : [{ item_id: "abc" }]));
  assert.equal(await migrateOwnerNotes("1", q), 1);
  const up = calls[1];
  assert.match(up.text, /SET data = data \|\| \$::jsonb, owner = owner \|\| \$::jsonb/);
  // Only while the notes are unchanged and nothing moved yet: running again (or twice at once) changes nothing.
  assert.match(up.text, /AND owner ->> 'notes' = \$ AND data ->> 'location' IS NULL AND data ->> 'field' IS NULL/);
  assert.deepEqual(JSON.parse(String(up.values[0])), { location: "Austin", field: "Health" });
  assert.deepEqual(JSON.parse(String(up.values[1])), { notes: "likes data" });
  assert.match(calls[0].text, /data ->> 'source' = 'owner'/);
});

test("compose: merge fields are filled from each person's own row", () => {
  const j = { name: "Dana Whitfield", outlet: "Daily Health", articleTitle: "Sleep routines", field: "Health", location: null };
  const r = fillTemplate("Hi {first_name}, I read {Article_Title} in { outlet }. {last_name} {unknown} {location}.", j);
  assert.equal(r.text, "Hi Dana, I read Sleep routines in Daily Health. Whitfield {unknown}.");
  assert.deepEqual(r.missing, ["location"]);
  assert.deepEqual(fillTemplate("Hi {first_name} at {outlet}", { name: "Sam", outlet: "Not listed" }), { text: "Hi Sam at", missing: ["outlet"] });
});

test("compose: one person at a time, each marked sent only after Yes", () => {
  let s = composeStart(["a", "b", "c", "a"]);
  assert.deepEqual(s.ids, ["a", "b", "c"]);
  assert.equal(composeCurrent(s), "a");
  s = composeStep(s, "sent"); // not opened yet: nothing happens
  assert.equal(composeCurrent(s), "a");
  s = composeStep(s, "opened");
  s = composeStep(s, "notSent"); // they said No: still on the same person
  assert.equal(composeCurrent(s), "a");
  assert.deepEqual(s.sent, []);
  s = composeStep(composeStep(s, "opened"), "sent");
  assert.deepEqual(s.sent, ["a"]);
  assert.equal(composeCurrent(s), "b");
  s = composeStep(s, "skip");
  assert.deepEqual(s.skipped, ["b"]);
  s = composeStep(s, "back");
  assert.equal(composeCurrent(s), "b");
  s = composeStep(composeStep(s, "opened"), "sent");
  assert.deepEqual(s.skipped, []);
  s = composeStep(composeStep(s, "opened"), "sent");
  assert.ok(composeDone(s));
  assert.deepEqual(s.sent, ["a", "b", "c"]);
});

test("templates: checked, and at most thirty per account, taken in one statement", async () => {
  assert.equal(cleanTemplate({ name: "", subject: "s", body: "b" }).ok, false);
  assert.equal(cleanTemplate({ name: "Intro", subject: "", body: "b" }).ok, false);
  const { q, calls } = recorder(() => []);
  await assert.rejects(saveTemplate("1", { name: "Intro", subject: "Hi", body: "Hello {first_name}" }, () => "0123456789abcdef", q), /up to 30 templates/);
  assert.match(calls[0].text, /INSERT INTO insights_press_templates .* WHERE \(SELECT count\(\*\) FROM insights_press_templates WHERE account_id = \$\) < \$ RETURNING id/);
  assert.ok(calls[0].values.includes(TEMPLATE_MAX));
});
