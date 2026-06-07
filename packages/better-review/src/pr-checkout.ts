import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Data, Effect } from "effect";

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
}

const CHECKOUT_TIMEOUT_MS = Number(process.env.BETTER_REVIEW_CHECKOUT_TIMEOUT_MS ?? 120_000);

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

async function runRequired(command: string, args: string[], cwd?: string): Promise<string> {
  const result = await runCommand(command, args, { cwd, timeoutMs: CHECKOUT_TIMEOUT_MS });
  if (result.timedOut) {
    throw new Error(`${command} ${args.join(" ")} timed out after ${CHECKOUT_TIMEOUT_MS}ms`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function ensureBareRepo(owner: string, repo: string, repoGitDir: string): Promise<void> {
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

  await runRequired("git", [
    "-C",
    repoGitDir,
    "remote",
    "set-url",
    "origin",
    `https://github.com/${owner}/${repo}.git`,
  ]);
  await runRequired("git", ["-C", repoGitDir, "config", "remote.origin.promisor", "true"]);
  await runRequired("git", [
    "-C",
    repoGitDir,
    "config",
    "remote.origin.partialclonefilter",
    "blob:none",
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

function localPrBranchName(input: PreparePrCheckoutInput): string {
  return safePathPart(`pr-${input.number}-${input.headRef}-${input.headSha.slice(0, 12)}`);
}

async function ensureBaseRef(repoGitDir: string, input: PreparePrCheckoutInput): Promise<void> {
  await runRequired("git", [
    "-C",
    repoGitDir,
    "fetch",
    "--no-tags",
    "--filter=blob:none",
    "--depth=1",
    "origin",
    `refs/heads/${input.baseRef}:refs/remotes/origin/${input.baseRef}`,
  ]);

  // Also materialize a local branch name (e.g. `develop`) so common commands like
  // `git merge-base develop HEAD` work inside the worktree. Force it to the fetched
  // remote base to avoid stale local base refs in the bare cache.
  await runRequired("git", [
    "-C",
    repoGitDir,
    "update-ref",
    `refs/heads/${input.baseRef}`,
    `refs/remotes/origin/${input.baseRef}`,
  ]);
}

async function writePrContext(input: PreparePrCheckoutInput, worktreePath: string): Promise<void> {
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
      "Use this checkout as the source of truth. Prefer code navigation, tests, and git commands over judging only a patch.",
      `Do not review files outside the canonical PR diff unless the user explicitly asks for broader context.`,
    ].join("\n"),
  );
}

export class PrCheckoutService extends Effect.Service<PrCheckoutService>()("PrCheckoutService", {
  effect: Effect.succeed({
    prepare: (input: PreparePrCheckoutInput): Effect.Effect<PreparedPrCheckout, CheckoutError> =>
      Effect.tryPromise({
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

          await ensureBareRepo(input.owner, input.repo, repoGitDir);
          await ensureBaseRef(repoGitDir, input);

          const currentHead = await getWorktreeHead(worktreePath);
          if (currentHead === input.headSha) {
            await writePrContext(input, worktreePath);
            return { worktreePath };
          }

          const localBranch = localPrBranchName(input);
          await runRequired("git", [
            "-C",
            repoGitDir,
            "fetch",
            "--no-tags",
            "--filter=blob:none",
            "--depth=1",
            "origin",
            `refs/pull/${input.number}/head:refs/heads/${localBranch}`,
          ]);
          await runRequired("git", [
            "-C",
            repoGitDir,
            "rev-parse",
            "--verify",
            `${input.headSha}^{commit}`,
          ]);
          await mkdir(join(worktreePath, ".."), { recursive: true });
          await runRequired("git", [
            "-C",
            repoGitDir,
            "worktree",
            "add",
            worktreePath,
            localBranch,
          ]);
          await writePrContext(input, worktreePath);

          return { worktreePath };
        },
        catch: (cause) => new CheckoutError({ command: "preparePrCheckout", cause }),
      }),
  }),
}) {}

export const PrCheckoutServiceLive = PrCheckoutService.Default;
