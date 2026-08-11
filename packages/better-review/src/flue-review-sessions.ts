import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import type { RepoAccessCheck } from "./pr-checkout";
import { STORE_BASE_DIR, StoreService, StoreServiceLive } from "./store";

export const FLUE_REVIEW_SESSIONS_NAMESPACE = "flue-review-sessions";

export interface FlueReviewSession {
  runtimeVersion: 2;
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
    throw new Error(`Invalid Flue review session id: ${id}`);
  }
  return id;
}

export async function readFlueReviewSession(id: string): Promise<FlueReviewSession | null> {
  const safeId = validateSessionId(id);
  const filePath = join(STORE_BASE_DIR, FLUE_REVIEW_SESSIONS_NAMESPACE, `${safeId}.json`);

  try {
    return JSON.parse(await readFile(filePath, "utf8")) as FlueReviewSession;
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function readFlueReviewSessionSync(id: string): FlueReviewSession | null {
  const safeId = validateSessionId(id);
  const filePath = join(STORE_BASE_DIR, FLUE_REVIEW_SESSIONS_NAMESPACE, `${safeId}.json`);

  try {
    const session = JSON.parse(readFileSync(filePath, "utf8")) as Partial<FlueReviewSession>;
    return session.runtimeVersion === 2 ? (session as FlueReviewSession) : null;
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function isFlueV2ReviewSession(
  session: FlueReviewSession | null | undefined,
): session is FlueReviewSession {
  return session?.runtimeVersion === 2;
}

export class FlueReviewSessionService extends Effect.Service<FlueReviewSessionService>()(
  "FlueReviewSessionService",
  {
    effect: Effect.gen(function* () {
      const store = yield* StoreService;

      const get = (id: string) =>
        store.get<FlueReviewSession>(FLUE_REVIEW_SESSIONS_NAMESPACE, validateSessionId(id));

      const save = (session: FlueReviewSession) =>
        store.set(FLUE_REVIEW_SESSIONS_NAMESPACE, validateSessionId(session.id), {
          ...session,
          updatedAt: Date.now(),
        });

      const create = (
        input: Omit<FlueReviewSession, "createdAt" | "updatedAt"> & {
          createdAt?: number;
          updatedAt?: number;
        },
      ) => {
        const now = Date.now();
        const session: FlueReviewSession = {
          ...input,
          id: validateSessionId(input.id),
          createdAt: input.createdAt ?? now,
          updatedAt: input.updatedAt ?? now,
        };

        return store
          .set(FLUE_REVIEW_SESSIONS_NAMESPACE, session.id, session)
          .pipe(Effect.as(session));
      };

      return { get, save, create };
    }),
  },
) {}

export const FlueReviewSessionServiceLive = FlueReviewSessionService.Default.pipe(
  Layer.provide(StoreServiceLive),
);
