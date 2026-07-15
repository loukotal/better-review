import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { Data, Effect, Schedule } from "effect";

import { runCommand } from "./command";
import { STORE_BASE_DIR } from "./store";

class CheckoutError extends Data.TaggedError("CheckoutError")<{
  readonly command: string;
  readonly cause: unknown;
}> {}

export interface PreparePrCheckoutInput {
  owner: string;
  repo: string;
  number: number;
  prUrl: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  reviewMode: "full" | "commit";
  commitSha: string | null;
  files: string[];
}

export interface PreparedPrCheckout {
  worktreePath: string;
  repoAccess: RepoAccessCheck;
}

export interface RepoAccessCheck {
  checkedAt: number;
  trackedFileCount: number;
  sampledFiles: string[];
  sparseCheckout: boolean;
}

export interface RepoGitQueueInfo {
  queued: boolean;
  waitedMs: number;
}

export interface WorktreeCleanupOptions {
  worktreesRoot?: string;
  gitCacheRoot?: string;
  maxUnusedMs?: number;
  now?: number;
  getPrState?: (prUrl: string) => Promise<PullRequestState | null>;
}

export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

export interface WorktreeCleanupError {
  worktreePath: string;
  message: string;
}

export interface WorktreeCleanupResult {
  scanned: number;
  removed: number;
  skipped: number;
  errors: WorktreeCleanupError[];
}

interface PreparedCheckoutManifest {
  version: 1;
  owner: string;
  repo: string;
  number: number;
  prUrl: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  reviewMode: "full" | "commit";
  commitSha: string | null;
  files: string[];
  repoAccess: RepoAccessCheck;
  preparedAt: number;
  lastUsedAt?: number;
}

interface CheckoutTracePhase {
  name: string;
  elapsedMs: number;
  totalMs: number;
}

const CHECKOUT_TIMEOUT_MS = Number(process.env.BETTER_REVIEW_CHECKOUT_TIMEOUT_MS ?? 120_000);
const REVIEW_HISTORY_DEEPEN_STEP = Number(process.env.BETTER_REVIEW_HISTORY_DEEPEN_STEP ?? 100);
const REVIEW_HISTORY_DEEPEN_ATTEMPTS = Number(
  process.env.BETTER_REVIEW_HISTORY_DEEPEN_ATTEMPTS ?? 5,
);
const GIT_LOCK_RETRY_ATTEMPTS = Number(process.env.BETTER_REVIEW_GIT_LOCK_RETRY_ATTEMPTS ?? 20);
const GIT_LOCK_RETRY_DELAY_MS = Number(process.env.BETTER_REVIEW_GIT_LOCK_RETRY_DELAY_MS ?? 250);
const WORKTREE_MAX_UNUSED_MS = Number(
  process.env.BETTER_REVIEW_WORKTREE_MAX_UNUSED_MS ??
    Number(process.env.BETTER_REVIEW_WORKTREE_MAX_UNUSED_DAYS ?? 3) * 24 * 60 * 60 * 1000,
);
const WORKTREE_CLEANUP_INTERVAL_MS = Number(
  process.env.BETTER_REVIEW_WORKTREE_CLEANUP_INTERVAL_MS ?? 6 * 60 * 60 * 1000,
);

const repoGitQueues = new Map<string, Promise<void>>();

function safePathPart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error(`Invalid repository path segment: ${value}`);
  return safe;
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

function getErrnoCode(error: unknown): string | undefined {
  let current = error;

  while (current && typeof current === "object") {
    const record = current as { code?: unknown; cause?: unknown; error?: unknown };
    if (typeof record.code === "string") return record.code;
    current = record.cause ?? record.error;
  }

  return undefined;
}

async function readDirSafe(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") return [];
    throw error;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  return target === root || target.startsWith(`${root}${sep}`);
}

