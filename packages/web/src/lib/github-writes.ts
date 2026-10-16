import {
  isGithubActor,
  isGithubPrScope,
  type GithubActor,
  type GithubOutboxCommand,
  type GithubOutboxReceipt,
  type GithubPrScope,
  type GithubWriteAction,
} from "@better-review/shared";

import { configureGithubEditorService } from "./github-editor-service";
import { createGithubOutbox } from "./github-outbox";
import { createIndexedDbGithubJournal } from "./github-outbox-journal";
import { trpc } from "./trpc";

const IDENTITY_KEY = "better-review-github-actor-v1";
let actor: GithubActor | undefined;
try {
  const value: unknown = JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? "null");
  if (isGithubActor(value)) actor = value;
} catch {
  /* Unknown identity blocks submission, never guesses by login. */
}

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

const admissions = new Map<string, Promise<GithubOutboxReceipt>>();
/** IndexedDB UUID order is not dependency order. Admit exact journal parents first. */
async function enqueueGithubCommand(
  command: GithubOutboxCommand,
  ancestors = new Set<string>(),
): Promise<GithubOutboxReceipt> {
  if (ancestors.has(command.operationId)) throw new Error("Cyclic local GitHub dependency");
  const previous = admissions.get(command.operationId);
  if (previous) return previous;
  const work = (async () => {
    const entries = await githubWrites.journal.entries(command.scope);
    const checked = new Set<string>();
    const verify = (item: GithubOutboxCommand, visiting: Set<string>) => {
      if (visiting.has(item.operationId)) throw new Error("Cyclic local GitHub dependency");
      if (checked.has(item.operationId)) return;
      const next = new Set([...visiting, item.operationId]);
      for (const id of item.dependencies) {
        const dependency = entries.find((entry) => entry.command.operationId === id);
        if (dependency && !dependency.backendOwned) verify(dependency.command, next);
      }
      checked.add(item.operationId);
    };
    verify(command, new Set());
    const path = new Set([...ancestors, command.operationId]);
    for (const id of command.dependencies) {
      const parent = entries.find((entry) => entry.command.operationId === id);
      if (!parent || parent.backendOwned) continue;
      if (parent.admissionError) throw new Error("Parent admission needs explicit attention");
      const receipt = await enqueueGithubCommand(parent.command, path);
      if (receipt.outcome === "rejected") {
        await githubWrites.journal.admissionFailed(id, receipt.error.message);
        throw new Error("Parent admission was rejected; dependent content remains local");
      }
      await githubWrites.journal.acknowledge(receipt.operation);
    }
    return trpc.githubOutbox.enqueue.mutate(command);
  })();
  admissions.set(command.operationId, work);
  try {
    return await work;
  } finally {
    if (admissions.get(command.operationId) === work) admissions.delete(command.operationId);
  }
}

export const githubJournal = createIndexedDbGithubJournal();
configureGithubEditorService(githubJournal, githubPrScope);
export const githubWrites = createGithubOutbox({
  journal: githubJournal,
  transport: {
    enqueue: (command) => enqueueGithubCommand(command),
    snapshot: (scope) => trpc.githubOutbox.snapshot.query(scope),
    control: (control) => trpc.githubOutbox.control.mutate(control),
    heartbeat: async (value) => {
      await trpc.githubOutbox.heartbeat.mutate(value);
    },
  },
});

export async function refreshGithubActor() {
  // A failed connection retains the previously known stable identity. A successful
  // unknown result clears it. Admission/dispatch still check backend/live identity.
  const result = await trpc.githubOutbox.identity.query();
  actor = result.actor ?? undefined;
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
