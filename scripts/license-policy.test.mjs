import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowed } from "./license-policy.mjs";

test("accepts the permissive allowlist (docs/08 §7)", () => {
  for (const l of ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC0-1.0", "0BSD", "PostgreSQL"]) {
    assert.equal(isAllowed(l), true, l);
  }
});

test("rejects copyleft and non-commercial licenses", () => {
  for (const l of [
    "AGPL-3.0",
    "AGPL-3.0-only",
    "GPL-3.0",
    "GPL-2.0",
    "LGPL-3.0",
    "SSPL-1.0",
    "CC-BY-4.0",
    "CC-BY-NC-4.0",
    "CC-BY-SA-4.0",
    "BUSL-1.1",
  ]) {
    assert.equal(isAllowed(l), false, l);
  }
});

test("resolves SPDX expressions", () => {
  assert.equal(isAllowed("(MIT OR Apache-2.0)"), true);
  assert.equal(isAllowed("MIT OR AGPL-3.0"), true, "a permissive alternative is enough");
  assert.equal(isAllowed("MIT AND ISC"), true);
  assert.equal(isAllowed("MIT AND AGPL-3.0"), false, "every term of a conjunction must pass");
  assert.equal(isAllowed("(AGPL-3.0 OR SSPL-1.0)"), false);
});

test("rejects missing or unknown licenses", () => {
  for (const l of [null, undefined, "", "   ", "UNKNOWN", "SEE LICENSE IN LICENSE.md"]) {
    assert.equal(isAllowed(l), false, String(l));
  }
});
