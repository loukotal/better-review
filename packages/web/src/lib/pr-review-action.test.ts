import assert from "node:assert/strict";
import { test } from "node:test";

import { submitPrReview } from "./pr-review-action";

test("a successful review refreshes the PR list before returning", async () => {
  const events: string[] = [];
  const refreshed = Promise.withResolvers<void>();
  const result = { success: true };
  const submitting = submitPrReview(
    async () => {
      events.push("submitted");
      return result;
    },
    async () => {
      events.push("refreshing");
      await refreshed.promise;
      events.push("refreshed");
    },
  );
  await Promise.resolve();
  assert.deepEqual(events, ["submitted", "refreshing"]);
  refreshed.resolve();
  assert.equal(await submitting, result);
  assert.deepEqual(events, ["submitted", "refreshing", "refreshed"]);
});

test("a rejected review never refreshes or publishes success", async () => {
  const error = new Error("GitHub rejected the review");
  await assert.rejects(
    submitPrReview(
      async () => {
        throw error;
      },
      async () => assert.fail("Failed reviews must not refresh the list"),
    ),
    (actual) => actual === error,
  );
});

test("list refresh failures do not turn a completed review into a submission failure", async () => {
  const result = { success: true };
  const error = new Error("GitHub list unavailable");
  let reported: unknown;
  assert.equal(
    await submitPrReview(
      async () => result,
      async () => {
        throw error;
      },
      (failure) => {
        reported = failure;
      },
    ),
    result,
  );
  assert.equal(reported, error);
});
