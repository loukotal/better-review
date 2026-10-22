import assert from "node:assert/strict";
import { test } from "node:test";

import { viewerApprovalForReview } from "./viewer-approval";

test("viewer approval shares fail-closed latest-review and renewed-request policy", () => {
  const input = {
    login: "viewer",
    headSha: "head",
    latest: { state: "APPROVED", commitSha: "head" },
    requests: { complete: true, items: [] },
  };
  assert.deepEqual(viewerApprovalForReview(input), { login: "viewer", commitSha: "head" });
  for (const state of ["COMMENTED", "DISMISSED", "CHANGES_REQUESTED", "PENDING"])
    assert.equal(viewerApprovalForReview({ ...input, latest: { state, commitSha: "head" } }), null);
  for (const requests of [
    undefined,
    { complete: false, items: [] },
    { complete: true, items: [{ kind: "user", name: "viewer" }] },
    { complete: true, items: [{ kind: "team", name: "team" }] },
    { complete: true, items: [{ kind: "unknown", name: "" }] },
  ])
    assert.equal(viewerApprovalForReview({ ...input, requests }), null);
  assert.equal(viewerApprovalForReview({ ...input, latest: undefined }), null);
  assert.equal(
    viewerApprovalForReview({ ...input, latest: { state: "APPROVED", commitSha: "old" } }),
    null,
  );
});
