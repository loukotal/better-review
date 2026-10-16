import assert from "node:assert/strict";
import { test } from "node:test";

import { submitPrReview } from "./pr-review-action";

test("a successful review returns while the PR list refresh is still pending", async () => {
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
  assert.equal(await submitting, result);
  assert.deepEqual(events, ["submitted", "refreshing"]);
  refreshed.resolve();
  await refreshed.promise;
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
  const refreshReported = Promise.withResolvers<void>();
  assert.equal(
    await submitPrReview(
      async () => result,
      async () => {
        throw error;
      },
      (failure) => {
        reported = failure;
        refreshReported.resolve();
      },
    ),
    result,
  );
  await refreshReported.promise;
  assert.equal(reported, error);
});

test("a synchronous refresh error is reported in the background", async () => {
  const error = new Error("Refresh setup failed");
  const reported = Promise.withResolvers<unknown>();
  assert.equal(
    await submitPrReview(
      async () => "saved",
      () => {
        throw error;
      },
      reported.resolve,
    ),
    "saved",
  );
  assert.equal(await reported.promise, error);
});
