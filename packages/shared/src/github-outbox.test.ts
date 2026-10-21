import assert from "node:assert/strict";
import test from "node:test";

import {
  isGithubOutboxCommand,
  isGithubOutboxControl,
  isGithubRemoteResult,
  isGithubQueueTimeoutMs,
  isGithubOutboxBatchControl,
  isGithubOutboxAdmissionInput,
} from "./github-outbox";

const id = "11111111-1111-4111-8111-111111111111";
const parent = "22222222-2222-4222-8222-222222222222";
const scope = {
  host: "github.com",
  owner: "acme",
  repo: "app",
  number: 1,
  url: "https://github.com/acme/app/pull/1",
};
const command = {
  operationId: id,
  scope,
  expectedActor: { id: 42, login: "reviewer" },
  action: { kind: "issue-comment", body: "Keep this comment" },
  dependencies: [],
};

test("queue time policy and batch/cycle inputs reject unbounded or malformed scheduling", () => {
  for (const value of [60_000, 300_000, 900_000, 3_600_000])
    assert.ok(isGithubQueueTimeoutMs(value));
  for (const value of [0, NaN, Infinity, 59_999, 3_600_001, 60_000.5, "300000"])
    assert.equal(isGithubQueueTimeoutMs(value), false);
  assert.ok(isGithubOutboxCommand({ ...command, queueDeadlineAt: "2026-10-21T12:00:00Z" }));
  assert.equal(isGithubOutboxCommand({ ...command, queueDeadlineAt: "never" }), false);
  assert.equal(isGithubOutboxCommand({ ...command, queueTimeoutMs: Infinity }), false);
  const batch = { kind: "clear", requestId: id, operations: [], commands: [command] };
  assert.ok(isGithubOutboxBatchControl(batch));
  assert.equal(isGithubOutboxBatchControl({ ...batch, commands: [command, command] }), false);
  assert.equal(isGithubOutboxBatchControl({ ...batch, queueTimeoutMs: Infinity }), false);
  const cycle = {
    requestId: parent,
    queueTimeoutMs: 300_000,
    queueDeadlineAt: "2026-10-21T12:00:00Z",
  };
  assert.ok(isGithubOutboxAdmissionInput({ command, cycle }));
  assert.equal(
    isGithubOutboxAdmissionInput({ command, cycle: { ...cycle, queueTimeoutMs: -1 } }),
    false,
  );
});

test("outbox admission requires canonical scope and an explicit stable actor", () => {
  assert.ok(isGithubOutboxCommand(command));
  assert.equal(isGithubOutboxCommand({ ...command, expectedActor: { login: "reviewer" } }), false);
  assert.equal(isGithubOutboxCommand({ ...command, scope: { ...scope, owner: "Acme" } }), false);
  assert.equal(
    isGithubOutboxCommand({
      ...command,
      scope: { ...scope, url: "https://github.com/other/app/pull/1" },
    }),
    false,
  );
  assert.equal(
    isGithubOutboxCommand({ ...command, scope: { ...scope, host: "example.com" } }),
    false,
  );
});

test("review actions require nonblank bodies and pinned SHA; persisted approvals stay valid", () => {
  for (const kind of ["request-changes", "review-comment"]) {
    const action = { kind, expectedHeadSha: "a".repeat(40), body: "Review" };
    assert.ok(isGithubOutboxCommand({ ...command, action }));
    for (const body of ["", " \n\t", null])
      assert.equal(isGithubOutboxCommand({ ...command, action: { ...action, body } }), false);
    assert.equal(
      isGithubOutboxCommand({ ...command, action: { ...action, expectedHeadSha: "main" } }),
      false,
    );
  }
  assert.ok(
    isGithubRemoteResult({ kind: "approval", id: 1, url: scope.url, commitSha: "a".repeat(40) }),
  );
  const review = {
    kind: "review",
    id: 1,
    url: scope.url,
    commitSha: "a".repeat(40),
    state: "CHANGES_REQUESTED",
    body: "Review",
    author: command.expectedActor,
    submittedAt: "2026-01-01T00:00:00Z",
  };
  assert.ok(isGithubRemoteResult(review));
  for (const patch of [
    { state: "APPROVED" },
    { submittedAt: undefined },
    { author: undefined },
    { body: undefined },
  ])
    assert.equal(isGithubRemoteResult({ ...review, ...patch }), false);
});

test("local reply targets require explicit non-self dependencies", () => {
  const reply = {
    ...command,
    action: {
      kind: "reply",
      target: { source: "local", kind: "review-comment", operationId: parent },
      body: "Reply",
    },
  };
  assert.equal(isGithubOutboxCommand(reply), false);
  assert.ok(isGithubOutboxCommand({ ...reply, dependencies: [parent] }));
  assert.equal(isGithubOutboxCommand({ ...reply, dependencies: [parent, parent] }), false);
  assert.equal(isGithubOutboxCommand({ ...reply, dependencies: [id, parent] }), false);
});

test("approval and inline admission pin immutable heads and valid line sides", () => {
  assert.equal(
    isGithubOutboxCommand({
      ...command,
      action: { kind: "approve", body: "", expectedHeadSha: "main" },
    }),
    false,
  );
  assert.ok(
    isGithubOutboxCommand({
      ...command,
      action: { kind: "approve", body: "", expectedHeadSha: "a".repeat(40) },
    }),
  );
  const inline = {
    kind: "inline-comment",
    body: "Finding",
    expectedHeadSha: "a".repeat(40),
    anchor: { path: "src/a.ts", side: "RIGHT", line: 3, startSide: "RIGHT", startLine: 2 },
  };
  assert.ok(isGithubOutboxCommand({ ...command, action: inline }));
  assert.equal(
    isGithubOutboxCommand({
      ...command,
      action: { ...inline, anchor: { ...inline.anchor, startSide: "LEFT" } },
    }),
    false,
  );
  assert.equal(
    isGithubOutboxCommand({
      ...command,
      action: { ...inline, anchor: { ...inline.anchor, path: "../a.ts" } },
    }),
    false,
  );
});

test("confirmed review results need renderable provenance, and controls need revisions", () => {
  const result = {
    kind: "review-comment",
    id: 5,
    url: "https://github.com/acme/app/pull/1#discussion_r5",
    body: "Finding",
    author: command.expectedActor,
    createdAt: "2026-10-16T12:00:00Z",
    updatedAt: "2026-10-16T12:00:00Z",
  };
  assert.equal(isGithubRemoteResult(result), false);
  assert.ok(
    isGithubRemoteResult({
      ...result,
      location: {
        path: "src/a.ts",
        side: "RIGHT",
        line: null,
        originalLine: 3,
        commitSha: "a".repeat(40),
      },
    }),
  );
  assert.equal(isGithubOutboxControl({ requestId: parent, operationId: id, kind: "retry" }), false);
  assert.ok(
    isGithubOutboxControl({
      requestId: parent,
      operationId: id,
      kind: "reconcile",
      expectedRevision: 1,
    }),
  );
});
