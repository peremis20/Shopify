/**
 * The status board, the weekly report and the keyword picks tell the truth: a guardrail turning down one email or
 * pitch is not a broken agent, Search Console searches that are only the site's own name or "near me" don't count as
 * something to work from, the weekly counts and the agent counts name their windows, and the focus matches the plan.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { drafterHealth, isTurnedDown } from "../src/lib/analytics/autopilot/backlinks";
import { PART_FIX } from "../src/lib/analytics/autopilot/inspector";
import { pitchFailure } from "../src/lib/analytics/autopilot/press";
import { workableSearch } from "../src/lib/analytics/autopilot/site-keywords";
import { scoreChanges } from "../src/lib/analytics/autopilot/scorecard";
import { weeklyFocus } from "../src/lib/analytics/autopilot/alerts";

const turnedDown = "Couldn't write a safe email for this one (the checking AI turned it down: It reads like a template.). Try again, or write a short note of your own.";

test("outreach drafter: one email turned down while others were written is not a failure", () => {
  assert.equal(isTurnedDown(new Error(turnedDown)), true);
  assert.equal(isTurnedDown(new Error("Groq is busy right now.")), false);
  assert.deepEqual(drafterHealth({ saved: 1, turnedDown: 2, fault: null, turnedDownText: turnedDown }), { ok: true, detail: null });
  assert.deepEqual(drafterHealth({ saved: 0, turnedDown: 0, fault: null }), { ok: true, detail: null });
});

test("outreach drafter: a real fault, or every email turned down, is still shown", () => {
  assert.deepEqual(drafterHealth({ saved: 2, turnedDown: 0, fault: "Add an AI key in platform keys first." }), { ok: false, detail: "Add an AI key in platform keys first." });
  const all = drafterHealth({ saved: 0, turnedDown: 3, fault: null, turnedDownText: turnedDown });
  assert.equal(all.ok, false);
  assert.match(all.detail!, /turned down every email/);
  // The owner is told what really happened, not that it "tries again by itself".
  assert.match(PART_FIX["outreach-drafter"].fix(all.detail!), /Not a missing key or an outage/);
  assert.match(PART_FIX["outreach-drafter"].fix(turnedDown), /Not a missing key or an outage/);
  assert.equal(PART_FIX["outreach-drafter"].fix("Add an AI key in platform keys first."), "Add an AI key in Platform keys.");
});

test("journalists: a pitch the second AI turned down moves on; no second AI waits; a real fault stops", () => {
  assert.equal(pitchFailure("The second AI turned it down: The email calls the product organic, which the source never says."), "next");
  assert.equal(pitchFailure("The claim guard stopped it: \"proven\"."), "next");
  assert.equal(pitchFailure("No second AI from another service was free to check it, so no pitch was written. It tries again next week."), "wait");
  assert.equal(pitchFailure("An AI key is needed to write pitches. It tries again next week."), "stop");
  assert.equal(pitchFailure("It ran out of time and tries again next week."), "stop");
  // A turned down pitch is never answered with "add a second AI key".
  assert.doesNotMatch(PART_FIX.press.fix("The second AI turned it down: it says organic."), /Add a key/);
  assert.match(PART_FIX.press.fix("No second AI from another service was free to check it."), /second AI/);
});

test("keywords: searches for the site's own name or a place don't count as something to work from", () => {
  const brands = [null, "shekinahsda"];
  // The name written with a space, the place, and the address: none to work from, for a faith site too.
  assert.equal(workableSearch("shekinah sda haitian church", brands, true), false);
  assert.equal(workableSearch("haitian church near me", brands, true), false);
  assert.equal(workableSearch("shekinahsda.org", brands, true), false);
  // Topics of its pages count.
  assert.equal(workableSearch("why do seventh day adventists worship on saturday", brands, true), true);
  assert.equal(workableSearch("what happens when you die bible", brands, true), true);
  // Any other site: its brand is left out, its topics count.
  assert.equal(workableSearch("acme tools login", ["Acme Tools"], false), false);
  assert.equal(workableSearch("how to sharpen a chisel", ["Acme Tools"], false), true);
  // A short name never removes ordinary searches that happen to contain it.
  assert.equal(workableSearch("best magnesium for sleep", ["mag"], false), true);
});

test("scorecard: all time and last 7 days are both named, matching the weekly summary", () => {
  const s = scoreChanges([
    { field: "meta_title", made: 14, suggested: 0, compared: 0, up: 0, down: 0, undone: 0, gainSum: 0, week: 5 },
    { field: "meta_description", made: 13, suggested: 0, compared: 0, up: 0, down: 0, undone: 0, gainSum: 0, week: 4 },
    { field: "internal_link", made: 2, suggested: 0, compared: 0, up: 0, down: 0, undone: 0, gainSum: 0, week: 0 },
    { field: "new_article", made: 1, suggested: 0, compared: 0, up: 0, down: 0, undone: 0, gainSum: 0, week: 0 },
  ]);
  assert.equal(s.find((x) => x.agent === "Page improver")!.did, "27 changes made on the site since the start, 9 in the last 7 days");
  assert.equal(s.find((x) => x.agent === "Link builder")!.did, "2 links made on the site since the start, 0 in the last 7 days");
  assert.equal(s.find((x) => x.agent === "Article writer")!.did, "1 article made on the site since the start, 0 in the last 7 days");
});

const move = (keyword: string | null, kept: boolean, action = "Improve the page") =>
  ({ kind: "target", keyword, action, why: "", evidence: "", kept, challenge: "", done: null }) as never;

test("weekly focus: never names an opportunity the plan doesn't act on", () => {
  const assessment = "The site has few visitors. The biggest opportunity is high volume competitor keywords. Traffic is low.";
  assert.equal(weeklyFocus({ assessment, checked: true, moves: [move("competitor keywords", false), move(null, false)] }), "No move is planned this week: the checks found none backed by this site's data.");
  assert.equal(weeklyFocus({ assessment, checked: false, moves: [move("x", true)] }), null);
  assert.equal(weeklyFocus(null), null);
  // A kept move that works on the opportunity: the opportunity sentence stays.
  assert.equal(
    weeklyFocus({ assessment: "Few visitors. The biggest opportunity is \"magnesium for sleep\" at #8.", checked: true, moves: [move("magnesium for sleep", true)] }),
    "The biggest opportunity is \"magnesium for sleep\" at #8.",
  );
  // A kept move on something else: the focus is that move.
  assert.equal(
    weeklyFocus({ assessment: "The biggest opportunity is high volume magnesium searches.", checked: true, moves: [move("partners coupon", true, "Rewrite the title of the partners coupon page")] }),
    "This week's focus: Rewrite the title of the partners coupon page",
  );
});

test("the weekly plan includes the Authority Coach's checked moves, recent ones only", async () => {
  const { plannedMoves } = await import("../src/lib/analytics/autopilot/alerts");
  const now = Date.parse("2026-11-19T12:00:00Z");
  const am = (action: string, kept: boolean) => ({ kind: "outreach" as const, keyword: null, action, why: "", evidence: "", kept, challenge: "" });
  const sm = (action: string, kept: boolean) => ({ keyword: null, page: null, action, kept }) as never;
  const authority = { at: "2026-11-17T00:00:00Z", checked: true, moves: [am("Email two health blogs", true), am("Dropped one", false)] };
  const strategy = { at: "2026-11-17T00:00:00Z", checked: true, moves: [sm("Not kept", false)] };
  const p = plannedMoves(strategy, authority, now);
  assert.equal(p.strategist.length, 0);
  assert.deepEqual(p.authority.map((m) => m.action), ["Email two health blogs"]);
  assert.equal(plannedMoves(strategy, { ...authority, at: "2026-11-01T00:00:00Z" }, now).authority.length, 0);
  assert.equal(plannedMoves(strategy, { ...authority, checked: false }, now).authority.length, 0);
});
