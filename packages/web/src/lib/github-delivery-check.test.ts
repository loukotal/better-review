import assert from "node:assert/strict";
import { test } from "node:test";

import type { GithubOutboxOperation } from "@better-review/shared";

import { githubDeliveryCheckOutcome } from "./github-delivery-check";

const operation: GithubOutboxOperation = {
  command: {
    operationId: "10000000-0000-4000-8000-000000000001",
    scope: {
      host: "github.com",
      owner: "fixture",
      repo: "repo",
      number: 1,
      url: "https://github.com/fixture/repo/pull/1",
    },
    expectedActor: { id: 42, login: "fixture" },
    dependencies: [],
    action: { kind: "approve", expectedHeadSha: "a".repeat(40), body: "" },
  },
  revision: 3,
  sequence: 1,
  status: "uncertain",
  attempts: 1,
  retryMode: "manual",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:10Z",
  nextAttemptAt: "2026-01-01T00:00:15Z",
  error: {
    code: "conflict",
    message: "GitHub has not provided unambiguous evidence. Explicit confirmation is required.",
    retryable: false,
  },
};
test("old snapshots and scheduling acknowledgements never count as completed delivery checks", () => {
  assert.equal(githubDeliveryCheckOutcome(3, operation), "pending");
  assert.equal(
    githubDeliveryCheckOutcome(2, { ...operation, nextAttemptAt: operation.updatedAt }),
    "pending",
  );
  assert.equal(
    githubDeliveryCheckOutcome(2, { ...operation, revision: 2, nextAttemptAt: undefined }),
    "pending",
  );
});
test("a worker revision and settled ambiguity count as a completed, unconfirmed read", () => {
  assert.equal(githubDeliveryCheckOutcome(2, operation), "unconfirmed");
  assert.equal(githubDeliveryCheckOutcome(2, { ...operation, status: "synced" }), "confirmed");
});
test("network/account failures and manual state changes never produce a successful delivery-check timestamp", () => {
  for (const code of ["network", "auth", "permission", "identity-unknown"] as const)
    assert.equal(
      githubDeliveryCheckOutcome(2, {
        ...operation,
        error: { code, message: "Could not read GitHub", retryable: true },
      }),
      "failed",
    );
  assert.equal(githubDeliveryCheckOutcome(2, { ...operation, status: "retry-failed" }), "failed");
});
