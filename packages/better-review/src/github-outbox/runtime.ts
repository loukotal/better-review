import path from "node:path";

import { TRPCError } from "@trpc/server";

import type { GithubActor, GithubOutboxError } from "@better-review/shared";

import { STORE_BASE_DIR } from "../store";
import { createGithubOutbox } from "./outbox";
import type { GithubOutboxAdapter } from "./types";

/** Cached identity is populated asynchronously, never by the admission request. */
export async function createGithubOutboxRuntime(options: {
  databasePath: string;
  adapter: GithubOutboxAdapter;
  identityRefreshMs?: number;
}) {
  let actor: GithubActor | undefined;
  let identityError: GithubOutboxError | undefined;
  let closed = false;
  let refreshing: Promise<void> | undefined;
  const refreshIdentity = () =>
    (refreshing ??= (async () => {
      try {
        const identity = await options.adapter.identity();
        if (!closed) {
          actor = identity.outcome === "known" ? identity.actor : undefined;
          // Distinguish startup/transient unknown from an actual permanent auth
          // failure. Otherwise the browser would retry a logged-out account forever.
          const transient =
            identity.outcome !== "known" &&
            identity.error.retryable &&
            ["identity-unknown", "network", "unavailable", "rate-limit"].includes(
              identity.error.code,
            );
          const retryAt =
            identity.outcome !== "known" && identity.error.retryAt
              ? Date.parse(identity.error.retryAt)
              : NaN;
          identityError =
            identity.outcome === "known"
              ? undefined
              : {
                  code: transient ? "identity-unknown" : identity.error.code,
                  retryable: transient,
                  ...(Number.isFinite(retryAt) ? { retryAt: new Date(retryAt).toISOString() } : {}),
                  message: transient
                    ? "GitHub account verification is temporarily unavailable; saved work will retry."
                    : "GitHub account verification failed. Check gh auth status and sign in, then retry the saved operation.",
                };
        }
      } catch {
        if (!closed) {
          actor = undefined;
          identityError = {
            code: "identity-unknown",
            retryable: true,
            message:
              "GitHub account verification is temporarily unavailable; saved work will retry.",
          };
        }
      }
    })().finally(() => {
      refreshing = undefined;
    }));
  const outbox = await createGithubOutbox({
    databasePath: options.databasePath,
    adapter: options.adapter,
    getCachedActor: () => actor,
    getCachedIdentityError: () => identityError,
  });
  void refreshIdentity();
  const timer = setInterval(() => {
    void refreshIdentity();
  }, options.identityRefreshMs ?? 60_000);
  timer.unref();
  return {
    outbox,
    actor: () => actor ?? null,
    refreshIdentity,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await outbox.close();
    },
  };
}

let current: Awaited<ReturnType<typeof createGithubOutboxRuntime>> | undefined;
export function getGithubOutboxRuntime() {
  if (!current)
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "GitHub outbox is not running" });
  return current;
}
export async function startGithubOutboxRuntime(adapter: GithubOutboxAdapter) {
  if (current) return;
  current = await createGithubOutboxRuntime({
    databasePath:
      process.env.BETTER_REVIEW_GITHUB_OUTBOX_DATABASE ??
      path.join(STORE_BASE_DIR, "github-outbox", "outbox.sqlite"),
    adapter,
  });
}
export async function stopGithubOutboxRuntime() {
  const instance = current;
  current = undefined;
  await instance?.close();
}
