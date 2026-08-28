import assert from "node:assert/strict";
import { test } from "node:test";

import { describePrLoadError } from "./errors";

test("describes GitHub connectivity failures without discarding their details", () => {
  const message = "failed to connect to api.github.com: GitHub is unavailable";

  assert.deepEqual(describePrLoadError(new Error(message)), {
    title: "GitHub is unavailable",
    message,
  });
});

test("describes other PR loading failures", () => {
  assert.deepEqual(describePrLoadError(new Error("Pull request not found")), {
    title: "Could not load pull request",
    message: "Pull request not found",
  });
});

test("provides a useful fallback for unknown failures", () => {
  assert.deepEqual(describePrLoadError(null), {
    title: "Could not load pull request",
    message: "An unexpected error occurred. Please try again.",
  });
});
