import { test } from "node:test";
import assert from "node:assert/strict";
import { goalNote, goalWhy, nextMilestone } from "../src/lib/analytics/autopilot/goal";

test("goal: the next step is close to where the site is", () => {
  assert.equal(nextMilestone(0, 20000), 100);
  assert.equal(nextMilestone(54, 20000), 100);
  assert.equal(nextMilestone(100, 20000), 500);
  assert.equal(nextMilestone(12000, 20000), 20000);
  assert.equal(nextMilestone(30, 50), 50);
});

test("goal: zero, small, unknown and reached are explained, without dashes", () => {
  for (const v of [null, 0, 54, 25000]) assert.doesNotMatch(goalNote(v, 20000), /[-–—]/);
  assert.match(goalNote(null, 20000), /^Not measured yet\./);
  assert.match(goalNote(0, 20000), /^No clicks from Google search in this period\. First step: 100 a month\./);
  assert.match(goalNote(54, 20000), /^Next step: 100 a month\./);
  assert.match(goalNote(25000, 20000), /^Goal reached/);
  assert.match(goalNote(25000, 20000, { estimate: true }), /^On pace for the goal/);
  assert.match(goalWhy(20000), /^20,000 a month/);
});
