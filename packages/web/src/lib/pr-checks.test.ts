import assert from "node:assert/strict";
import test from "node:test";

import { checkPresentation, checkUrl, summarizePrChecks } from "./pr-checks";

test("detail and legacy header enums normalize at the boundary without counting skipped as success", () => {
  const upper = [
    { status: "COMPLETED", conclusion: "SUCCESS" },
    { status: "COMPLETED", conclusion: "FAILURE" },
    { status: "IN_PROGRESS", conclusion: null },
    { status: "COMPLETED", conclusion: "SKIPPED" },
    { status: "COMPLETED", conclusion: "NEUTRAL" },
    { status: "COMPLETED", conclusion: "CANCELLED" },
    { status: "COMPLETED", conclusion: null },
  ];
  const expected = { total: 7, passed: 1, failed: 1, pending: 1, other: 3, unknown: 1 };
  assert.deepEqual(summarizePrChecks(upper), expected);
  assert.deepEqual(
    summarizePrChecks(
      upper.map((check) => ({
        status: check.status.toLowerCase(),
        conclusion: check.conclusion?.toLowerCase() ?? null,
      })),
    ),
    expected,
  );
});
test("status contexts, unknown checks, and empty evidence never imply all green", () => {
  assert.equal(checkPresentation({ status: "PENDING", conclusion: null }).group, "pending");
  assert.equal(
    checkPresentation({ status: "IN_PROGRESS", conclusion: "SUCCESS" }).group,
    "pending",
  );
  assert.equal(checkPresentation({ status: "SUCCESS", conclusion: null }).group, "passed");
  assert.equal(
    checkPresentation({ status: "NEW_UNKNOWN_STATE", conclusion: null }).group,
    "unknown",
  );
  assert.equal(summarizePrChecks([]).passed, 0);
  assert.equal(
    checkPresentation({ status: "COMPLETED", conclusion: "ACTION_REQUIRED" }).group,
    "failed",
  );
});
test("check links permit only HTTP(S)", () => {
  assert.equal(checkUrl("https://github.com/check/1"), "https://github.com/check/1");
  assert.equal(checkUrl("javascript:alert(1)"), undefined);
  assert.equal(checkUrl(null), undefined);
});
