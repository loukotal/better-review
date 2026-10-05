import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { Sandbox as MicroVm, SandboxListBuilder, type SandboxHandle } from "microsandbox";

import {
  microsandboxName,
  microsandboxScratchRoot,
  microsandboxSubmissionScratch,
  removeMicrosandboxForWorktree,
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

test("worktree cleanup traverses all sandbox pages before removing matches", async (t) => {
  const events: string[] = [];
  const first = {
    killWithTimeout: async (timeout: number) => {
      assert.equal(timeout, 5_000);
      events.push("kill:first");
    },
    remove: async () => {
      events.push("remove:first");
    },
  } as unknown as SandboxHandle;
  const second = {
    killWithTimeout: async () => {
      events.push("kill:second");
      throw new Error("already stopped");
    },
    remove: async () => {
      events.push("remove:second");
    },
  } as unknown as SandboxHandle;
  const label = createHash("sha256").update(worktree.worktreePath).digest("hex").slice(0, 32);
  const listing = t.mock.method(
    MicroVm,
    "listWith",
    async (configure: Parameters<typeof MicroVm.listWith>[0]) => {
      const options = configure(new SandboxListBuilder()).toNapi();
      assert.deepEqual(options.labels, {
        "better-review.flue-v2": "1",
        "better-review.worktree": label,
      });
      assert.ok(!events.some((event) => event.startsWith("remove:")));
      if (options.cursor === undefined) {
        events.push("list:first");
        return { sandboxes: [first], nextCursor: "next-page" };
      }
      assert.equal(options.cursor, "next-page");
      events.push("list:second");
      return { sandboxes: [second] };
    },
  );

  await removeMicrosandboxForWorktree(worktree.worktreePath);

  assert.equal(listing.mock.callCount(), 2);
  assert.deepEqual(events.slice(0, 2), ["list:first", "list:second"]);
  assert.ok(events.includes("remove:first"));
  assert.ok(events.includes("remove:second"));
});
