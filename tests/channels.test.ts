import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnattributed, salesGapNote, splitLeads, unattributedNote } from "../src/lib/analytics/autopilot/channels";

test("knows the channels Google Analytics can't tie to a visit", () => {
  assert.equal(isUnattributed("Unassigned"), true);
  assert.equal(isUnattributed("(not set)"), true);
  assert.equal(isUnattributed("Organic Search"), false);
  assert.equal(isUnattributed("Direct"), false);
  assert.equal(isUnattributed("(other)"), false);
});

test("keeps unattributed key events out of leads", () => {
  assert.deepEqual(
    splitLeads([{ name: "Organic Search", keyEvents: 3 }, { name: "Unassigned", keyEvents: 111 }, { name: "Direct", keyEvents: 2 }]),
    { leads: 5, unattributed: 111 },
  );
});

test("explains them in plain words, without dashes", () => {
  assert.equal(unattributedNote(0), null);
  const note = unattributedNote(111)!;
  assert.match(note, /111 key events/);
  assert.doesNotMatch(note, /[-–—]/);
  assert.match(unattributedNote(1)!, /1 key event it/);
});

test("sales gap: explains why Shopify and Analytics differ, only when both have sales", () => {
  assert.equal(salesGapNote(0, 277.25), null);
  assert.equal(salesGapNote(45.98, null), null);
  assert.equal(salesGapNote(45.98, 0), null);
  assert.equal(salesGapNote(45.98, 46.2), null);
  assert.equal(salesGapNote(100, 103), null);
  const up = salesGapNote(45.98, 277.25)!;
  assert.match(up, /^Google Analytics shows less in sales than Shopify this week\./);
  assert.match(salesGapNote(100, 80)!, /shows more in sales/);
  assert.doesNotMatch(up + salesGapNote(100, 80), /[-–—]/);
  assert.equal(salesGapNote(45.98, 277.25, { ga: "USD", shop: "CAD" }), null);
  assert.notEqual(salesGapNote(45.98, 277.25, { ga: "usd", shop: "USD" }), null);
});