function parseNullSeparatedList(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function isGitLockError(message: string): boolean {
  return (
    message.includes(".lock") &&
    message.includes("File exists") &&
    message.includes("Another git process")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRequired(command: string, args: string[], cwd?: string): Promise<string> {
  for (let attempt = 0; attempt <= GIT_LOCK_RETRY_ATTEMPTS; attempt += 1) {
    const result = await runCommand(command, args, { cwd, timeoutMs: CHECKOUT_TIMEOUT_MS });
    if (result.timedOut) {
      throw new Error(`${command} ${args.join(" ")} timed out after ${CHECKOUT_TIMEOUT_MS}ms`);
    }
    if (result.exitCode === 0) {
      return result.stdout;
    }

    const output = result.stderr || result.stdout;
    if (command === "git" && isGitLockError(output) && attempt < GIT_LOCK_RETRY_ATTEMPTS) {
      await sleep(GIT_LOCK_RETRY_DELAY_MS);
      continue;
    }

    throw new Error(`${command} ${args.join(" ")} failed: ${output}`);
  }

  throw new Error(`${command} ${args.join(" ")} failed`);
}

async function runWorktreeGit(worktreePath: string, args: string[]): Promise<string> {
  return runRequired("git", ["-C", worktreePath, ...args]);
}

async function runGit(repoGitDir: string, args: string[]): Promise<string> {
  return runRequired("git", ["-C", repoGitDir, ...args]);
}

export function githubRepoRemoteUrl(owner: string, repo: string, gitProtocol: string): string {
  if (gitProtocol.trim() === "ssh") {
    return `git@github.com:${owner}/${repo}.git`;
  }
  return `https://github.com/${owner}/${repo}.git`;
}

async function getConfiguredGitHubRepoRemoteUrl(owner: string, repo: string): Promise<string> {
  const result = await runCommand("gh", ["config", "get", "git_protocol", "--host", "github.com"], {
    timeoutMs: CHECKOUT_TIMEOUT_MS,
  });
  if (result.exitCode === 0 && !result.timedOut) {
    return githubRepoRemoteUrl(owner, repo, result.stdout);
  }

  return githubRepoRemoteUrl(owner, repo, "https");
}

export async function withRepoGitQueue<T>(
  repoGitDir: string,
  operation: (queue: RepoGitQueueInfo) => Promise<T>,
): Promise<T> {
  const queuedAt = Date.now();
  const queuedBehindAnotherOperation = repoGitQueues.has(repoGitDir);
  const previous = repoGitQueues.get(repoGitDir) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  repoGitQueues.set(repoGitDir, queued);

  await previous.catch(() => undefined);
  const queue = {
    queued: queuedBehindAnotherOperation,
    waitedMs: Date.now() - queuedAt,
  };

  try {
    return await operation(queue);
  } finally {
    release();
    if (repoGitQueues.get(repoGitDir) === queued) {
      repoGitQueues.delete(repoGitDir);
    }
  }
}

async function ensureBareRepo(owner: string, repo: string, repoGitDir: string): Promise<void> {
  const remoteUrl = await getConfiguredGitHubRepoRemoteUrl(owner, repo);

  if (!(await pathExists(repoGitDir))) {
    await mkdir(join(repoGitDir, ".."), { recursive: true });
    await runRequired("gh", [
      "repo",
      "clone",
      `${owner}/${repo}`,
      repoGitDir,
      "--",
      "--bare",
      "--filter=blob:none",
      "--no-tags",
      "--depth=1",
    ]);
  }

  await runRequired("git", ["-C", repoGitDir, "remote", "set-url", "origin", remoteUrl]);
  await runRequired("git", ["-C", repoGitDir, "config", "remote.origin.promisor", "true"]);
  await runRequired("git", [
    "-C",
    repoGitDir,
    "config",
    "remote.origin.partialclonefilter",
    "blob:none",
  ]);
}

function baseRemoteRef(input: PreparePrCheckoutInput): string {
  return `refs/remotes/origin/${input.baseRef}`;
}

function pullHeadRef(input: PreparePrCheckoutInput): string {
  return `refs/pull/${input.number}/head`;
}

async function fetchBaseRef(
  repoGitDir: string,
  input: PreparePrCheckoutInput,
  historyArgs: string[] = ["--depth=1"],
): Promise<void> {
  await runGit(repoGitDir, [
    "fetch",
    "--no-tags",
    "--filter=blob:none",
    ...historyArgs,
    "origin",
    `+refs/heads/${input.baseRef}:${baseRemoteRef(input)}`,
  ]);
}

async function fetchPullHeadObjects(
  repoGitDir: string,
  input: PreparePrCheckoutInput,
  historyArgs: string[],
): Promise<void> {
  await runGit(repoGitDir, [
    "fetch",
    "--no-tags",
    "--filter=blob:none",
    ...historyArgs,
    "origin",
    pullHeadRef(input),
  ]);
}

async function getWorktreeHead(worktreePath: string): Promise<string | null> {
  if (!(await pathExists(join(worktreePath, ".git")))) return null;

  const result = await runCommand("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
    timeoutMs: CHECKOUT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0 || result.timedOut) return null;
  return result.stdout.trim();
}

async function refMatchesCommit(
  repoGitDir: string,
  ref: string,
  commitSha: string,
): Promise<boolean> {
  const result = await runCommand("git", [
    "-C",
    repoGitDir,
    "rev-parse",
    "--verify",
    `${ref}^{commit}`,
  ]);
  return result.exitCode === 0 && result.stdout.trim() === commitSha;
}

function localPrBranchName(input: PreparePrCheckoutInput): string {
  return safePathPart(`pr-${input.number}-${input.headRef}-${input.headSha.slice(0, 12)}`);
}

async function traceCheckoutPhase<T>(
  trace: CheckoutTracePhase[],
  overallStartedAt: number,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const phaseStartedAt = Date.now();
  try {
    return await operation();
  } finally {
    trace.push({
      name,
      elapsedMs: Date.now() - phaseStartedAt,
      totalMs: Date.now() - overallStartedAt,
    });
  }
}

async function ensureBaseRef(repoGitDir: string, input: PreparePrCheckoutInput): Promise<void> {
  if (!(await refMatchesCommit(repoGitDir, baseRemoteRef(input), input.baseSha))) {
    await fetchBaseRef(repoGitDir, input);
  }

  // Also materialize a local branch name (e.g. `develop`) so common commands like
  // `git merge-base develop HEAD` work inside the worktree. Force it to the fetched
  // remote base to avoid stale local base refs in the bare cache.
  await runGit(repoGitDir, ["update-ref", `refs/heads/${input.baseRef}`, baseRemoteRef(input)]);
}

async function fetchPullHeadBranch(
  repoGitDir: string,
  input: PreparePrCheckoutInput,
  localBranch: string,
): Promise<void> {
  if (await refMatchesCommit(repoGitDir, `refs/heads/${localBranch}`, input.headSha)) {
    return;
  }

  await runGit(repoGitDir, [
    "fetch",
    "--no-tags",
    "--filter=blob:none",
    "--depth=1",
    "origin",
    `+${pullHeadRef(input)}:refs/heads/${localBranch}`,
  ]);
}

async function hasMergeBase(repoGitDir: string, input: PreparePrCheckoutInput): Promise<boolean> {
  const result = await runCommand("git", [
    "-C",
    repoGitDir,
    "merge-base",
    baseRemoteRef(input),
    input.headSha,
  ]);

  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

async function hasCommitParent(repoGitDir: string, commitSha: string): Promise<boolean> {
  const result = await runCommand("git", [
    "-C",
    repoGitDir,
    "rev-parse",
    "--verify",
    `${commitSha}^`,
  ]);

  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

async function isShallowRepository(repoGitDir: string): Promise<boolean> {
  const result = await runCommand("git", [
    "-C",
    repoGitDir,
    "rev-parse",
    "--is-shallow-repository",
  ]);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function fetchFullerReviewHistory(
  repoGitDir: string,
  input: PreparePrCheckoutInput,
): Promise<void> {
  if (await isShallowRepository(repoGitDir)) {
    await fetchBaseRef(repoGitDir, input, ["--unshallow"]);
  } else {
    await fetchBaseRef(repoGitDir, input, []);
  }
  await fetchPullHeadObjects(repoGitDir, input, []);
}

async function ensureFullPrHistory(repoGitDir: string, input: PreparePrCheckoutInput) {
  if (await hasMergeBase(repoGitDir, input)) return;

  if (await isShallowRepository(repoGitDir)) {
    for (let attempt = 0; attempt < REVIEW_HISTORY_DEEPEN_ATTEMPTS; attempt += 1) {
      const deepenArgs = ["--deepen", String(REVIEW_HISTORY_DEEPEN_STEP)];
      await fetchBaseRef(repoGitDir, input, deepenArgs);
      await fetchPullHeadObjects(repoGitDir, input, deepenArgs);
      if (await hasMergeBase(repoGitDir, input)) return;
    }
  }

  await fetchFullerReviewHistory(repoGitDir, input);
  if (await hasMergeBase(repoGitDir, input)) return;

  throw new Error(
    `Could not find a merge base for ${baseRemoteRef(input)} and ${input.headSha}. The PR checkout cannot produce the canonical three-dot diff.`,
  );
}

async function ensureCommitReviewHistory(repoGitDir: string, input: PreparePrCheckoutInput) {
  if (!input.commitSha) return;
  if (await hasCommitParent(repoGitDir, input.commitSha)) return;

  if (await isShallowRepository(repoGitDir)) {
    for (let attempt = 0; attempt < REVIEW_HISTORY_DEEPEN_ATTEMPTS; attempt += 1) {
      await fetchPullHeadObjects(repoGitDir, input, [
        "--deepen",
        String(REVIEW_HISTORY_DEEPEN_STEP),
      ]);
      if (await hasCommitParent(repoGitDir, input.commitSha)) return;
    }
  }

  await fetchFullerReviewHistory(repoGitDir, input);
  if (await hasCommitParent(repoGitDir, input.commitSha)) return;

  throw new Error(
    `Could not fetch parent commit for ${input.commitSha}. The PR checkout cannot produce the canonical commit diff.`,
  );
}

export async function ensureReviewHistory(
  repoGitDir: string,
  input: PreparePrCheckoutInput,
): Promise<void> {
  if (input.reviewMode === "commit" && input.commitSha) {
    await ensureCommitReviewHistory(repoGitDir, input);
    return;
  }

  await ensureFullPrHistory(repoGitDir, input);
}

function resolveWorktreePath(worktreePath: string, file: string): string {
  const root = resolve(worktreePath);
  const absolutePath = resolve(root, file);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    throw new Error(`Tracked file escapes worktree: ${file}`);
  }
  return absolutePath;
}

function selectAccessCandidateFiles(
  trackedFiles: string[],
  changedFiles: string[],
  sampleLimit = 32,
): string[] {
  const tracked = new Set(trackedFiles);
  const changed = new Set(changedFiles);
  const candidates = [
    ...changedFiles.filter((file) => tracked.has(file)),
    ...trackedFiles.filter((file) => !changed.has(file)),
    trackedFiles[0],
    trackedFiles[Math.floor(trackedFiles.length / 2)],
    trackedFiles[trackedFiles.length - 1],
  ].filter((file): file is string => Boolean(file));

  return [...new Set(candidates)].slice(0, sampleLimit);
}

async function readFileSample(worktreePath: string, file: string): Promise<boolean> {
  const path = resolveWorktreePath(worktreePath, file);
  const stats = await lstat(path);
  if (!stats.isFile()) return false;

  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, buffer.length, 0);
    return true;
  } finally {
    await handle.close();
  }
}

async function isSparseCheckoutEnabled(worktreePath: string): Promise<boolean> {
  const result = await runCommand("git", [
    "-C",
    worktreePath,
    "config",
    "--bool",
    "core.sparseCheckout",
  ]);

  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export async function verifyWorktreeAccess(
  worktreePath: string,
  input: PreparePrCheckoutInput,
): Promise<RepoAccessCheck> {
  const root = (await runWorktreeGit(worktreePath, ["rev-parse", "--show-toplevel"])).trim();
  if ((await realpath(root)) !== (await realpath(worktreePath))) {
    throw new Error(`Reviewer worktree root mismatch: expected ${worktreePath}, got ${root}`);
  }

  const trackedFiles = parseNullSeparatedList(
    await runWorktreeGit(worktreePath, ["ls-files", "-z"]),
  );
  if (trackedFiles.length === 0) {
    throw new Error("Reviewer worktree has no tracked files");
  }

  const sparseCheckout = await isSparseCheckoutEnabled(worktreePath);
  if (sparseCheckout) {
    throw new Error("Reviewer worktree is sparse; full repository access is not available");
  }

  const candidateFiles = selectAccessCandidateFiles(trackedFiles, input.files);
  const sampledFiles: string[] = [];
  for (const file of candidateFiles) {
    if (sampledFiles.length >= 8) break;
    try {
      if (await readFileSample(worktreePath, file)) {
        sampledFiles.push(file);
      }
    } catch (error) {
      const code = getErrnoCode(error);
      if (code !== "ENOENT" && code !== "EISDIR") {
        throw error;
      }
    }
  }

  if (sampledFiles.length === 0) {
    throw new Error("Reviewer worktree has no readable regular file samples");
  }

  return {
    checkedAt: Date.now(),
    trackedFileCount: trackedFiles.length,
    sampledFiles,
    sparseCheckout,
  };
}

function checkoutManifestPath(worktreePath: string): string {
  return join(worktreePath, ".better-review", "CHECKOUT_READY.json");
}

function isRepoAccessCheck(value: unknown): value is RepoAccessCheck {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.checkedAt === "number" &&
    typeof record.trackedFileCount === "number" &&
    Array.isArray(record.sampledFiles) &&
    record.sampledFiles.every((file) => typeof file === "string") &&
    typeof record.sparseCheckout === "boolean"
  );
}

function isPreparedCheckoutManifest(value: unknown): value is PreparedCheckoutManifest {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.owner === "string" &&
    typeof record.repo === "string" &&
    typeof record.number === "number" &&
    typeof record.prUrl === "string" &&
    typeof record.baseSha === "string" &&
    typeof record.headSha === "string" &&
    typeof record.baseRef === "string" &&
    typeof record.headRef === "string" &&
    (record.reviewMode === "full" || record.reviewMode === "commit") &&
    (typeof record.commitSha === "string" || record.commitSha === null) &&
    Array.isArray(record.files) &&
    record.files.every((file) => typeof file === "string") &&
    isRepoAccessCheck(record.repoAccess) &&
    typeof record.preparedAt === "number" &&
    (typeof record.lastUsedAt === "number" || record.lastUsedAt === undefined)
  );
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function manifestMatchesInput(
  manifest: PreparedCheckoutManifest,
  input: PreparePrCheckoutInput,
): boolean {
  return (
    manifest.owner === input.owner &&
    manifest.repo === input.repo &&
    manifest.number === input.number &&
    manifest.prUrl === input.prUrl &&
    manifest.baseSha === input.baseSha &&
    manifest.headSha === input.headSha &&
    manifest.baseRef === input.baseRef &&
    manifest.headRef === input.headRef &&
    manifest.reviewMode === input.reviewMode &&
    manifest.commitSha === input.commitSha &&
    sameStringList(manifest.files, input.files)
  );
}

async function readPreparedCheckout(
  worktreePath: string,
  input: PreparePrCheckoutInput,
): Promise<PreparedPrCheckout | null> {
  try {
    const manifest = JSON.parse(
      await readFile(checkoutManifestPath(worktreePath), "utf8"),
    ) as unknown;
    if (!isPreparedCheckoutManifest(manifest) || !manifestMatchesInput(manifest, input)) {
      return null;
    }
    await writeFile(
      checkoutManifestPath(worktreePath),
      JSON.stringify({ ...manifest, lastUsedAt: Date.now() }, null, 2),
    );
    return { worktreePath, repoAccess: manifest.repoAccess };
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readCheckoutManifest(
  worktreePath: string,
): Promise<PreparedCheckoutManifest | null> {
  try {
    const manifest = JSON.parse(
      await readFile(checkoutManifestPath(worktreePath), "utf8"),
    ) as unknown;
    return isPreparedCheckoutManifest(manifest) ? manifest : null;
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

function checkoutLastUsedAt(manifest: PreparedCheckoutManifest): number {
  return manifest.lastUsedAt ?? manifest.preparedAt ?? manifest.repoAccess.checkedAt;
}

async function listPreparedWorktrees(worktreesRoot: string): Promise<string[]> {
  const worktrees: string[] = [];

  for (const owner of await readDirSafe(worktreesRoot)) {
    if (!owner.isDirectory()) continue;
    const ownerPath = join(worktreesRoot, owner.name);

    for (const repo of await readDirSafe(ownerPath)) {
      if (!repo.isDirectory()) continue;
      const repoPath = join(ownerPath, repo.name);

      for (const worktree of await readDirSafe(repoPath)) {
        if (!worktree.isDirectory()) continue;
        worktrees.push(join(repoPath, worktree.name));
      }
    }
  }

  return worktrees;
}

function repoGitDirForManifest(gitCacheRoot: string, manifest: PreparedCheckoutManifest): string {
  return join(gitCacheRoot, safePathPart(manifest.owner), `${safePathPart(manifest.repo)}.git`);
}

async function getWorktreeRemovalBlocker(worktreePath: string): Promise<string | null> {
  const result = await runCommand("git", [
    "-C",
    worktreePath,
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
  ]);
  if (result.exitCode !== 0 || result.timedOut) {
    return `git status failed: ${result.stderr || result.stdout || "unknown error"}`;
  }

  for (const entry of parseNullSeparatedList(result.stdout)) {
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status === "??" && (file === ".better-review" || file.startsWith(".better-review/"))) {
      continue;
    }
    return `worktree has local changes: ${entry}`;
  }

  return null;
}

async function removePreparedWorktree(repoGitDir: string, worktreePath: string): Promise<void> {
  await runGit(repoGitDir, ["worktree", "remove", "--force", worktreePath]);
  await runGit(repoGitDir, ["worktree", "prune"]);
}

async function getGitHubPrState(prUrl: string): Promise<PullRequestState | null> {
  const result = await runCommand(
    "gh",
    ["pr", "view", prUrl, "--json", "state", "--jq", ".state"],
    { timeoutMs: CHECKOUT_TIMEOUT_MS },
  );
  if (result.exitCode !== 0 || result.timedOut) return null;

  const state = result.stdout.trim();
  return state === "OPEN" || state === "CLOSED" || state === "MERGED" ? state : null;
}

export async function cleanupExpiredWorktrees(
  options: WorktreeCleanupOptions = {},
): Promise<WorktreeCleanupResult> {
  const worktreesRoot = options.worktreesRoot ?? join(STORE_BASE_DIR, "worktrees", "github");
  const gitCacheRoot = options.gitCacheRoot ?? join(STORE_BASE_DIR, "git-cache", "github");
  const maxUnusedMs = options.maxUnusedMs ?? WORKTREE_MAX_UNUSED_MS;
  const now = options.now ?? Date.now();
  const getPrState = options.getPrState ?? getGitHubPrState;
  const prStates = new Map<string, Promise<PullRequestState | null>>();
  const result: WorktreeCleanupResult = { scanned: 0, removed: 0, skipped: 0, errors: [] };

  for (const worktreePath of await listPreparedWorktrees(worktreesRoot)) {
    result.scanned += 1;

    try {
      if (!isPathInside(worktreesRoot, worktreePath)) {
        result.skipped += 1;
        continue;
      }

      const manifest = await readCheckoutManifest(worktreePath);
      if (!manifest) {
        result.skipped += 1;
        continue;
      }

      const unusedMs = now - checkoutLastUsedAt(manifest);
      if (unusedMs < maxUnusedMs) {
        let statePromise = prStates.get(manifest.prUrl);
        if (!statePromise) {
          statePromise = getPrState(manifest.prUrl);
          prStates.set(manifest.prUrl, statePromise);
        }
        if ((await statePromise) !== "MERGED") {
          result.skipped += 1;
          continue;
        }
      }

      const repoGitDir = repoGitDirForManifest(gitCacheRoot, manifest);
      if (!(await pathExists(repoGitDir))) {
        result.errors.push({
          worktreePath,
          message: `cached git repository is missing: ${repoGitDir}`,
        });
        continue;
      }

      await withRepoGitQueue(repoGitDir, async () => {
        const blocker = await getWorktreeRemovalBlocker(worktreePath);
        if (blocker) {
          result.skipped += 1;
          return;
        }

        await removePreparedWorktree(repoGitDir, worktreePath);
        result.removed += 1;
      });
    } catch (error) {
      result.errors.push({
        worktreePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

async function writePrContext(
  input: PreparePrCheckoutInput,
  worktreePath: string,
  repoAccess: RepoAccessCheck,
): Promise<void> {
  const contextDir = join(worktreePath, ".better-review");
  await mkdir(contextDir, { recursive: true });

  const scope =
    input.reviewMode === "commit" && input.commitSha
      ? `commit ${input.commitSha}`
      : `full PR ${input.baseSha}..${input.headSha}`;

  const fileList =
    input.files.length > 0 ? input.files.map((file) => `- ${file}`).join("\n") : "- (unknown)";

  await writeFile(
    join(contextDir, "PR_CONTEXT.md"),
    [
      `# PR ${input.owner}/${input.repo}#${input.number}`,
      "",
      `URL: ${input.prUrl}`,
      `Base branch: ${input.baseRef}`,
      `Head branch: ${input.headRef}`,
      `Local review branch: ${localPrBranchName(input)}`,
      `Base SHA: ${input.baseSha}`,
      `Head SHA: ${input.headSha}`,
      `Review scope: ${scope}`,
      "",
      "Canonical PR diff commands:",
      input.reviewMode === "commit" && input.commitSha
        ? `- git diff --stat ${input.commitSha}^..${input.commitSha}`
        : `- git diff --stat origin/${input.baseRef}...HEAD`,
      input.reviewMode === "commit" && input.commitSha
        ? `- git diff --name-only ${input.commitSha}^..${input.commitSha}`
        : `- git diff --name-only origin/${input.baseRef}...HEAD`,
      input.reviewMode === "commit" && input.commitSha
        ? `- git diff ${input.commitSha}^..${input.commitSha}`
        : `- git diff origin/${input.baseRef}...HEAD`,
      "",
      "Changed files from the app:",
      fileList,
      "",
      "Repository access check:",
      `- Status: passed`,
      `- Tracked files visible: ${repoAccess.trackedFileCount}`,
      `- Sparse checkout: ${repoAccess.sparseCheckout ? "enabled" : "disabled"}`,
      `- Readable file samples: ${repoAccess.sampledFiles.join(", ")}`,
      "",
      "Use this checkout as the source of truth. Prefer code navigation, tests, and git commands over judging only a patch.",
      `Do not review files outside the canonical PR diff unless the user explicitly asks for broader context.`,
      `Do not fall back to raw SHA ranges like ${input.baseSha}..HEAD. If the canonical diff fails, report that the prepared checkout is invalid and reload the PR session.`,
    ].join("\n"),
  );

  const manifest: PreparedCheckoutManifest = {
    version: 1,
    owner: input.owner,
    repo: input.repo,
    number: input.number,
    prUrl: input.prUrl,
    baseSha: input.baseSha,
    headSha: input.headSha,
    baseRef: input.baseRef,
    headRef: input.headRef,
    reviewMode: input.reviewMode,
    commitSha: input.commitSha,
    files: input.files,
    repoAccess,
    preparedAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  await writeFile(checkoutManifestPath(worktreePath), JSON.stringify(manifest, null, 2));
}

function formatCheckoutTrace(trace: CheckoutTracePhase[]): string {
  return trace.map((phase) => `${phase.name}=${phase.elapsedMs}ms@${phase.totalMs}ms`).join(" ");
}

export class PrCheckoutService extends Effect.Service<PrCheckoutService>()("PrCheckoutService", {
  effect: Effect.succeed({
    cleanupExpiredWorktrees: (
      options?: WorktreeCleanupOptions,
    ): Effect.Effect<WorktreeCleanupResult, CheckoutError> =>
      Effect.tryPromise({
        try: () => cleanupExpiredWorktrees(options),
        catch: (cause) => new CheckoutError({ command: "cleanupExpiredWorktrees", cause }),
      }).pipe(
        Effect.withSpan("PrCheckoutService.cleanupExpiredWorktrees", {
          attributes: {
            maxUnusedMs: options?.maxUnusedMs ?? WORKTREE_MAX_UNUSED_MS,
          },
        }),
      ),

    backgroundCleanupLoop: Effect.gen(function* () {
      yield* Effect.log(
        `[worktree-cleanup] Starting background cleanup loop (maxUnused=${Math.round(WORKTREE_MAX_UNUSED_MS / (24 * 60 * 60 * 1000))}d interval=${Math.round(WORKTREE_CLEANUP_INTERVAL_MS / 1000)}s)`,
      );

      const runCleanup = Effect.tryPromise(() => cleanupExpiredWorktrees()).pipe(
        Effect.tap((result) =>
          Effect.log(
            `[worktree-cleanup] DONE scanned=${result.scanned} removed=${result.removed} skipped=${result.skipped} errors=${result.errors.length}`,
          ),
        ),
        Effect.tap((result) =>
          result.errors.length > 0
            ? Effect.log(
                `[worktree-cleanup] Errors: ${result.errors
                  .map((error) => `${error.worktreePath}: ${error.message}`)
                  .join("; ")}`,
              )
            : Effect.void,
        ),
        Effect.catchAll((error) => Effect.log(`[worktree-cleanup] Failed: ${String(error)}`)),
      );

      yield* runCleanup.pipe(Effect.repeat(Schedule.spaced(WORKTREE_CLEANUP_INTERVAL_MS)));
    }),

    prepare: (input: PreparePrCheckoutInput): Effect.Effect<PreparedPrCheckout, CheckoutError> => {
      const startedAt = Date.now();
      const trace: CheckoutTracePhase[] = [];

      return Effect.tryPromise({
        try: async () => {
          const owner = safePathPart(input.owner);
          const repo = safePathPart(input.repo);
          const repoGitDir = join(STORE_BASE_DIR, "git-cache", "github", owner, `${repo}.git`);
          const worktreePath = join(
            STORE_BASE_DIR,
            "worktrees",
            "github",
            owner,
            repo,
            `pr-${input.number}-${input.headSha.slice(0, 12)}`,
          );

          return await withRepoGitQueue(repoGitDir, async (queue) => {
            trace.push({
              name: queue.queued ? "queue.wait" : "queue.ready",
              elapsedMs: queue.waitedMs,
              totalMs: Date.now() - startedAt,
            });
            await traceCheckoutPhase(trace, startedAt, "ensureBareRepo", () =>
              ensureBareRepo(input.owner, input.repo, repoGitDir),
            );
            const localBranch = localPrBranchName(input);

            const currentHead = await traceCheckoutPhase(trace, startedAt, "getWorktreeHead", () =>
              getWorktreeHead(worktreePath),
            );
            if (currentHead === input.headSha) {
              const prepared = await traceCheckoutPhase(
                trace,
                startedAt,
                "readPreparedCheckout",
                () => readPreparedCheckout(worktreePath, input),
              );
              if (prepared) {
                trace.push({
                  name: "preparedWorktreeCache.hit",
                  elapsedMs: 0,
                  totalMs: Date.now() - startedAt,
                });
                return prepared;
              }
              trace.push({
                name: "preparedWorktreeCache.miss",
                elapsedMs: 0,
                totalMs: Date.now() - startedAt,
              });
            }

            await traceCheckoutPhase(trace, startedAt, "ensureBaseRef", () =>
              ensureBaseRef(repoGitDir, input),
            );
            if (currentHead === input.headSha) {
              await traceCheckoutPhase(trace, startedAt, "ensureReviewHistory", () =>
                ensureReviewHistory(repoGitDir, input),
              );
              const repoAccess = await traceCheckoutPhase(
                trace,
                startedAt,
                "verifyWorktreeAccess",
                () => verifyWorktreeAccess(worktreePath, input),
              );
              await traceCheckoutPhase(trace, startedAt, "writePrContext", () =>
                writePrContext(input, worktreePath, repoAccess),
              );
              return { worktreePath, repoAccess };
            }

            await traceCheckoutPhase(trace, startedAt, "fetchPullHeadBranch", () =>
              fetchPullHeadBranch(repoGitDir, input, localBranch),
            );
            await traceCheckoutPhase(trace, startedAt, "verifyHeadCommit", () =>
              runGit(repoGitDir, ["rev-parse", "--verify", `${input.headSha}^{commit}`]),
            );
            await traceCheckoutPhase(trace, startedAt, "ensureReviewHistory", () =>
              ensureReviewHistory(repoGitDir, input),
            );
            await traceCheckoutPhase(trace, startedAt, "createWorktreeParent", () =>
              mkdir(join(worktreePath, ".."), { recursive: true }),
            );
            await traceCheckoutPhase(trace, startedAt, "addWorktree", () =>
              runGit(repoGitDir, ["worktree", "add", worktreePath, localBranch]),
            );
            const repoAccess = await traceCheckoutPhase(
              trace,
              startedAt,
              "verifyWorktreeAccess",
              () => verifyWorktreeAccess(worktreePath, input),
            );
            await traceCheckoutPhase(trace, startedAt, "writePrContext", () =>
              writePrContext(input, worktreePath, repoAccess),
            );
            return { worktreePath, repoAccess };
          });
        },
        catch: (cause) => new CheckoutError({ command: "preparePrCheckout", cause }),
      }).pipe(
        Effect.tap(() =>
          Effect.log(
            `[pr-checkout.prepare] DONE ${input.owner}/${input.repo}#${input.number} head=${input.headSha.slice(0, 12)} total=${Date.now() - startedAt}ms ${formatCheckoutTrace(trace)}`,
          ),
        ),
        Effect.tapError((error) =>
          Effect.log(
            `[pr-checkout.prepare] ERROR ${input.owner}/${input.repo}#${input.number} head=${input.headSha.slice(0, 12)} total=${Date.now() - startedAt}ms ${formatCheckoutTrace(trace)} error=${String(error)}`,
          ),
        ),
        Effect.withSpan("PrCheckoutService.prepare", {
          attributes: {
            owner: input.owner,
            repo: input.repo,
            number: input.number,
            headSha: input.headSha,
            baseSha: input.baseSha,
            reviewMode: input.reviewMode,
          },
        }),
      );
    },
  }),
}) {}

export const PrCheckoutServiceLive = PrCheckoutService.Default;
