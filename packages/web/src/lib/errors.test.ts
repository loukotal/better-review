import assert from "node:assert/strict";
import { test } from "node:test";

import { describePrLoadError } from "./errors";

test("turns a GitHub 503 stack into a concise actionable error", () => {
  const error = new Error(
    "GhError: HTTP 503: No server is currently available to service your request. Sorry about that. Please try resubmitting your request and contact us if the problem persists. (https://api.github.com/graphql) at <anonymous> (/Users/example/better-review/src/gh/gh.ts:841:34) at FiberRuntime.Sync (/Users/example/node_modules/effect/src/internal/fiberRuntime.ts:1161:19)",
  );

  assert.deepEqual(describePrLoadError(error), {
    title: "GitHub is temporarily unavailable",
    message: "GitHub returned HTTP 503. Try opening this pull request again in a few minutes.",
  });
});

test("never exposes an internal stack for an unexpected load error", () => {
  const result = describePrLoadError(
    new Error(
      "GhError: unexpected response from GitHub at <anonymous> (/Users/example/better-review/src/gh/gh.ts:841:34)",
    ),
  );

  assert.equal(result.title, "Couldn’t open this pull request");
  assert.equal(result.message, "Unexpected response from GitHub. Check the URL and try again.");
  assert.doesNotMatch(
    `${result.title} ${result.message}`,
    /Users|node_modules|gh\.ts|FiberRuntime/,
  );
});
