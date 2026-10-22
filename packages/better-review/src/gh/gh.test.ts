import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import { isDiffCommentTargetInPatch, parseFullDiff } from "../diff";
import {
  buildUnifiedDiffFromPullFiles,
  decodeGithubReviewComments,
  decodeGithubReviewStatus,
  decodeGithubPrSearchResponse,
  GhError,
  isPullRequestDiffTooLarge,
} from "./gh";

test("review status uses GitHub's aggregate decision and verifies its head", () => {
  const payload = (reviewDecision: unknown, headRefOid = "current") => ({
    data: {
      repository: {
        pullRequest: {
          headRefOid,
          reviewDecision,
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          name: "test",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                        },
                        {
                          __typename: "CheckRun",
                          name: "build",
                          status: "IN_PROGRESS",
                          conclusion: null,
                        },
                        { __typename: "StatusContext" },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });
  assert.deepEqual(decodeGithubReviewStatus(payload("APPROVED"), "current"), {
    reviewDecision: "APPROVED",
    viewerApproval: null,
    checks: [
      { name: "test", status: "completed", conclusion: "success" },
      { name: "build", status: "in_progress", conclusion: null },
    ],
  });
  for (const decision of ["CHANGES_REQUESTED", "REVIEW_REQUIRED", null, undefined]) {
    assert.equal(
      decodeGithubReviewStatus(payload(decision), "current").reviewDecision,
      decision ?? null,
    );
  }
  assert.deepEqual(decodeGithubReviewStatus(payload("APPROVED", "new-head"), "current"), {
    reviewDecision: null,
    viewerApproval: null,
    checks: [],
  });
  assert.throws(() => decodeGithubReviewStatus(payload("DISMISSED"), "current"));
});

test("search decoder retains aggregate decision independently of historical approvals", () => {
  const pr = {
    number: 1,
    headRefOid: "head",
    title: "PR",
    url: "https://github.com/o/r/pull/1",
    isDraft: false,
    createdAt: "2026-01-01",
    additions: 1,
    deletions: 0,
    repository: { name: "r", nameWithOwner: "o/r" },
    author: { login: "author" },
    reviews: { nodes: [{ author: { login: "reviewer" }, state: "APPROVED" }] },
  };
  for (const reviewDecision of [
    "APPROVED",
    "CHANGES_REQUESTED",
    "REVIEW_REQUIRED",
    null,
    undefined,
  ]) {
    const decoded = decodeGithubPrSearchResponse({
      data: {
        requested: { nodes: [{ ...pr, reviewDecision }] },
        reviewed: { nodes: [] },
        authored: { nodes: [] },
      },
    });
    assert.equal(decoded.data.requested.nodes[0]?.reviewDecision, reviewDecision);
  }
});

test("negative approval status carries verified numeric actor and head, not guessed request context", () => {
  const payload = {
    data: {
      viewer: { login: "viewer", databaseId: 42 },
      repository: {
        pullRequest: {
          headRefOid: "head",
          reviewDecision: "APPROVED",
          latestReviews: { nodes: [] },
          reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } },
          commits: { nodes: [] },
        },
      },
    },
  };
  const decoded = decodeGithubReviewStatus(payload, "head");
  assert.equal(decoded.viewerApproval, null);
  assert.deepEqual(decoded.reviewContext, { actor: { id: 42, login: "viewer" }, headSha: "head" });
  assert.equal(decodeGithubReviewStatus(payload, "another-head").reviewContext, undefined);
});

