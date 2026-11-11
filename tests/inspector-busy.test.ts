/**
 * A run that failed only because free AI services were busy is not shown as a failure;
 * a key or access problem still is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { onlyBusyAi } from "../src/lib/analytics/autopilot/inspector";

test("busy or rate limited AI is a wait, not a failure", () => {
  assert.equal(
    onlyBusyAi('Mistral couldn\'t write this change right now. (mistral-medium-latest: Rate limit exceeded) GitHub Models answered "OK" with no reply, so its key or its access to the models likely needs renewing. gemini is resting until 08:00 UTC after reaching its limit. The next run will try again.'),
    true,
  );
  assert.equal(onlyBusyAi("Gemini is busy right now. (This model is currently experiencing high demand.)"), true);
});

test("key or access problems still count as failures", () => {
  assert.equal(onlyBusyAi("Groq didn't accept the API key. Rate limit exceeded on Mistral."), false);
  assert.equal(onlyBusyAi("The store connection was denied."), false);
  assert.equal(onlyBusyAi("Shopify returned 500."), false);
});
