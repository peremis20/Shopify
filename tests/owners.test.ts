import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanEmail, isAdminEmail } from "../src/lib/analytics/accounts";

test("owners: emails are cleaned, and junk is refused", () => {
  assert.equal(cleanEmail("  Info@Peremis.com "), "info@peremis.com");
  assert.equal(cleanEmail("not an email"), null);
  assert.equal(cleanEmail("a@b,c@d.com"), null);
  assert.equal(cleanEmail(""), null);
  assert.equal(cleanEmail(undefined), null);
});

test("owners: the server list still decides on its own", () => {
  const before = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = "root@example.com, Other@Example.com";
  assert.equal(isAdminEmail("ROOT@example.com"), true);
  assert.equal(isAdminEmail("other@example.com"), true);
  assert.equal(isAdminEmail("someone@example.com"), false);
  if (before === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = before;
});
