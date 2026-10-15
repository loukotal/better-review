import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { STORE_BASE_DIR } from "../store";
import { reviewMetrics } from "./metrics";
import { cleanupOrphanedMicrosandboxes, createReviewMicrosandbox } from "./microsandbox";

test(
  "real microVM: cold/warm reuse, bounded IO, read-only checkout, cancellation and isolation",
  {
    skip: process.env.BETTER_REVIEW_SANDBOX_TEST !== "1",
    timeout: 120000,
  },
  async (t) => {
    const cache = path.join(STORE_BASE_DIR, "git-cache", "github");
    await mkdir(cache, { recursive: true });
    const root = await mkdtemp(path.join(cache, "sandbox-test-"));
    const owner = path.basename(root);
    t.after(async () => {
      await cleanupOrphanedMicrosandboxes(owner);
      await rm(root, { recursive: true, force: true });
    });
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "--initial-branch=main", "seed");
    await writeFile(
      path.join(root, "seed", "source.txt"),
      Array.from({ length: 10000 }, (_, index) => `line ${index + 1}`).join("\n"),
    );
    git("-C", "seed", "add", ".");
    git(
      "-C",
      "seed",
      "-c",
      "user.name=Sandbox Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    git("clone", "--bare", "seed", "cache.git");
    git("--git-dir=cache.git", "worktree", "add", "--detach", path.join(root, "checkout"), "HEAD");
    const headSha = git("--git-dir=cache.git", "rev-parse", "HEAD");
    const identity = {
      owner: "test",
      repo: "fixture",
      number: 1,
      headSha,
      worktreePath: path.join(root, "checkout"),
    };
    const first = await createReviewMicrosandbox(identity, "first", owner);
    await first.beginSubmission();
    try {
      assert.equal((await first.exec("exit 37")).exitCode, 37);
      assert.equal(
        await first.readLines("source.txt", 9876, 2),
        "9876: line 9876\n9877: line 9877\n",
      );
      assert.notEqual((await first.exec("echo overwritten > source.txt")).exitCode, 0);
      assert.equal((await first.exec("git rev-parse HEAD")).stdout.trim(), headSha);
      const huge = await first.exec("yes output | head -c 10000000");
      assert.ok(Buffer.byteLength(huge.stdout) < 25000);
      assert.match(huge.stdout, /omitted/);
      const controller = new AbortController();
      const cancellationStart = performance.now();
      const timeout = setTimeout(() => controller.abort(), 200);
      try {
        await first.exec("sleep 30", { signal: controller.signal });
      } catch {
        /* Cancellation may reject or return a killed exit status. */
      } finally {
        clearTimeout(timeout);
      }
      assert.ok(
        performance.now() - cancellationStart < 3000,
        "cancellation must terminate the child process promptly",
      );
      const second = await createReviewMicrosandbox(identity, "second", owner);
      await second.beginSubmission();
      try {
        const marker = await first.exec('echo secret > "$HOME/marker"; echo "$HOME/marker"');
        assert.notEqual((await second.exec(`cat '${marker.stdout.trim()}'`)).exitCode, 0);
      } finally {
        await second.endSubmission();
      }
    } finally {
      await first.endSubmission();
    }
    const warm = await createReviewMicrosandbox(identity, "first", owner);
    await warm.beginSubmission();
    try {
      assert.equal((await warm.exec('test ! -f "$HOME/marker"')).exitCode, 0);
    } finally {
      await warm.endSubmission();
    }
    const metrics = reviewMetrics();
    assert.equal(metrics["sandbox.create.ms"]?.count, 1);
    assert.equal(metrics["sandbox.warm.acquire.ms"]?.count, 2);
    console.info("[sandbox-benchmark]", JSON.stringify(metrics));
  },
);
