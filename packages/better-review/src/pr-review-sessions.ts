import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Context, Effect, Layer } from "effect";

import type { ReviewModelIntent } from "@better-review/shared";

import type { RepoAccessCheck } from "./pr-checkout";
import { STORE_BASE_DIR, StoreService, StoreServiceLive } from "./store";

export const PR_REVIEW_SESSIONS_NAMESPACE = "pr-review-sessions";
const LEGACY_NAMESPACE = "flue-review-sessions";

export interface PrReviewSession {
  runtimeVersion: 2 | 3;
  automaticReview?: {
    idempotencyKey: string;
    prompt?: string;
    submissionId?: string;
    model?: ReviewModelIntent;
  };
  revisionHistory?: Array<{
    headSha: string;
    baseSha: string;
    commitSha: string | null;
    pulledAt: number;
  }>;
  id: string;
  prUrl: string;
  owner: string;
  repo: string;
  number: number;
  baseSha: string;
  headSha: string;
  baseRef?: string;
  headRef?: string;
  reviewMode: "full" | "commit";
  commitSha: string | null;
  worktreePath: string;
  repoAccess?: RepoAccessCheck;
  files: string[];
  createdAt: number;
  updatedAt: number;
}

function validateSessionId(id: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(id) || id.includes("..")) {
    throw new Error(`Invalid review session id: ${id}`);
  }
  return id;
}

export async function readPrReviewSession(id: string): Promise<PrReviewSession | null> {
  const safeId = validateSessionId(id);
  for (const namespace of [PR_REVIEW_SESSIONS_NAMESPACE, LEGACY_NAMESPACE]) {
    try {
      const value = JSON.parse(
        await readFile(join(STORE_BASE_DIR, namespace, `${safeId}.json`), "utf8"),
      );
      return isPrReviewSession(value) ? value : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

export function isPrReviewSession(
  session: PrReviewSession | null | undefined,
): session is PrReviewSession {
  return session?.runtimeVersion === 2 || session?.runtimeVersion === 3;
}

const makePrReviewSessionService = Effect.gen(function* () {
  const store = yield* StoreService;

  const get = (id: string) =>
    Effect.gen(function* () {
      const key = validateSessionId(id);
      return (
        (yield* store.get<PrReviewSession>(PR_REVIEW_SESSIONS_NAMESPACE, key)) ??
        (yield* store.get<PrReviewSession>(LEGACY_NAMESPACE, key))
      );
    });

  const save = (session: PrReviewSession) =>
    store.set(PR_REVIEW_SESSIONS_NAMESPACE, validateSessionId(session.id), {
      ...session,
      updatedAt: Date.now(),
    });

  const create = (
    input: Omit<PrReviewSession, "createdAt" | "updatedAt"> & {
      createdAt?: number;
      updatedAt?: number;
    },
  ) => {
    const now = Date.now();
    const session: PrReviewSession = {
      ...input,
      id: validateSessionId(input.id),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };

    return store.set(PR_REVIEW_SESSIONS_NAMESPACE, session.id, session).pipe(Effect.as(session));
  };

  return { get, save, create };
});

export type PrReviewSessionService = Effect.Success<typeof makePrReviewSessionService>;
export const PrReviewSessionService = Context.Service<PrReviewSessionService>(
  "better-review/PrReviewSessionService",
);
export const PrReviewSessionServiceLive = Layer.effect(
  PrReviewSessionService,
  makePrReviewSessionService,
).pipe(Layer.provide(StoreServiceLive));
