// =============================================================================
// State Services - DiffCache and PrContext with Effect.Ref
// =============================================================================

import { Effect, Ref } from "effect";
import { type FileDiffMeta, parseFullDiff } from "./diff";
import { GhService, GhServiceLive } from "./gh/gh";
import { StoreService } from "./store";

// =============================================================================
// Types
// =============================================================================

export interface PrInfo {
  owner: string;
  repo: string;
  number: string;
}

export interface PrContext {
  prUrl: string | null;
  files: string[];
  info: PrInfo | null;
}

export interface StoredSession {
  id: string; // OpenCode session ID
  headSha: string; // Git SHA at creation
  createdAt: number; // Unix timestamp ms
  hidden: boolean;
}

export interface PrSessionData {
  owner: string;
  repo: string;
  number: number;
  url: string;
  sessions: StoredSession[];
  activeSessionId: string | null;
}

// =============================================================================
// Helpers
// =============================================================================

function parsePrUrl(
  url: string,
): { owner: string; repo: string; number: number } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    number: parseInt(match[3], 10),
  };
}

function prUrlToKey(url: string): string | null {
  const pr = parsePrUrl(url);
  if (!pr) return null;
  return `${pr.owner}_${pr.repo}_${pr.number}`;
}

// =============================================================================
// DiffCacheService
// =============================================================================

export class DiffCacheService extends Effect.Service<DiffCacheService>()(
  "DiffCacheService",
  {
    scoped: Effect.gen(function* () {
      // Ref holding: prUrl -> Map<fileName, FileDiffMeta>
      const cache = yield* Ref.make(
        new Map<string, Map<string, FileDiffMeta>>(),
      );

      // Capture GhService at construction time
      const gh = yield* GhService;

      return {
        /**
         * Get cached diffs for a PR, or fetch and cache them
         */
        getOrFetch: (prUrl: string) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(cache);
            const existing = current.get(prUrl);
            if (existing) {
              yield* Effect.log(
                `[cache] Using cached diffs for ${prUrl} (${existing.size} files)`,
              );
              return existing;
            }

            // Fetch using GhService (captured at construction)
            yield* Effect.log(`[cache] Fetching full diff for ${prUrl}...`);
            const fullDiff = yield* gh.getDiff(prUrl);
            yield* Effect.log(
              `[cache] Full diff fetched (${fullDiff.length} chars)`,
            );

            const fileDiffs = parseFullDiff(fullDiff);
            yield* Effect.log(`[cache] Cached ${fileDiffs.size} file diffs`);

            yield* Ref.update(cache, (m) => {
              const newMap = new Map(m);
              newMap.set(prUrl, fileDiffs);
              return newMap;
            });

            return fileDiffs;
          }),

        /**
         * Get cached diffs without fetching (returns undefined if not cached)
         */
        get: (prUrl: string) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(cache);
            return current.get(prUrl);
          }),

        /**
         * Clear cache for a specific PR
         */
        clear: (prUrl: string) =>
          Ref.update(cache, (m) => {
            const newMap = new Map(m);
            newMap.delete(prUrl);
            return newMap;
          }),

        /**
         * Clear all cached diffs
         */
        clearAll: Ref.set(cache, new Map()),
      };
    }),
    dependencies: [GhServiceLive],
  },
) {}

// =============================================================================
// PrContextService
// =============================================================================

const SESSIONS_NAMESPACE = "prs";

