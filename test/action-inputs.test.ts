import assert from "node:assert/strict";
import test from "node:test";

import { isInputEnabled } from "../src/action-inputs.js";

test("isInputEnabled defaults empty values to false and accepts common opt-in strings", () => {
  assert.equal(isInputEnabled(""), false);
  assert.equal(isInputEnabled("false"), false);
  assert.equal(isInputEnabled("no"), false);
  assert.equal(isInputEnabled("true"), true);
  assert.equal(isInputEnabled("YES"), true);
  assert.equal(isInputEnabled("maybe"), false);
  assert.equal(isInputEnabled("", true), true);
});
