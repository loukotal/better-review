import type { PrDetail } from "@better-review/shared";

export function prDetailFixture(url: string, headSha = "a".repeat(40)): PrDetail {
  return {
    url,
    fetchedAt: "2026-01-01T00:00:00Z",
    actor: {
      status: "available",
      complete: true,
      data: { id: "U_fixture_graphql", login: "browser-fixture", databaseId: 42 },
    },
    metadata: {
      status: "available",
      complete: true,
      data: {
        id: "PR_fixture",
        number: 1,
        url,
        title: "Fixture pull request",
        body: "A **real Overview** description.",
        author: "author",
        state: "OPEN",
        draft: false,
        head: { name: "feature", sha: headSha },
        base: { name: "main", sha: "b".repeat(40) },
        mergedAt: null,
        mergedBy: null,
        mergeCommitSha: null,
      },
    },
    labels: {
      status: "available",
      complete: true,
      data: [{ name: "feature", color: "00ff00", description: null }],
    },
    reviews: { status: "available", complete: true, data: [] },
    reviewRequests: {
      status: "available",
      complete: true,
      data: [{ kind: "user", name: "reviewer" }],
    },
    checks: { status: "available", complete: true, data: [] },
    mergeCapabilities: {
      status: "available",
      complete: true,
      data: {
        allowedMethods: ["merge", "squash"],
        viewerPermission: "WRITE",
        viewerCanMergeAsAdmin: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "REVIEW_REQUIRED",
        queueRequired: false,
        queueEntry: null,
        autoMergeEnabled: false,
        branchRequirements: { status: "available", complete: true, data: null },
        actions: [
          { action: { kind: "merge", method: "merge" }, enabled: true, reason: null },
          { action: { kind: "merge", method: "squash" }, enabled: true, reason: null },
        ],
      },
    },
  };
}
