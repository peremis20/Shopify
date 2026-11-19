import { test } from "node:test";
import assert from "node:assert/strict";
import { boardFacts, type TeamNote } from "../src/lib/analytics/autopilot/team";
import { teamLines } from "../src/lib/analytics/autopilot/alerts";
import { cleanPlace, isoWeek, searchesFor } from "../src/lib/analytics/autopilot/prospect-finder";
import { cleanFinder, nextWeekday } from "../src/lib/analytics/crm";

const note = (agent: string, kind: TeamNote["kind"], text: string, extra: Partial<TeamNote> = {}): TeamNote => ({
  id: String(Math.random()),
  agent,
  kind,
  to: null,
  text,
  at: "2026-11-19T12:00:00.000Z",
  done: false,
  ...extra,
});

test("the board becomes facts for the Strategist: open needs first, then a few notes per agent", () => {
  const facts = boardFacts([
    note("CRM", "needs", "3 emails are waiting for your Send click."),
    note("Prospect finder", "did", "Found 12 new businesses."),
    note("Prospect finder", "did", "Older note."),
    note("CRM", "found", "Won a deal with Inwood Chiropractic."),
    note("Leads keeper", "handoff", "A request came in.", { to: "CRM" }),
    note("CRM", "needs", "Fixed already.", { done: true }),
  ]);
  assert.match(facts[0], /^Waiting on the owner \(team board\): CRM: 3 emails/);
  assert.ok(!facts.join(" ").includes("Fixed already"));
  assert.ok(facts.some((f) => f.startsWith("Team board, Prospect finder this week: Found 12 new businesses. | Older note.")));
  assert.ok(facts.some((f) => f.includes("handed to CRM: A request came in.")));
  assert.deepEqual(boardFacts([]), []);
});

test("the weekly report shows what waits on the owner and two notes per agent, not the Inspector's", () => {
  const t = teamLines([
    note("Inspector", "needs", "Reconnect Search Console."),
    note("Inspector", "did", "Repaired a link."),
    note("Strategist", "did", "Planned the week."),
    note("Prospect finder", "did", "One."),
    note("Prospect finder", "did", "Two."),
    note("Prospect finder", "did", "Three."),
  ]);
  assert.deepEqual(t.needs, ["Inspector: Reconnect Search Console."]);
  assert.deepEqual(t.did, ["Strategist: Planned the week.", "Prospect finder: One.", "Prospect finder: Two."]);
});

test("the finder's settings: lists by line, short words dropped, a sane weekly cap, off by default", () => {
  assert.deepEqual(cleanFinder(undefined), { on: false, kinds: [], places: [], perWeek: 25 });
  const f = cleanFinder({ on: true, kinds: "chiropractor\nnaturopathic doctor\nchiropractor\nx", places: ["Dallas, TX", " Plano, TX "], perWeek: 40 });
  assert.deepEqual(f, { on: true, kinds: ["chiropractor", "naturopathic doctor"], places: ["Dallas, TX", "Plano, TX"], perWeek: 40 });
  assert.equal(cleanFinder({ perWeek: 1000 }).perWeek, 25);
  assert.equal(cleanFinder({ on: "yes" }).on, false);
});

test("every kind is searched in every place, in a steady order", () => {
  assert.deepEqual(searchesFor({ kinds: ["chiropractor", "naturopath"], places: ["Dallas, TX", "Plano, TX"] }), [
    "chiropractor in Dallas, TX",
    "naturopath in Dallas, TX",
    "chiropractor in Plano, TX",
    "naturopath in Plano, TX",
  ]);
});

test("a Google Maps listing is kept only with a way to reach it, and its website is trimmed to the page", () => {
  const p = cleanPlace({ title: "Inwood Chiropractic", address: "5310 Harvest Hill Rd, Dallas, TX", phoneNumber: "(214) 902-0092", website: "https://inwoodchiro.com/?utm_source=gmb", category: "Chiropractor", rating: 4.9, ratingCount: 120, cid: "123" })!;
  assert.equal(p.website, "https://inwoodchiro.com");
  assert.equal(p.phone, "(214) 902-0092");
  assert.equal(p.rating, 4.9);
  assert.equal(p.cid, "123");
  assert.equal(cleanPlace({ title: "No way in" }), null);
  assert.equal(cleanPlace({ title: "Bad link", website: "javascript:alert(1)" }), null);
  assert.ok(cleanPlace({ title: "Phone only", phoneNumber: "214-555-0101", address: "Dallas" })!.cid.length > 0);
});

test("weeks and weekdays", () => {
  assert.equal(isoWeek(new Date("2026-11-19T12:00:00Z")), "2026-W47");
  assert.equal(isoWeek(new Date("2027-01-01T12:00:00Z")), "2026-W53");
  // Thursday to Friday; Friday and Saturday to Monday.
  assert.equal(nextWeekday(new Date("2026-11-19T12:00:00Z")), "2026-11-20");
  assert.equal(nextWeekday(new Date("2026-11-20T12:00:00Z")), "2026-11-23");
  assert.equal(nextWeekday(new Date("2026-11-21T12:00:00Z")), "2026-11-23");
});