test("own approval requires the current viewer's latest approved review on the current head", () => {
  const decode = (state: string, oid = "head", login = "viewer") =>
    decodeGithubReviewStatus(
      {
        data: {
          viewer: { login: "viewer" },
          repository: {
            pullRequest: {
              headRefOid: "head",
              reviewDecision: "REVIEW_REQUIRED",
              latestReviews: { nodes: [{ author: { login }, state, commit: { oid } }] },
              reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } },
              commits: { nodes: [] },
            },
          },
        },
      },
      "head",
    );
  assert.deepEqual(decode("APPROVED").viewerApproval, { login: "viewer", commitSha: "head" });
  assert.equal(decode("APPROVED").reviewDecision, "REVIEW_REQUIRED");
  for (const state of ["DISMISSED", "CHANGES_REQUESTED", "COMMENTED", "PENDING"]) {
    assert.equal(decode(state).viewerApproval, null);
  }
  assert.equal(decode("APPROVED", "old-head").viewerApproval, null);
  assert.equal(decode("APPROVED", "head", "other-user").viewerApproval, null);
});

test("a same-head re-request enables another review without changing the aggregate decision", () => {
  const decode = (reviewRequests: unknown) =>
    decodeGithubReviewStatus(
      {
        data: {
          viewer: { login: "viewer" },
          repository: {
            pullRequest: {
              headRefOid: "head",
              reviewDecision: "APPROVED",
              commits: { nodes: [] },
              latestReviews: {
                nodes: [
                  { author: { login: "viewer" }, state: "APPROVED", commit: { oid: "head" } },
                ],
              },
              reviewRequests,
            },
          },
        },
      },
      "head",
    );
  const requests = (nodes: unknown[], hasNextPage = false) => ({
    nodes,
    pageInfo: { hasNextPage },
  });
  assert.equal(
    decode(requests([{ requestedReviewer: { __typename: "User", login: "viewer" } }]))
      .viewerApproval,
    null,
  );
  assert.equal(
    decode(requests([{ requestedReviewer: { __typename: "User", login: "viewer" } }]))
      .reviewDecision,
    "APPROVED",
  );
  assert.deepEqual(decode(requests([])).viewerApproval, { login: "viewer", commitSha: "head" });
  assert.deepEqual(
    decode(requests([{ requestedReviewer: { __typename: "User", login: "other" } }]))
      .viewerApproval,
    { login: "viewer", commitSha: "head" },
  );
  for (const unknown of [
    null,
    undefined,
    {},
    { nodes: null, pageInfo: { hasNextPage: false } },
    { nodes: [], pageInfo: null },
    requests([{ requestedReviewer: { __typename: "Team" } }]),
    requests([null]),
    requests([{ requestedReviewer: null }]),
    requests([], true),
  ]) {
    assert.equal(decode(unknown).viewerApproval, null);
    assert.equal(decode(unknown).reviewDecision, "APPROVED");
  }
});

test("review-comment decoder preserves actual REST modification evidence and accepts legacy records", () => {
  const comment = {
    id: 1,
    node_id: "comment-node",
    path: "src/a.ts",
    line: 2,
    original_line: 2,
    side: "RIGHT",
    body: "external edit",
    html_url: "https://github.com/o/r/pull/1#discussion_r1",
    user: { login: "reviewer", avatar_url: "" },
    created_at: "2026-01-01T00:00:00Z",
  };
  const updated_at = "2026-01-03T12:34:56Z";
  assert.equal(decodeGithubReviewComments([{ ...comment, updated_at }])[0]?.updated_at, updated_at);
  const legacy = decodeGithubReviewComments([comment])[0];
  assert.equal(legacy?.updated_at, undefined);
  assert.equal(legacy?.created_at, comment.created_at);
  assert.throws(() => decodeGithubReviewComments([{ ...comment, updated_at: 123 }]));
  const commit_id = "a".repeat(40);
  const original_commit_id = "b".repeat(40);
  const retained = decodeGithubReviewComments([{ ...comment, commit_id, original_commit_id }])[0];
  assert.equal(retained?.commit_id, commit_id);
  assert.equal(retained?.original_commit_id, original_commit_id);
  assert.equal(legacy?.commit_id, undefined);
  assert.equal(legacy?.original_commit_id, undefined);
  assert.throws(() => decodeGithubReviewComments([{ ...comment, commit_id: 123 }]));
  assert.throws(() => decodeGithubReviewComments([{ ...comment, original_commit_id: 123 }]));
});

