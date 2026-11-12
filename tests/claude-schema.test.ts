import test from "node:test";
import assert from "node:assert/strict";
import { closedSchema } from "../src/lib/analytics/autopilot/writer";

test("claude schema: every object, nested ones too, takes no other fields", () => {
  const s = closedSchema({
    type: "object",
    properties: { items: { type: "array", items: { type: "object", properties: { a: { type: "string" } } } }, meta: { type: "object", properties: {} } },
    required: ["items"],
  }) as any;
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.items.items.additionalProperties, false);
  assert.equal(s.properties.meta.additionalProperties, false);
  assert.deepEqual(s.required, ["items"]);
  assert.equal(s.properties.items.type, "array");
  assert.equal(s.properties.items.additionalProperties, undefined);
});

test("claude schema: an object with open keys is closed too, and a property named additionalProperties is left alone", () => {
  const s = closedSchema({ type: "object", properties: { additionalProperties: { type: "string" } } }) as any;
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.additionalProperties.type, "string");
});
