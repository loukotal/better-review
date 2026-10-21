import { createSignal } from "solid-js";

import {
  isGithubActor,
  isGithubPrScope,
  type GithubActor,
  type GithubPrScope,
  type GithubWriteAction,
} from "@better-review/shared";

import { configureGithubEditorService } from "./github-editor-service";
import { createGithubOutbox } from "./github-outbox";
import { createIndexedDbGithubJournal } from "./github-outbox-journal";
import { getGithubSyncTimeoutMs } from "./github-queue-settings";
import { trpc } from "./trpc";

const IDENTITY_KEY = "better-review-github-actor-v1";
let actor: GithubActor | undefined;
try {
  const value: unknown = JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? "null");
  if (isGithubActor(value)) actor = value;
} catch {
  /* Unknown identity blocks submission, never guesses by login. */
}

const [currentGithubActor, setCurrentGithubActor] = createSignal(actor);
export { currentGithubActor };

export function githubPrScope(url: string): GithubPrScope {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || !match)
    throw new Error("Invalid GitHub PR URL");
  const owner = match[1]!.toLowerCase(),
    repo = match[2]!.toLowerCase(),
    number = Number(match[3]);
  const scope: GithubPrScope = {
    host: "github.com",
    owner,
    repo,
    number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
  if (!isGithubPrScope(scope)) throw new Error("Invalid GitHub PR scope");
  return scope;
}

export const githubJournal = createIndexedDbGithubJournal();
export const githubWrites = createGithubOutbox({
  journal: githubJournal,
  now: () => Date.now(),
  transport: {
    enqueue: (command, cycle) =>
      trpc.githubOutbox.enqueue.mutate(cycle ? { command, cycle } : command),
    snapshot: (scope) => trpc.githubOutbox.snapshot.query(scope),
    listPending: () => trpc.githubOutbox.pending.query(),
    control: (control) => trpc.githubOutbox.control.mutate(control),
    batchControl: (control) => trpc.githubOutbox.batchControl.mutate(control),
    heartbeat: async (value) => {
      await trpc.githubOutbox.heartbeat.mutate(value);
    },
  },
});
githubWrites.setQueueTimeoutMs(getGithubSyncTimeoutMs());
configureGithubEditorService(githubJournal, githubPrScope, githubWrites.beginSaving);

export async function refreshGithubActor() {
  // A failed connection retains the previously known stable identity. A successful
  // unknown result clears it. Admission/dispatch still check backend/live identity.
  const result = await trpc.githubOutbox.identity.query();
  actor = result.actor ?? undefined;
  setCurrentGithubActor(actor);
  try {
    if (actor) localStorage.setItem(IDENTITY_KEY, JSON.stringify(actor));
    else localStorage.removeItem(IDENTITY_KEY);
  } catch {
    /* Current-session identity remains usable without localStorage. */
  }
}

/** Resolves after IndexedDB commit, not GitHub HTTP. Never returns a fabricated remote comment. */
export function queueGithubWrite(
  url: string,
  action: GithubWriteAction,
  draftKey?: string,
  dependencies?: string[],
) {
  githubWrites.setQueueTimeoutMs(getGithubSyncTimeoutMs());
  if (!actor)
    return Promise.reject(
      new Error(
        "GitHub account is not known yet. Run gh auth login for github.com, then check your account and save again. Your editor draft is retained; this write has not been queued.",
      ),
    );
  return githubWrites.submit({
    scope: githubPrScope(url),
    actor,
    action,
    draftKey,
    dependencies: dependencies
      ? [
          ...new Set([
            ...dependencies,
            ...("target" in action && action.target.source === "local"
              ? [action.target.operationId]
              : []),
          ]),
        ]
      : undefined,
  });
}
