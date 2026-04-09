import { Effect, Layer, ServiceMap } from "effect";

import type {
  ReviewSession,
  ReviewSessionResult,
  ReviewSessionStatus,
} from "@better-review/shared";

import { StoreService, StoreServiceLive } from "./store";

const REVIEW_SESSIONS_NAMESPACE = "review-sessions";
const REVIEW_SESSION_RESULTS_NAMESPACE = "review-session-results";

function deriveStatusFromResult(result: ReviewSessionResult): ReviewSessionStatus {
  return result.approved ? "approved" : "feedback";
}

const makeReviewSessionService = Effect.gen(function* () {
  const store = yield* StoreService;

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

    submitResult: (
      sessionId: string,
      input: Omit<ReviewSessionResult, "sessionId" | "submittedAt"> & { submittedAt?: number },
    ) =>
      Effect.gen(function* () {
        const session = yield* store.get<ReviewSession>(REVIEW_SESSIONS_NAMESPACE, sessionId);
        if (!session) {
          return yield* Effect.fail(new Error(`Review session not found: ${sessionId}`));
        }

        const result: ReviewSessionResult = {
          ...input,
          sessionId,
          submittedAt: input.submittedAt ?? Date.now(),
        };

        const updatedSession: ReviewSession = {
          ...session,
          status: deriveStatusFromResult(result),
        };

        yield* store.set(REVIEW_SESSION_RESULTS_NAMESPACE, sessionId, result);
        yield* store.set(REVIEW_SESSIONS_NAMESPACE, sessionId, updatedSession);

        return result;
      }),

    getResult: (sessionId: string) =>
      store.get<ReviewSessionResult>(REVIEW_SESSION_RESULTS_NAMESPACE, sessionId),
  };
});

type SuccessOf<T> = T extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;

type ReviewSessionServiceApi = SuccessOf<typeof makeReviewSessionService>;

export class ReviewSessionService extends ServiceMap.Service<
  ReviewSessionService,
  ReviewSessionServiceApi
>()("ReviewSessionService", {
  make: makeReviewSessionService,
}) {}

export const ReviewSessionServiceLive = Layer.effect(
  ReviewSessionService,
  makeReviewSessionService,
).pipe(Layer.provide(StoreServiceLive));
