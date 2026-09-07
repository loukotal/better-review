import assert from "node:assert/strict";
import test from "node:test";

import { reviewFreshness } from "./review-freshness";

test("matching reviewed and current heads stay green", () => {
  assert.equal(reviewFreshness("abc", "abc").className, "text-success");
  assert.match(reviewFreshness("abc", "abc").title, /current PR revision/);
});

test("a different reviewed head is yellow and explains the older review", () => {
  assert.equal(reviewFreshness("abc", "def").className, "text-warning");
  assert.match(reviewFreshness("abc", "def").title, /older PR revision/);
});

test("missing heads do not imply current or stale", () => {
  for (const heads of [
    [undefined, "abc"],
    ["abc", undefined],
    [undefined, undefined],
    ["", "abc"],
  ]) {
    const result = reviewFreshness(heads[0], heads[1]);
    assert.equal(result.className, "text-text-muted");
    assert.match(result.title, /freshness is unknown/);
  }
});
