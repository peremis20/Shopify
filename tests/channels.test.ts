import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnattributed, splitLeads, unattributedNote } from "../src/lib/analytics/autopilot/channels";

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
