import assert from "node:assert/strict";
import test from "node:test";

import { createFlueReviewApp } from "./runtime";

test("registers the PR reviewer on the Flue HTTP transport", async () => {
  const response = await createFlueReviewApp().request(
    "http://localhost/agents/pr-reviewer/missing-session",
  );

  assert.equal(response.status, 404);
  assert.match(await response.text(), /stream_not_found/);
});