export class PrContextService extends Effect.Service<PrContextService>()(
  "PrContextService",
  {
    scoped: Effect.gen(function* () {
      // Current PR context (runtime only)
      const context = yield* Ref.make<PrContext>({
        prUrl: null,
        files: [],
        info: null,
      });

      // Get store service for persistence
      const store = yield* StoreService;

      return {
        // =====================================================================
        // Runtime Context (unchanged)
        // =====================================================================

        /**
         * Set the current PR context
         */
        setCurrent: (prUrl: string, files: string[], info: PrInfo) =>
          Ref.set(context, { prUrl, files, info }),

        /**
         * Get the current PR context
         */
        getCurrent: Ref.get(context),

        // =====================================================================
        // Session Management (persisted via StoreService)
        // =====================================================================

        /**
         * Get all session data for a PR
         */
        getSessionData: (prUrl: string) =>
          Effect.gen(function* () {
            const key = prUrlToKey(prUrl);
            if (!key) return null;
            return yield* store.get<PrSessionData>(SESSIONS_NAMESPACE, key);
          }),

        /**
         * List sessions for a PR (optionally include hidden)
         */
        listSessions: (prUrl: string, includeHidden = false) =>
          Effect.gen(function* () {
            const key = prUrlToKey(prUrl);
            if (!key) {
              return { sessions: [], activeSessionId: null };
            }

            const data = yield* store.get<PrSessionData>(
              SESSIONS_NAMESPACE,
              key,
            );
            if (!data) {
              return { sessions: [], activeSessionId: null };
            }

            const sessions = includeHidden
              ? data.sessions
              : data.sessions.filter((s) => !s.hidden);

            return {
              sessions,
              activeSessionId: data.activeSessionId,
            };
          }),

        /**
         * Add a new session to a PR
         */
        addSession: (prUrl: string, sessionId: string, headSha: string) =>
          Effect.gen(function* () {
            const pr = parsePrUrl(prUrl);
            const key = prUrlToKey(prUrl);
            if (!pr || !key) {
              return yield* Effect.fail(new Error(`Invalid PR URL: ${prUrl}`));
            }

            // Get existing data or create new
            const existing = yield* store.get<PrSessionData>(
              SESSIONS_NAMESPACE,
              key,
            );
            const data: PrSessionData = existing || {
              owner: pr.owner,
              repo: pr.repo,
              number: pr.number,
              url: prUrl,
              sessions: [],
              activeSessionId: null,
            };

            // Check if session already exists
            if (data.sessions.some((s) => s.id === sessionId)) {
              yield* Effect.log(
                `[PrContext] Session ${sessionId} already exists`,
              );
              return data;
            }

            // Add new session
            const newSession: StoredSession = {
              id: sessionId,
              headSha,
              createdAt: Date.now(),
              hidden: false,
            };

            const updated: PrSessionData = {
              ...data,
              sessions: [...data.sessions, newSession],
              activeSessionId: sessionId, // New session becomes active
            };

            yield* store.set(SESSIONS_NAMESPACE, key, updated);
            yield* Effect.log(
              `[PrContext] Added session ${sessionId} to ${pr.owner}/${pr.repo}#${pr.number}`,
            );

            return updated;
          }),

        /**
         * Set the active session for a PR
         */
        setActiveSession: (prUrl: string, sessionId: string) =>
          Effect.gen(function* () {
            const key = prUrlToKey(prUrl);
            if (!key) {
              return yield* Effect.fail(new Error(`Invalid PR URL: ${prUrl}`));
            }

            const data = yield* store.get<PrSessionData>(
              SESSIONS_NAMESPACE,
              key,
            );
            if (!data) {
              return yield* Effect.fail(new Error(`No data for PR: ${prUrl}`));
            }

            // Verify session exists
            if (!data.sessions.some((s) => s.id === sessionId)) {
              return yield* Effect.fail(
                new Error(`Session ${sessionId} not found for PR`),
              );
            }

            const updated: PrSessionData = {
              ...data,
              activeSessionId: sessionId,
            };

            yield* store.set(SESSIONS_NAMESPACE, key, updated);
            yield* Effect.log(`[PrContext] Set active session to ${sessionId}`);

            return updated;
          }),

        /**
         * Hide a session (soft delete)
         */
        hideSession: (prUrl: string, sessionId: string) =>
          Effect.gen(function* () {
            const key = prUrlToKey(prUrl);
            if (!key) {
              return yield* Effect.fail(new Error(`Invalid PR URL: ${prUrl}`));
            }

            const data = yield* store.get<PrSessionData>(
              SESSIONS_NAMESPACE,
              key,
            );
            if (!data) {
              return yield* Effect.fail(new Error(`No data for PR: ${prUrl}`));
            }

            const updated: PrSessionData = {
              ...data,
              sessions: data.sessions.map((s) =>
                s.id === sessionId ? { ...s, hidden: true } : s,
              ),
              // If hiding the active session, clear it
              activeSessionId:
                data.activeSessionId === sessionId
                  ? null
                  : data.activeSessionId,
            };

            yield* store.set(SESSIONS_NAMESPACE, key, updated);
            yield* Effect.log(`[PrContext] Hidden session ${sessionId}`);

            return updated;
          }),

        /**
         * Get the active session for a PR
         */
        getActiveSession: (prUrl: string) =>
          Effect.gen(function* () {
            const key = prUrlToKey(prUrl);
            if (!key) return null;

            const data = yield* store.get<PrSessionData>(
              SESSIONS_NAMESPACE,
              key,
            );
            if (!data || !data.activeSessionId) {
              return null;
            }

            return (
              data.sessions.find((s) => s.id === data.activeSessionId) || null
            );
          }),
      };
    }),
    dependencies: [StoreService.Default],
  },
) {}