test("preserves the underlying gh failure in raw Effect errors", async () => {
  const message = "failed to connect to api.github.com: GitHub is unavailable";
  const error = new GhError({ command: "listCommits", cause: new Error(message) });

  assert.equal(error.message, message);

  await assert.rejects(Effect.runPromise(Effect.fail(error)), (failure) => {
    assert.match(String(failure), new RegExp(`GhError: ${message}`));
    assert.doesNotMatch(String(failure), /GhError: An error has occurred/);
    return true;
  });
});

test("builds a unified diff from pull request file API patches", () => {
  const diff = buildUnifiedDiffFromPullFiles([
    {
      filename: "src/example.ts",
      status: "modified",
      patch: "@@ -1 +1,2 @@\n-const before = true;\n+const before = true;\n+const after = true;",
    },
    {
      filename: "src/new-file.ts",
      status: "added",
      patch: "@@ -0,0 +1 @@\n+export const value = 1;",
    },
    {
      filename: "src/new-name.ts",
      previous_filename: "src/old-name.ts",
      status: "renamed",
      patch: "@@ -1 +1 @@\n-export const oldName = true;\n+export const newName = true;",
    },
  ]);

  assert.equal(
    diff,
    `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1,2 @@
-const before = true;
+const before = true;
+const after = true;
diff --git a/src/new-file.ts b/src/new-file.ts
--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1 @@
+export const value = 1;
diff --git a/src/old-name.ts b/src/new-name.ts
rename from src/old-name.ts
rename to src/new-name.ts
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1 +1 @@
-export const oldName = true;
+export const newName = true;`,
  );

  const fileDiffs = parseFullDiff(diff);
  assert.equal(fileDiffs.size, 3);
  assert.equal(fileDiffs.get("src/example.ts")?.totalAdded, 2);
  assert.equal(fileDiffs.get("src/example.ts")?.totalRemoved, 1);
  assert.equal(fileDiffs.get("src/new-file.ts")?.totalAdded, 1);
  assert.ok(fileDiffs.get("src/new-name.ts"));
});

test("builds headers for pull request files without patch text", () => {
  const diff = buildUnifiedDiffFromPullFiles([
    {
      filename: "assets/logo.png",
      status: "modified",
      patch: null,
    },
    {
      filename: "src/deleted.ts",
      status: "removed",
    },
  ]);

  assert.equal(
    diff,
    `diff --git a/assets/logo.png b/assets/logo.png
--- a/assets/logo.png
+++ b/assets/logo.png
diff --git a/src/deleted.ts b/src/deleted.ts
--- a/src/deleted.ts
+++ /dev/null`,
  );

  const fileDiffs = parseFullDiff(diff);
  assert.equal(fileDiffs.size, 2);
  assert.equal(fileDiffs.get("assets/logo.png")?.hunks.length, 0);
  assert.equal(fileDiffs.get("src/deleted.ts")?.hunks.length, 0);
});

test("detects review comment targets outside the parsed patch hunks", () => {
  const fileDiffs = parseFullDiff(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,3 +10,4 @@
 const before = true;
-const oldValue = 1;
+const newValue = 1;
+const after = true;
 const done = true;`);
  const fileDiff = fileDiffs.get("src/example.ts");

  assert.ok(fileDiff);
  assert.equal(
    isDiffCommentTargetInPatch(fileDiff, { line: 13, side: "RIGHT", startLine: 10 }),
    true,
  );
  assert.equal(isDiffCommentTargetInPatch(fileDiff, { line: 50, side: "RIGHT" }), false);
  assert.equal(isDiffCommentTargetInPatch(fileDiff, { line: 13, side: "LEFT" }), false);
});

test("detects too-large PR diff errors through nested causes", () => {
  const nested = new Error("An unknown error occurred in Effect.tryPromise", {
    cause: new Error(
      "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300).\nPullRequest.diff too_large",
    ),
  });

  assert.equal(isPullRequestDiffTooLarge(nested), true);
  assert.equal(isPullRequestDiffTooLarge(new Error("HTTP 500")), false);
});
