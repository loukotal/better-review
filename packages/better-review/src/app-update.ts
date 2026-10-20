import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import type { AppUpdateStatus } from "@better-review/shared";

const exec = promisify(execFile);
const CACHE_MS = 24 * 60 * 60_000;

/** Read remote refs without fetching, modifying the checkout, or prompting for credentials. */
export function createAppUpdateChecker(repoRoot: string, cacheMs = CACHE_MS) {
  const runGit = async (...args: string[]) => {
    try {
      const { stdout } = await exec("git", ["-C", repoRoot, ...args], {
        timeout: 8000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_LAZY_FETCH: "1",
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes -oConnectTimeout=5",
        },
      });
      return { stdout: stdout.trim(), code: 0 };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === 1) {
        return { stdout: "", code: 1 };
      }
      return null;
    }
  };
  const git = async (...args: string[]) => {
    const result = await runGit(...args);
    return result?.code === 0 ? result.stdout : null;
  };
  const isAncestor = async (ancestor: string, descendant: string) => {
    const result = await runGit("merge-base", "--is-ancestor", ancestor, descendant);
    return result ? result.code === 0 : null;
  };
  // Pin the running revision: pulling on disk alone does not update an already-running server.
  const running = Promise.all([
    git("symbolic-ref", "--quiet", "--short", "HEAD"),
    git("rev-parse", "HEAD"),
    git("rev-parse", "--show-toplevel"),
    realpath(repoRoot).catch(() => null),
  ]);
  let cached: { expiresAt: number; revision: string | undefined } | undefined;
  let inFlight: Promise<AppUpdateStatus> | undefined;

  const check = async (): Promise<AppUpdateStatus> => {
    const [runningBranch, currentRevision, gitRoot, expectedRoot] = await running;
    if (runningBranch !== "main" || !currentRevision || gitRoot !== expectedRoot || !expectedRoot) {
      return { updateAvailable: false };
    }
    const [checkoutBranch, checkoutRevision] = await Promise.all([
      git("symbolic-ref", "--quiet", "--short", "HEAD"),
      git("rev-parse", "HEAD"),
    ]);
    if (checkoutBranch !== "main" || !checkoutRevision) {
      return { updateAvailable: false };
    }
    // Cache only the network lookup. Local commits, pulls and branch switches must take
    // effect on the next check, even while the remote tip remains cached for a day.
    if (!cached || cached.expiresAt <= Date.now()) {
      const remote = await git("ls-remote", "--exit-code", "origin", "refs/heads/main");
      const revision = remote?.split(/\s+/)[0];
      cached = {
        revision: revision && /^[a-f0-9]{40,64}$/.test(revision) ? revision : undefined,
        expiresAt: Date.now() + cacheMs,
      };
    }
    const latestRevision = cached.revision;
    if (!latestRevision) {
      return { updateAvailable: false };
    }
    const status = { currentRevision, latestRevision, checkoutRevision };
    // Local-only commits in the running version are not an upstream update.
    if (
      latestRevision === currentRevision ||
      (await isAncestor(latestRevision, currentRevision)) === true
    ) {
      return { ...status, updateAvailable: false };
    }
    const remoteIncluded =
      latestRevision === checkoutRevision || (await isAncestor(latestRevision, checkoutRevision));
    if (remoteIncluded === true) {
      return { ...status, updateAvailable: true, updateAction: "restart" };
    }
    const checkoutIncluded = await isAncestor(checkoutRevision, latestRevision);
    if (checkoutIncluded === true) {
      return { ...status, updateAvailable: true, updateAction: "fast-forward" };
    }
    const completeHistory = (await git("rev-parse", "--is-shallow-repository")) === "false";
    return {
      ...status,
      updateAvailable: true,
      updateAction:
        checkoutIncluded === false && remoteIncluded === false && completeHistory
          ? "diverged"
          : "unknown",
    };
  };

  // Startup and incoming UI requests share this cache; there is no scheduled refresh loop.
  return (): Promise<AppUpdateStatus> => {
    if (inFlight) return inFlight;
    inFlight = check().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
