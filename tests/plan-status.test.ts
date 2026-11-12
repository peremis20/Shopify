import test from "node:test";
import assert from "node:assert/strict";
import { liveStatus, type StrategyReport } from "../src/lib/analytics/autopilot/strategist";

const move = (kind: string, keyword: string | null, kept = true) =>
  ({ kind, keyword, action: "Write a new article", why: "No page yet.", evidence: "", kept, challenge: "", done: "Already a target." }) as unknown as StrategyReport["moves"][number];
const report = (moves: StrategyReport["moves"]): StrategyReport => ({ at: "2026-11-08T00:00:00Z", assessment: "", moves, visitors: null, goal: 20000 });

test("plan status: a search now matched to an existing page says the agent improves that page", () => {
  const r = liveStatus(report([move("target", "magnesium l threonate")]), [{ keyword: "magnesium l threonate", page: "https://shop.example/blogs/tips/magnesium-threonate-benefits" }]);
  assert.match(r.moves[0].done!, /blogs\/tips\/magnesium-threonate-benefits/);
  assert.match(r.moves[0].done!, /instead of writing a new one/);
});

test("plan status: a live article says done, a target with no page says queued, other moves keep their note", () => {
  const r = liveStatus(report([move("target", "a b c"), move("target", "d e f"), move("outreach", null), move("target", "x y z", false)]), [
    { keyword: "a b c", page: "https://s.example/blogs/x/a", article: { url: "https://s.example/blogs/x/a", live: true } },
    { keyword: "d e f", page: null },
    { keyword: "x y z", page: null },
  ]);
  assert.match(r.moves[0].done!, /^Done/);
  assert.match(r.moves[1].done!, /^Queued/);
  assert.equal(r.moves[2].done, "Already a target.");
  assert.equal(r.moves[3].done, "Already a target.");
});

test("plan status: a broad support search, a draft, or a hard search with no page keep their saved note", () => {
  const r = liveStatus(report([move("target", "a"), move("target", "b c d"), move("target", "e f g")]), [
    { keyword: "a", page: "https://s.example/blogs/x/a", role: "support" },
    { keyword: "b c d", page: null, article: { url: null, live: false } },
    { keyword: "e f g", page: null, winnable: false },
  ]);
  for (const m of r.moves) {
    assert.equal(m.done, "Already a target.");
    assert.equal(m.byAgent, undefined);
  }
});
