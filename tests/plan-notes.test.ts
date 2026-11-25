import { test } from "node:test";
import assert from "node:assert/strict";
import { droppedSummary, dropReason } from "../src/lib/analytics/autopilot/plan-notes";

const DATA = "Dropped: what it rests on isn't in this week's data.";

test("plan notes: nothing dropped says nothing", () => {
  assert.equal(droppedSummary([{ kept: true, challenge: "ok" }]), null);
});

test("plan notes: dropped ideas are grouped by reason in plain words", () => {
  const s = droppedSummary([
    { kept: false, challenge: DATA },
    { kept: false, challenge: DATA },
    { kept: false, challenge: 'Dropped: "x" isn\'t in the site\'s data or isn\'t on topic.' },
    { kept: false, challenge: "Dropped: it names no search to work on." },
    { kept: false, challenge: "The evidence isn't in this week's data, and the page is already first." },
    { kept: false, challenge: "" },
    { kept: true, challenge: "Backed." },
  ])!;
  assert.match(s, /^6 ideas were turned down: 2 weren't backed by this week's data/);
  assert.match(s, /1 named a search that isn't in your data/);
  assert.match(s, /1 named no search/);
  assert.match(s, /1 was judged unsupported by the second AI/);
  assert.match(s, /1 got no verdict from the second AI/);
  assert.doesNotMatch(s, /[-–—]/);
});

test("plan notes: ideas left for next week are not called turned down", () => {
  const s = droppedSummary([{ kept: false, challenge: "Left for next week: five moves are already planned." }])!;
  assert.equal(s, "1 backed idea waits for next week because five moves are already planned.");
  const both = droppedSummary([{ kept: false, challenge: DATA }, { kept: false, challenge: "Left for next week: five moves are already planned." }])!;
  assert.match(both, /1 more backed idea waits/);
  assert.match(droppedSummary([{ kept: false, challenge: "Left for next week: x" }], { label: "From the Authority Coach's plan, " })!, /^From the Authority Coach's plan, 1 backed idea waits/);
  const one = droppedSummary([{ kept: false, challenge: DATA }], { label: "From the Authority Coach's plan, ", closing: false })!;
  assert.equal(one, "From the Authority Coach's plan, 1 idea was turned down: it wasn't backed by this week's data.");
});

test("plan notes: a blank reason is never shown blank", () => {
  assert.equal(dropReason(""), "No reason was given.");
  assert.equal(dropReason("Too broad."), "Too broad.");
});
