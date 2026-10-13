import { Effect, Layer } from "effect";

import type {
  ReviewSession,
  ReviewSessionResult,
  ReviewSessionStatus,
} from "@better-review/shared";

import { StoreService, StoreServiceLive } from "./store";

const REVIEW_SESSIONS_NAMESPACE = "review-sessions";
const REVIEW_SESSION_RESULTS_NAMESPACE = "review-session-results";
const REVIEW_SESSION_PRESENCE_NAMESPACE = "review-session-presence";
const HEARTBEAT_TIMEOUT_MS = 90_000;
const CLOSE_GRACE_MS = 10_000;

interface ReviewPresence {
  viewers: Record<string, number>;
}

function deriveStatusFromResult(result: ReviewSessionResult): ReviewSessionStatus {
  if (result.cancelled) return "cancelled";
  return result.approved ? "approved" : "feedback";
}

export const makeReviewSessionService = Effect.gen(function* () {
  const store = yield* StoreService;
  // Serialize verdicts, expiry, and presence updates so cancellation cannot overwrite a verdict.
  const lock = yield* Effect.makeSemaphore(1);

  const saveResult = (session: ReviewSession, result: ReviewSessionResult) =>
    Effect.gen(function* () {
      yield* store.set(REVIEW_SESSION_RESULTS_NAMESPACE, session.id, result);
      yield* store.set(REVIEW_SESSIONS_NAMESPACE, session.id, {
        ...session,
        status: deriveStatusFromResult(result),
      });
      yield* store.delete(REVIEW_SESSION_PRESENCE_NAMESPACE, session.id);
      return result;
    });

  return {
    createSession: (
      input: Omit<ReviewSession, "id" | "createdAt" | "status"> & {
        id?: string;
        createdAt?: number;
      },
    ) =>
      Effect.gen(function* () {
        const session: ReviewSession = {
          ...input,
          id: input.id ?? crypto.randomUUID(),
          createdAt: input.createdAt ?? Date.now(),
          status: "pending",
        };

        yield* store.set(REVIEW_SESSIONS_NAMESPACE, session.id, session);
        return session;
      }),

    getSession: (sessionId: string) =>
      store.get<ReviewSession>(REVIEW_SESSIONS_NAMESPACE, sessionId),

    listSessions: (scope?: string) =>
      Effect.gen(function* () {
        const sessionIds = yield* store.list(REVIEW_SESSIONS_NAMESPACE);
        const sessions = yield* Effect.forEach(sessionIds, (sessionId) =>
          store.get<ReviewSession>(REVIEW_SESSIONS_NAMESPACE, sessionId),
        );

        return sessions
          .filter(
            (session): session is ReviewSession =>
              session !== null && (!scope || (session.repoRoot ?? session.cwd) === scope),
          )
          .toSorted((a, b) => b.createdAt - a.createdAt);
      }),

    submitResult: (
      sessionId: string,
      input: Omit<ReviewSessionResult, "sessionId" | "submittedAt"> & { submittedAt?: number },
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const session = yield* store.get<ReviewSession>(REVIEW_SESSIONS_NAMESPACE, sessionId);
          if (!session) {
            return yield* Effect.fail(new Error(`Review session not found: ${sessionId}`));
          }
          if (
            session.status !== "pending" ||
            (yield* store.get(REVIEW_SESSION_RESULTS_NAMESPACE, sessionId))
          ) {
            return yield* Effect.fail(new Error("Review session already completed"));
          }

          const result: ReviewSessionResult = {
            ...input,
            sessionId,
            submittedAt: input.submittedAt ?? Date.now(),
          };

          return yield* saveResult(session, result);
        }),
      ),

    updatePresence: (sessionId: string, viewerId: string, active: boolean) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const session = yield* store.get<ReviewSession>(REVIEW_SESSIONS_NAMESPACE, sessionId);
          if (!session)
            return yield* Effect.fail(new Error(`Review session not found: ${sessionId}`));
          if (session.status !== "pending") return;
          const presence = (yield* store.get<ReviewPresence>(
            REVIEW_SESSION_PRESENCE_NAMESPACE,
            sessionId,
          )) ?? { viewers: {} };
          // An unobserved close must not start an expiry timer for a session never opened.
          if (!active && presence.viewers[viewerId] === undefined) return;
          const now = Date.now();
          const viewers = Object.fromEntries(
            Object.entries(presence.viewers).filter(([, expiry]) => expiry > now),
          );
          viewers[viewerId] = now + (active ? HEARTBEAT_TIMEOUT_MS : CLOSE_GRACE_MS);
          yield* store.set(REVIEW_SESSION_PRESENCE_NAMESPACE, sessionId, { viewers });
        }),
      ),

    getResult: (sessionId: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const result = yield* store.get<ReviewSessionResult>(
            REVIEW_SESSION_RESULTS_NAMESPACE,
            sessionId,
          );
          if (result) return result;
          const presence = yield* store.get<ReviewPresence>(
            REVIEW_SESSION_PRESENCE_NAMESPACE,
            sessionId,
          );
          if (!presence || Object.values(presence.viewers).some((expiry) => expiry > Date.now()))
            return null;
          const session = yield* store.get<ReviewSession>(REVIEW_SESSIONS_NAMESPACE, sessionId);
          if (!session || session.status !== "pending") return null;
          return yield* saveResult(session, {
            sessionId,
            mode: session.mode,
            approved: false,
            cancelled: true,
            feedback:
              "Review cancelled: the review tab was closed or disconnected before a verdict was submitted. This is not approval; request another review if needed.",
            annotations: [],
            submittedAt: Date.now(),
          });
        }),
      ),
  };
});

export class ReviewSessionService extends Effect.Service<ReviewSessionService>()(
  "ReviewSessionService",
  {
    effect: makeReviewSessionService,
  },
) {}

export const ReviewSessionServiceLive = ReviewSessionService.Default.pipe(
  Layer.provide(StoreServiceLive),
);
