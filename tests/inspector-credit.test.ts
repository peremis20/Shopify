import test from "node:test";
import assert from "node:assert/strict";
import { PART_FIX } from "../src/lib/analytics/autopilot/inspector";

const detail = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';

test("inspector: an AI account out of credit tells the owner where to add credit, not that it was busy", () => {
  for (const part of ["ai", "ai-review"] as const) {
    const fix = PART_FIX[part].fix(detail);
    assert.match(fix, /out of credit/);
    assert.match(fix, /console\.anthropic\.com/);
    assert.doesNotMatch(fix, /busy/);
  }
  assert.match(PART_FIX["ai-review"].fix("Groq: the answer was empty"), /busy/);
});

test("inspector: a token count of 402 in a rate limit is still a wait", () => {
  assert.match(PART_FIX["ai-review"].fix("Groq: Rate limit reached. Limit 500000, Used 499000, Requested 402. Please try again in 2m"), /busy/);
});
