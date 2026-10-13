import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import type { AppUpdateStatus } from "@better-review/shared";

const exec = promisify(execFile);
const CACHE_MS = 24 * 60 * 60_000;

/** Read remote refs without fetching, modifying the checkout, or prompting for credentials. */
export function createAppUpdateChecker(repoRoot: string, cacheMs = CACHE_MS) {
  const git = async (...args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await exec("git", ["-C", repoRoot, ...args], {
        timeout: 8000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes -oConnectTimeout=5",
        },
      });
      return stdout.trim();
    } catch {
      return null;
    }
  };
  // Pin the running revision: pulling on disk alone does not update an already-running server.
  const running = Promise.all([
    git("symbolic-ref", "--quiet", "--short", "HEAD"),
    git("rev-parse", "HEAD"),
    git("rev-parse", "--show-toplevel"),
    realpath(repoRoot).catch(() => null),
  ]);
  let cached: { expiresAt: number; value: AppUpdateStatus } | undefined;
  let inFlight: Promise<AppUpdateStatus> | undefined;

  const check = async (): Promise<AppUpdateStatus> => {
    const [runningBranch, currentRevision, gitRoot, expectedRoot] = await running;
    if (runningBranch !== "main" || !currentRevision || gitRoot !== expectedRoot || !expectedRoot) {
      return { updateAvailable: false };
    }
    if ((await git("symbolic-ref", "--quiet", "--short", "HEAD")) !== "main") {
      return { updateAvailable: false };
    }
    const remote = await git("ls-remote", "--exit-code", "origin", "refs/heads/main");
    const latestRevision = remote?.split(/\s+/)[0];
    if (!latestRevision || !/^[a-f0-9]{40,64}$/.test(latestRevision)) {
      return { updateAvailable: false };
    }
    // Local-only commits are not an available upstream update. Unknown remote objects are
    // intentionally not fetched: a different advertised tip is enough to offer a manual update.
    const alreadyIncluded =
      latestRevision === currentRevision ||
      (await git("merge-base", "--is-ancestor", latestRevision, currentRevision)) !== null;
    return { updateAvailable: !alreadyIncluded, currentRevision, latestRevision };
  };

  // Startup and incoming UI requests share this cache; there is no scheduled refresh loop.
  return (): Promise<AppUpdateStatus> => {
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
    if (inFlight) return inFlight;
    inFlight = check()
      .then((value) => {
        cached = { value, expiresAt: Date.now() + cacheMs };
        return value;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}
