import assert from "node:assert/strict";
import test from "node:test";

import {
  microsandboxName,
  microsandboxScratchRoot,
  microsandboxSubmissionScratch,
  type WorktreeIdentity,
} from "./microsandbox";

const worktree: WorktreeIdentity = {
  owner: "acme",
  repo: "app",
  number: 42,
  headSha: "abc123",
  worktreePath: "/reviews/acme/app/pr-42-abc123",
};

test("conversations for one stable worktree map to the same microVM", () => {
  assert.equal(microsandboxName(worktree), microsandboxName({ ...worktree }));
});

test("distinct prepared worktrees never map to the same microVM", () => {
  const nextHead = {
    ...worktree,
    headSha: "def456",
    worktreePath: "/reviews/acme/app/pr-42-def456",
  };
  assert.notEqual(microsandboxName(worktree), microsandboxName(nextHead));
});

test("conversation and submission scratch paths cannot overlap", () => {
  assert.notEqual(
    microsandboxScratchRoot("conversation-a"),
    microsandboxScratchRoot("conversation-b"),
  );
  assert.notEqual(
    microsandboxSubmissionScratch("conversation-a", "submission-1"),
    microsandboxSubmissionScratch("conversation-a", "submission-2"),
  );
});

test("restart keeps the worktree identity while recreating disposable submission state", () => {
  const stableNameBeforeRestart = microsandboxName(worktree);
  const stableNameAfterRestart = microsandboxName({ ...worktree });
  const oldScratch = microsandboxSubmissionScratch("conversation-a", "before-restart");
  const recreatedScratch = microsandboxSubmissionScratch("conversation-a", "after-restart");

  assert.equal(stableNameBeforeRestart, stableNameAfterRestart);
  assert.notEqual(oldScratch, recreatedScratch);
});
