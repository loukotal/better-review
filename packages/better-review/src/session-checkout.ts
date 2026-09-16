import { Effect } from "effect";

import { FlueReviewSessionService, isFlueV2ReviewSession } from "./flue-review-sessions";
import { PrCheckoutService } from "./pr-checkout";
import { getErrorMessage } from "./response";
import { runtime } from "./runtime";

// Checkouts are prepared after the session is returned, so opening a PR does not wait on
// git fetches. Anything that runs the reviewer must wait for its session's checkout first.
const pendingCheckouts = new Map<string, Promise<void>>();
const checkoutErrors = new Map<string, string>();

const MAX_ERROR_LENGTH = 300;

export function checkoutErrorMessage(error: unknown): string {
  const message = getErrorMessage(error).trim();
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

export type SessionCheckoutStatus =
  | { state: "preparing" }
  | { state: "ready" }
  | { state: "failed"; error: string };

export function prepareSessionCheckout(sessionId: string): Promise<void> {
  const pending = pendingCheckouts.get(sessionId);
  if (pending) return pending;
  checkoutErrors.delete(sessionId);

  const task = runtime
    .runPromise(
      Effect.gen(function* () {
        const store = yield* FlueReviewSessionService;
        const checkout = yield* PrCheckoutService;
        const session = yield* store.get(sessionId);
        if (!isFlueV2ReviewSession(session)) {
          return yield* Effect.fail(new Error(`Review session not found: ${sessionId}`));
        }

        const prepared = yield* checkout.prepare({
          owner: session.owner,
          repo: session.repo,
          number: session.number,
          prUrl: session.prUrl,
          baseSha: session.baseSha,
          headSha: session.headSha,
          baseRef: session.baseRef ?? "",
          headRef: session.headRef ?? "",
          reviewMode: session.reviewMode,
          commitSha: session.commitSha,
          files: session.files,
        });

        // Re-read so session updates made during the checkout, such as automatic review
        // metadata, are not overwritten.
        const latest = (yield* store.get(sessionId)) ?? session;
        yield* store.save({
          ...latest,
          worktreePath: prepared.worktreePath,
          repoAccess: prepared.repoAccess,
        });
      }),
    )
    .catch((error: unknown) => {
      checkoutErrors.set(sessionId, checkoutErrorMessage(error));
      throw error;
    })
    .finally(() => {
      pendingCheckouts.delete(sessionId);
    });

  pendingCheckouts.set(sessionId, task);
  return task;
}

/** Starts the checkout without waiting; failures are retried by `ensureSessionCheckout`. */
export function prepareSessionCheckoutInBackground(sessionId: string): void {
  prepareSessionCheckout(sessionId).catch((error) => {
    console.error(
      `[session-checkout] Failed to prepare checkout for ${sessionId}: ${getErrorMessage(error)}`,
    );
  });
}

export async function getSessionCheckoutStatus(sessionId: string): Promise<SessionCheckoutStatus> {
  if (pendingCheckouts.has(sessionId)) return { state: "preparing" };

  const session = await runtime.runPromise(
    Effect.flatMap(FlueReviewSessionService, (store) => store.get(sessionId)),
  );
  if (!isFlueV2ReviewSession(session)) return { state: "failed", error: "Session not found" };
  // A failed refresh leaves the earlier checkout usable, matching ensureSessionCheckout.
  if (session.repoAccess) return { state: "ready" };

  const error = checkoutErrors.get(sessionId);
  if (error) return { state: "failed", error };

  // Nothing is running for this session (for example after a server restart), so start it.
  prepareSessionCheckoutInBackground(sessionId);
  return { state: "preparing" };
}

export async function ensureSessionCheckout(sessionId: string): Promise<void> {
  const pending = pendingCheckouts.get(sessionId);
  if (pending) return pending;

  const session = await runtime.runPromise(
    Effect.flatMap(FlueReviewSessionService, (store) => store.get(sessionId)),
  );
  // A missing access record means the checkout failed or the server restarted mid-way.
  if (isFlueV2ReviewSession(session) && !session.repoAccess) {
    await prepareSessionCheckout(sessionId);
  }
}
