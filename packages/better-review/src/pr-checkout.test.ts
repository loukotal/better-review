import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  cleanupExpiredWorktrees,
  ensureOfflineReviewDiff,
  ensureReviewHistory,
  fetchPullHeadBranch,
  githubRepoRemoteUrl,
  reviewBaseRef,
  type RepoGitQueueInfo,
  verifyWorktreeAccess,
  withRepoGitQueue,
  type PreparePrCheckoutInput,
} from "./pr-checkout";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function commitFile(repo: string, file: string, content: string, message: string) {
  const filePath = join(repo, file);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  await git(repo, ["add", file]);
  await git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function createManagedWorktree(root: string) {
  const source = join(root, "source");
  const gitCacheRoot = join(root, "git-cache", "github");
  const worktreesRoot = join(root, "worktrees", "github");
  const repoGitDir = join(gitCacheRoot, "owner", "repo.git");
  const worktreePath = join(worktreesRoot, "owner", "repo", "pr-1-head");

  await git(root, ["init", source]);
  await git(source, ["config", "user.email", "review@example.com"]);
  await git(source, ["config", "user.name", "Review Test"]);
  const headSha = await commitFile(source, "src/app.ts", "base\n", "base");

  await mkdir(dirname(repoGitDir), { recursive: true });
  await git(root, ["clone", "--bare", source, repoGitDir]);
  await mkdir(dirname(worktreePath), { recursive: true });
  await git(repoGitDir, ["worktree", "add", worktreePath, "HEAD"]);

  return { gitCacheRoot, worktreesRoot, repoGitDir, worktreePath, headSha };
}

async function writeCheckoutReadyManifest(
  worktreePath: string,
  headSha: string,
  lastUsedAt: number,
) {
  const contextDir = join(worktreePath, ".better-review");
  await mkdir(contextDir, { recursive: true });
  await writeFile(
    join(contextDir, "CHECKOUT_READY.json"),
    JSON.stringify(
      {
        version: 1,
        owner: "owner",
        repo: "repo",
        number: 1,
        prUrl: "https://github.com/owner/repo/pull/1",
        baseSha: headSha,
        headSha,
        baseRef: "main",
        headRef: "feature",
        reviewMode: "full",
        commitSha: null,
        files: ["src/app.ts"],
        repoAccess: {
          checkedAt: lastUsedAt,
          trackedFileCount: 1,
          sampledFiles: ["src/app.ts"],
          sparseCheckout: false,
        },
        preparedAt: lastUsedAt,
        lastUsedAt,
      },
      null,
      2,
    ),
  );
}

test("githubRepoRemoteUrl respects gh git protocol", () => {
  assert.equal(githubRepoRemoteUrl("owner", "repo", "ssh\n"), "git@github.com:owner/repo.git");
  assert.equal(
    githubRepoRemoteUrl("owner", "repo", "https\n"),
    "https://github.com/owner/repo.git",
  );
});

test("withRepoGitQueue serializes operations for the same cached repository", async () => {
  const events: string[] = [];
  const queueInfos: RepoGitQueueInfo[] = [];
  let activeOperations = 0;

  async function queuedOperation(label: string, waitMs: number) {
    await withRepoGitQueue("cache/repo.git", async (queue) => {
      queueInfos.push(queue);
      activeOperations += 1;
      assert.equal(activeOperations, 1);
      events.push(`${label}:start`);
      await delay(waitMs);
      events.push(`${label}:end`);
      activeOperations -= 1;
    });
  }

  await Promise.all([queuedOperation("first", 20), queuedOperation("second", 0)]);

  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  assert.equal(queueInfos[0]?.queued, false);
  assert.equal(queueInfos[1]?.queued, true);
});

test("cleanupExpiredWorktrees removes expired prepared worktrees with git worktree remove", async () => {
  const root = await mkdtemp(join(tmpdir(), "better-review-worktree-cleanup-"));

  try {
    const { gitCacheRoot, worktreesRoot, repoGitDir, worktreePath, headSha } =
      await createManagedWorktree(root);
    await writeCheckoutReadyManifest(worktreePath, headSha, 1_000);

    const result = await cleanupExpiredWorktrees({
      worktreesRoot,
      gitCacheRoot,
      maxUnusedMs: 1_000,
      now: 3_000,
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.removed, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(await pathExists(worktreePath), false);

    const worktreeList = await git(repoGitDir, ["worktree", "list", "--porcelain"]);
    assert.equal(worktreeList.includes(worktreePath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanupExpiredWorktrees removes a recent worktree when its PR is merged", async () => {
  const root = await mkdtemp(join(tmpdir(), "better-review-worktree-cleanup-merged-"));

  try {
    const { gitCacheRoot, worktreesRoot, worktreePath, headSha } =
      await createManagedWorktree(root);
    await writeCheckoutReadyManifest(worktreePath, headSha, 2_500);

    const result = await cleanupExpiredWorktrees({
      worktreesRoot,
      gitCacheRoot,
      maxUnusedMs: 1_000,
      now: 3_000,
      getPrState: async () => "MERGED",
    });

    assert.equal(result.removed, 1);
    assert.equal(await pathExists(worktreePath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanupExpiredWorktrees retains a recent worktree while its PR is open", async () => {
  const root = await mkdtemp(join(tmpdir(), "better-review-worktree-cleanup-open-"));

  try {
    const { gitCacheRoot, worktreesRoot, worktreePath, headSha } =
      await createManagedWorktree(root);
    await writeCheckoutReadyManifest(worktreePath, headSha, 2_500);

    const result = await cleanupExpiredWorktrees({
      worktreesRoot,
      gitCacheRoot,
      maxUnusedMs: 1_000,
      now: 3_000,
      getPrState: async () => "OPEN",
    });

    assert.equal(result.removed, 0);
    assert.equal(result.skipped, 1);
    assert.equal(await pathExists(worktreePath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanupExpiredWorktrees skips worktrees with tracked local changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "better-review-worktree-cleanup-dirty-"));

  try {
    const { gitCacheRoot, worktreesRoot, worktreePath, headSha } =
      await createManagedWorktree(root);
    await writeCheckoutReadyManifest(worktreePath, headSha, 1_000);
    await writeFile(join(worktreePath, "src/app.ts"), "dirty\n");

    const result = await cleanupExpiredWorktrees({
      worktreesRoot,
      gitCacheRoot,
      maxUnusedMs: 1_000,
      now: 3_000,
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.removed, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(await pathExists(worktreePath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureReviewHistory deepens a shallow PR checkout until merge-base exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "better-review-pr-checkout-"));

  try {
    const source = join(root, "source");
    const cache = join(root, "cache.git");

    await git(root, ["init", source]);
    await git(source, ["config", "user.email", "review@example.com"]);
    await git(source, ["config", "user.name", "Review Test"]);

    const mergeBaseSha = await commitFile(source, "src/app.ts", "base\n", "base");
    await git(source, ["checkout", "-b", "develop"]);
    await commitFile(source, "src/app.ts", "base\ndevelop\n", "develop");
    await git(source, ["checkout", "-b", "feature", mergeBaseSha]);
    const headSha = await commitFile(source, "src/app.ts", "base\nfeature\n", "feature");
    await git(source, ["update-ref", "refs/pull/1/head", "feature"]);

    await git(root, ["init", "--bare", cache]);
    await git(cache, ["remote", "add", "origin", source]);
    await git(cache, [
      "fetch",
      "--depth=1",
      "origin",
      "refs/heads/develop:refs/remotes/origin/develop",
    ]);
    await git(cache, ["fetch", "--depth=1", "origin", "refs/pull/1/head"]);

    await assert.rejects(
      execFileAsync("git", ["-C", cache, "merge-base", "refs/remotes/origin/develop", headSha]),
    );

    const input: PreparePrCheckoutInput = {
      owner: "owner",
      repo: "repo",
      number: 1,
      prUrl: "https://github.com/owner/repo/pull/1",
      baseSha: mergeBaseSha,
      headSha,
      baseRef: "develop",
      headRef: "feature",
      reviewMode: "full",
      commitSha: null,
      files: ["src/app.ts"],
    };

    await ensureReviewHistory(cache, input);

    const resolvedMergeBase = await git(cache, [
      "merge-base",
      "refs/remotes/origin/develop",
      headSha,
    ]);

    assert.equal(resolvedMergeBase, mergeBaseSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureReviewHistory force-refreshes a non-fast-forward base ref", async () => {
  const root = await mkdtemp(join(tmpdir(), "better-review-pr-checkout-non-ff-"));

  try {
    const source = join(root, "source");
    const cache = join(root, "cache.git");

    await git(root, ["init", source]);
    await git(source, ["config", "user.email", "review@example.com"]);
    await git(source, ["config", "user.name", "Review Test"]);

    await commitFile(source, "src/app.ts", "old develop\n", "old develop");
    await git(source, ["checkout", "-b", "develop"]);

    await git(root, ["init", "--bare", cache]);
    await git(cache, ["remote", "add", "origin", source]);
    await git(cache, [
      "fetch",
      "--depth=1",
      "origin",
      "refs/heads/develop:refs/remotes/origin/develop",
    ]);

    await git(source, ["checkout", "--orphan", "rewritten-develop"]);
    await git(source, ["rm", "-rf", "."]);
    const rewrittenBaseSha = await commitFile(
      source,
      "src/app.ts",
      "rewritten develop\n",
      "rewritten develop",
    );
    await git(source, ["branch", "-M", "develop"]);
    await git(source, ["checkout", "-b", "feature"]);
    const headSha = await commitFile(source, "src/app.ts", "feature\n", "feature");
    await git(source, ["update-ref", "refs/pull/1/head", "feature"]);

    await git(cache, ["fetch", "--depth=1", "origin", "refs/pull/1/head"]);

    const input: PreparePrCheckoutInput = {
      owner: "owner",
      repo: "repo",
      number: 1,
      prUrl: "https://github.com/owner/repo/pull/1",
      baseSha: rewrittenBaseSha,
      headSha,
      baseRef: "develop",
      headRef: "feature",
      reviewMode: "full",
      commitSha: null,
      files: ["src/app.ts"],
    };

    await ensureReviewHistory(cache, input);

    const immutableBaseRef = reviewBaseRef(input);
    const refreshedBase = await git(cache, ["rev-parse", immutableBaseRef]);
    const resolvedMergeBase = await git(cache, ["merge-base", immutableBaseRef, headSha]);

    assert.equal(refreshedBase, rewrittenBaseSha);
    assert.equal(resolvedMergeBase, rewrittenBaseSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fetchPullHeadBranch preserves review history hydrated before worktree creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "better-review-pr-branch-history-"));

  try {
    const source = join(root, "source");
    const cache = join(root, "cache.git");

    await git(root, ["init", source]);
    await git(source, ["config", "user.email", "review@example.com"]);
    await git(source, ["config", "user.name", "Review Test"]);

    const baseSha = await commitFile(source, "src/app.ts", "base\n", "base");
    await git(source, ["checkout", "-b", "feature"]);
    const headSha = await commitFile(source, "src/app.ts", "feature\n", "feature");
    await git(source, ["update-ref", "refs/pull/1/head", headSha]);

    await git(root, ["init", "--bare", cache]);
    await git(cache, ["remote", "add", "origin", source]);
    await git(cache, ["fetch", "--depth=1", "origin", "refs/pull/1/head"]);

    const input: PreparePrCheckoutInput = {
      owner: "owner",
      repo: "repo",
      number: 1,
      prUrl: "https://github.com/owner/repo/pull/1",
      baseSha,
      headSha,
      baseRef: "main",
      headRef: "feature",
      reviewMode: "full",
      commitSha: null,
      files: ["src/app.ts"],
    };

    await ensureReviewHistory(cache, input);
    assert.equal(await git(cache, ["merge-base", reviewBaseRef(input), headSha]), baseSha);

    const localBranch = `pr-1-feature-${headSha.slice(0, 12)}`;
    await fetchPullHeadBranch(cache, input, localBranch);

    assert.equal(await git(cache, ["rev-parse", `refs/heads/${localBranch}`]), headSha);
    assert.equal(await git(cache, ["merge-base", reviewBaseRef(input), headSha]), baseSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review base refs stay pinned when another review uses the same base branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "better-review-pinned-base-"));

  try {
    const source = join(root, "source");
    const cache = join(root, "cache.git");

    await git(root, ["init", source]);
    await git(source, ["config", "user.email", "review@example.com"]);
    await git(source, ["config", "user.name", "Review Test"]);

    const firstBaseSha = await commitFile(source, "src/app.ts", "first base\n", "first base");
    await git(source, ["checkout", "-b", "develop"]);
    await git(source, ["checkout", "-b", "first-feature"]);
    const firstHeadSha = await commitFile(source, "src/app.ts", "first feature\n", "first feature");
    await git(source, ["update-ref", "refs/pull/1/head", firstHeadSha]);

    await git(source, ["checkout", "develop"]);
    const secondBaseSha = await commitFile(source, "src/app.ts", "second base\n", "second base");
    await git(source, ["checkout", "-b", "second-feature"]);
    const secondHeadSha = await commitFile(
      source,
      "src/app.ts",
      "second feature\n",
      "second feature",
    );
    await git(source, ["update-ref", "refs/pull/2/head", secondHeadSha]);
    await git(source, ["checkout", "develop"]);

    await git(root, ["init", "--bare", cache]);
    await git(cache, ["remote", "add", "origin", source]);
    await git(cache, ["fetch", "origin", "+refs/pull/1/head:refs/heads/pr-1"]);
    await git(cache, ["fetch", "origin", "+refs/pull/2/head:refs/heads/pr-2"]);

    const firstInput: PreparePrCheckoutInput = {
      owner: "owner",
      repo: "repo",
      number: 1,
      prUrl: "https://github.com/owner/repo/pull/1",
      baseSha: firstBaseSha,
      headSha: firstHeadSha,
      baseRef: "develop",
      headRef: "first-feature",
      reviewMode: "full",
      commitSha: null,
      files: ["src/app.ts"],
    };
    const secondInput: PreparePrCheckoutInput = {
      ...firstInput,
      number: 2,
      prUrl: "https://github.com/owner/repo/pull/2",
      baseSha: secondBaseSha,
      headSha: secondHeadSha,
      headRef: "second-feature",
    };

    await ensureReviewHistory(cache, firstInput);
    await ensureReviewHistory(cache, secondInput);

    assert.equal(await git(cache, ["rev-parse", reviewBaseRef(firstInput)]), firstBaseSha);
    assert.equal(await git(cache, ["rev-parse", reviewBaseRef(secondInput)]), secondBaseSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureOfflineReviewDiff hydrates partial-clone blobs before sandboxing", async () => {
  const root = await mkdtemp(join(tmpdir(), "better-review-offline-diff-"));

  try {
    const source = join(root, "source");
    const cache = join(root, "cache.git");
    const worktree = join(root, "worktree");

    await git(root, ["init", source]);
    await git(source, ["config", "user.email", "review@example.com"]);
    await git(source, ["config", "user.name", "Review Test"]);
    await git(source, ["config", "uploadpack.allowFilter", "true"]);

    const baseSha = await commitFile(source, "src/app.ts", "base content\n", "base");
    await git(source, ["checkout", "-b", "develop"]);
    await git(source, ["checkout", "-b", "feature"]);
    const headSha = await commitFile(source, "src/app.ts", "feature content\n", "feature");
    await git(source, ["update-ref", "refs/pull/1/head", headSha]);
    await git(source, ["checkout", "develop"]);

    await git(root, ["clone", "--bare", "--filter=blob:none", `file://${source}`, cache]);
    await git(cache, ["fetch", "origin", "+refs/pull/1/head:refs/heads/pr-1"]);
    await git(cache, ["worktree", "add", worktree, "pr-1"]);

    const input: PreparePrCheckoutInput = {
      owner: "owner",
      repo: "repo",
      number: 1,
      prUrl: "https://github.com/owner/repo/pull/1",
      baseSha,
      headSha,
      baseRef: "develop",
      headRef: "feature",
      reviewMode: "full",
      commitSha: null,
      files: ["src/app.ts"],
    };

    await ensureReviewHistory(cache, input);
    await assert.rejects(
      execFileAsync("git", [
        "--no-lazy-fetch",
        "-C",
        worktree,
        "diff",
        "--stat",
        `${reviewBaseRef(input)}...HEAD`,
      ]),
    );

    await ensureOfflineReviewDiff(cache, input);

    const offlineDiff = await git(root, [
      "--no-lazy-fetch",
      "-C",
      worktree,
      "diff",
      "--stat",
      `${reviewBaseRef(input)}...HEAD`,
    ]);
    assert.match(offlineDiff, /src\/app\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifyWorktreeAccess proves the reviewer can see changed and unchanged tracked files", async () => {
  const root = await mkdtemp(join(tmpdir(), "better-review-repo-access-"));

  try {
    const source = join(root, "source");

    await git(root, ["init", source]);
    await git(source, ["config", "user.email", "review@example.com"]);
    await git(source, ["config", "user.name", "Review Test"]);

    const baseSha = await commitFile(source, "src/app.ts", "base\n", "base");
    await commitFile(source, "docs/context.md", "repo context\n", "add docs");
    const headSha = await commitFile(source, "src/app.ts", "changed\n", "change app");

    const input: PreparePrCheckoutInput = {
      owner: "owner",
      repo: "repo",
      number: 1,
      prUrl: "https://github.com/owner/repo/pull/1",
      baseSha,
      headSha,
      baseRef: "develop",
      headRef: "feature",
      reviewMode: "full",
      commitSha: null,
      files: ["src/app.ts"],
    };

    const access = await verifyWorktreeAccess(source, input);

    assert.equal(access.sparseCheckout, false);
    assert.equal(access.trackedFileCount, 2);
    assert.ok(access.sampledFiles.includes("src/app.ts"));
    assert.ok(access.sampledFiles.includes("docs/context.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifyWorktreeAccess skips tracked paths that are directories in the worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "better-review-repo-access-dir-"));

  try {
    const source = join(root, "source");

    await git(root, ["init", source]);
    await git(source, ["config", "user.email", "review@example.com"]);
    await git(source, ["config", "user.name", "Review Test"]);

    const baseSha = await commitFile(source, "src/app.ts", "base\n", "base");
    await commitFile(source, "docs/context.md", "repo context\n", "add docs");
    const headSha = await git(source, ["rev-parse", "HEAD"]);

    await rm(join(source, "src/app.ts"), { force: true });
    await mkdir(join(source, "src/app.ts"), { recursive: true });
    await writeFile(join(source, "src/app.ts", "nested.txt"), "directory now\n");

    const input: PreparePrCheckoutInput = {
      owner: "owner",
      repo: "repo",
      number: 1,
      prUrl: "https://github.com/owner/repo/pull/1",
      baseSha,
      headSha,
      baseRef: "develop",
      headRef: "feature",
      reviewMode: "full",
      commitSha: null,
      files: ["src/app.ts"],
    };

    const access = await verifyWorktreeAccess(source, input);

    assert.equal(access.sparseCheckout, false);
    assert.equal(access.trackedFileCount, 2);
    assert.deepEqual(access.sampledFiles, ["docs/context.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
