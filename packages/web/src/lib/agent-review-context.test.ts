import assert from "node:assert/strict";
import { test } from "node:test";

import { getVariantCommits } from "./agent-review-context";

test("review context lists scoped commits and supports older single-commit sessions", () => {
  const commit = { sha: "abc123", message: "First change\n\nFull message" };
  const commits = [{ sha: "def456", message: "Second change" }, commit];
  const variant = { id: "branch", label: "Branch", rawPatch: "patch" };
  assert.deepEqual(getVariantCommits({ ...variant, commits }), commits);
  assert.deepEqual(getVariantCommits({ ...variant, commit }), [commit]);
  assert.deepEqual(getVariantCommits({ ...variant, commits: [], commit }), []);
  assert.deepEqual(getVariantCommits(variant), []);
  assert.deepEqual(getVariantCommits(null), []);
});
