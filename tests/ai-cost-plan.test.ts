import { test } from "node:test";
import assert from "node:assert/strict";
import { aiProvider } from "../src/lib/analytics/autopilot/settings";
import { endRest, hasSecondAi, noteWriter, NO_SECOND_AI, ownerApproves, rest, reviewerOf, reviewProspects } from "../src/lib/analytics/autopilot/writer";
import { pickByTurn } from "../src/lib/analytics/autopilot/new-articles";

const both = () => aiProvider({ groqKey: "g", anthropicKey: "c" } as never)!;

test("cost plan: Groq writes first and Claude checks it", () => {
  const ai = both();
  assert.equal(ai.kind, "groq");
  assert.equal(reviewerOf(ai).kind, "claude");
  assert.equal(hasSecondAi(ai), true);
});

test("cost plan: while Groq rests, Claude writes and never checks its own work; the owner approves", async () => {
  await rest("groq", 3600_000);
  try {
    const ai = both();
    assert.equal(hasSecondAi(ai), false);
    assert.throws(() => reviewerOf(ai), { message: NO_SECOND_AI });
    const prospects = [{ domain: "a.com", title: "A", snippet: "", kind: "resource", topic: "t" }];
    assert.deepEqual(await ownerApproves(ai, () => reviewProspects(ai, "me.com", prospects)), { keep: [true] });
  } finally {
    await endRest(["groq"]);
  }
});

test("cost plan: a service that wrote in this run is never picked to check it", () => {
  const ai = both();
  const copy = { ...ai, site: undefined };
  noteWriter(copy, "claude");
  assert.throws(() => reviewerOf(ai), { message: NO_SECOND_AI });
  // A fresh run starts clean.
  assert.equal(reviewerOf(both()).kind, "claude");
});

test("articles: topics take turns, never written first, then the one written longest ago", () => {
  const due = [
    { keyword: "magnesium for sleep", cluster: "Sleep" },
    { keyword: "lion's mane focus", cluster: "Brain health" },
    { keyword: "b12 energy", cluster: "Energy" },
  ];
  assert.equal(pickByTurn(due, { sleep: 3, "brain health": 2 })?.cluster, "Energy");
  assert.equal(pickByTurn(due, { sleep: 3, "brain health": 2, energy: 5 })?.cluster, "Brain health");
  // Within a topic, the order given (best search first) stands.
  assert.equal(pickByTurn([{ keyword: "a", cluster: "X" }, { keyword: "b", cluster: "X" }], {})?.keyword, "a");
  assert.equal(pickByTurn([], {}), undefined);
});
