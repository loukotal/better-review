// =============================================================================
// State Services - DiffCache and PrContext with Effect.Ref
// =============================================================================

import { Effect, Layer, Ref, ServiceMap } from "effect";

import type { PrInfo, StoredSession, PrSessionData, SearchedPr } from "@better-review/shared";

import { type FileDiffMeta, parseFullDiff } from "./diff";
import { GhService, GhServiceLive } from "./gh/gh";
import { StoreService, StoreServiceLive } from "./store";

// =============================================================================
// Types
// =============================================================================

export interface PrContext {
  prUrl: string | null;
  files: string[];
  info: PrInfo | null;
}

// Re-export for convenience
export type { PrInfo, StoredSession, PrSessionData };

// =============================================================================
// Helpers
// =============================================================================

function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
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

const makeDiffCacheService = Effect.gen(function* () {
  // Ref holding: prUrl -> Map<fileName, FileDiffMeta>
  const cache = yield* Ref.make(new Map<string, Map<string, FileDiffMeta>>());

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
          yield* Effect.log(`[cache] Using cached diffs for ${prUrl} (${existing.size} files)`);
          return existing;
        }

        // Fetch using GhService (captured at construction)
        yield* Effect.log(`[cache] Fetching full diff for ${prUrl}...`);
        const fullDiff = yield* gh.getDiff(prUrl);
        yield* Effect.log(`[cache] Full diff fetched (${fullDiff.length} chars)`);

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
});

type SuccessOf<T> = T extends Effect.Effect<infer A, infer _E, infer _R> ? A : never;

type DiffCacheServiceApi = SuccessOf<typeof makeDiffCacheService>;

export class DiffCacheService extends ServiceMap.Service<DiffCacheService, DiffCacheServiceApi>()(
  "DiffCacheService",
  {
    make: makeDiffCacheService,
  },
) {}

export const DiffCacheServiceLive = Layer.effect(DiffCacheService, makeDiffCacheService).pipe(
  Layer.provide(GhServiceLive),
);

// =============================================================================
// PrContextService
// =============================================================================

const SESSIONS_NAMESPACE = "prs";

const makePrContextService = Effect.gen(function* () {
  // Current PR context (runtime only)
  const context = yield* Ref.make<PrContext>({
    prUrl: null,
    files: [],
    info: null,
  });

  // Session -> PR URL mapping (in-memory, populated at runtime)
  const sessionToPr = yield* Ref.make(new Map<string, string>());

  // Get store service for persistence
  const store = yield* StoreService;

  return {
    // =====================================================================
    // Runtime Context
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
    // Session → PR Mapping (in-memory, O(1) lookup)
    // =====================================================================

    /**
     * Register a session → PR URL mapping (call when session is activated)
     */
    registerSession: (sessionId: string, prUrl: string) =>
      Ref.update(sessionToPr, (m) => new Map(m).set(sessionId, prUrl)),

    /**
     * Get PR URL for a session (O(1) lookup)
     */
    getPrUrlBySessionId: (sessionId: string) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(sessionToPr);
        return map.get(sessionId) ?? null;
      }),

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

        const data = yield* store.get<PrSessionData>(SESSIONS_NAMESPACE, key);
        if (!data) {
          return { sessions: [], activeSessionId: null };
        }

        const sessions = includeHidden ? data.sessions : data.sessions.filter((s) => !s.hidden);

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
        const existing = yield* store.get<PrSessionData>(SESSIONS_NAMESPACE, key);
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
          yield* Effect.log(`[PrContext] Session ${sessionId} already exists`);
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

        // Register in-memory mapping for O(1) lookup
        yield* Ref.update(sessionToPr, (m) => new Map(m).set(sessionId, prUrl));

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

        const data = yield* store.get<PrSessionData>(SESSIONS_NAMESPACE, key);
        if (!data) {
          return yield* Effect.fail(new Error(`No data for PR: ${prUrl}`));
        }

        // Verify session exists
        if (!data.sessions.some((s) => s.id === sessionId)) {
          return yield* Effect.fail(new Error(`Session ${sessionId} not found for PR`));
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

        const data = yield* store.get<PrSessionData>(SESSIONS_NAMESPACE, key);
        if (!data) {
          return yield* Effect.fail(new Error(`No data for PR: ${prUrl}`));
        }

        const updated: PrSessionData = {
          ...data,
          sessions: data.sessions.map((s) => (s.id === sessionId ? { ...s, hidden: true } : s)),
          // If hiding the active session, clear it
          activeSessionId: data.activeSessionId === sessionId ? null : data.activeSessionId,
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

        const data = yield* store.get<PrSessionData>(SESSIONS_NAMESPACE, key);
        if (!data || !data.activeSessionId) {
          return null;
        }

        return data.sessions.find((s) => s.id === data.activeSessionId) || null;
      }),
  };
});

type PrContextServiceApi = SuccessOf<typeof makePrContextService>;

export class PrContextService extends ServiceMap.Service<PrContextService, PrContextServiceApi>()(
  "PrContextService",
  {
    make: makePrContextService,
  },
) {}

export const PrContextServiceLive = Layer.effect(PrContextService, makePrContextService).pipe(
  Layer.provide(StoreServiceLive),
);

// =============================================================================
// PrListCacheService - Background-refreshed PR list cache
// =============================================================================

const PR_LIST_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

interface PrListCacheData {
  prs: readonly SearchedPr[];
  fetchedAt: number;
}

const makePrListCacheService = Effect.gen(function* () {
  const cache = yield* Ref.make<PrListCacheData | null>(null);
  const refreshing = yield* Ref.make(false);
  const gh = yield* GhService;

  /**
   * Fetch fresh PR list from GitHub and update the cache.
   * Returns the fresh data. Deduplicates concurrent fetches.
   */
  const refresh = Effect.gen(function* () {
    // Skip if already refreshing (dedup concurrent calls)
    const isRefreshing = yield* Ref.get(refreshing);
    if (isRefreshing) {
      yield* Effect.log("[pr-list-cache] Refresh already in progress, skipping");
      return yield* Ref.get(cache);
    }

    yield* Ref.set(refreshing, true);
    const startTime = Date.now();

    const result = yield* Effect.gen(function* () {
      yield* Effect.log("[pr-list-cache] Refreshing PR list...");
      const prs = yield* gh.searchReviewRequested();
      const data: PrListCacheData = { prs, fetchedAt: Date.now() };
      yield* Ref.set(cache, data);
      yield* Effect.log(
        `[pr-list-cache] Refreshed ${prs.length} PRs in ${Date.now() - startTime}ms`,
      );
      return data;
    }).pipe(Effect.ensuring(Ref.set(refreshing, false)));

    return result;
  });

  return {
    /**
     * Get cached PR list. Returns null if never fetched.
     */
    get: Ref.get(cache),

    /**
     * Force a refresh of the PR list cache. Returns the fresh data.
     */
    refresh,

    /**
     * Get cached data immediately, and trigger a background refresh.
     * This is the primary method for the tRPC endpoint — returns fast
     * with potentially stale data, while kicking off a fresh fetch.
     */
    getAndRefresh: Effect.gen(function* () {
      const cached = yield* Ref.get(cache);

      // Always trigger a background refresh (fire-and-forget)
      yield* refresh.pipe(
        Effect.catch((e) => Effect.log(`[pr-list-cache] Background refresh failed: ${e}`)),
        Effect.forkDetach,
      );

      return cached;
    }),

    /**
     * Check if the cache is stale (older than the refresh interval).
     */
    isStale: Effect.gen(function* () {
      const data = yield* Ref.get(cache);
      if (!data) return true;
      return Date.now() - data.fetchedAt > PR_LIST_REFRESH_INTERVAL_MS;
    }),

    /**
     * Get the age of the cache in ms. Returns null if never fetched.
     */
    age: Effect.gen(function* () {
      const data = yield* Ref.get(cache);
      if (!data) return null;
      return Date.now() - data.fetchedAt;
    }),

    /**
     * Background refresh loop. Run as a forked fiber.
     * Refreshes every 15 minutes.
     */
    backgroundLoop: Effect.gen(function* () {
      yield* Effect.log(
        `[pr-list-cache] Starting background refresh loop (interval: ${PR_LIST_REFRESH_INTERVAL_MS / 1000}s)`,
      );

      // Initial fetch on startup
      yield* refresh.pipe(
        Effect.catch((e) => Effect.log(`[pr-list-cache] Initial fetch failed: ${e}`)),
      );

      // Loop: sleep then refresh
      while (true) {
        yield* Effect.sleep(PR_LIST_REFRESH_INTERVAL_MS);
        yield* refresh.pipe(
          Effect.catch((e) => Effect.log(`[pr-list-cache] Periodic refresh failed: ${e}`)),
        );
      }
    }),
  };
});

type PrListCacheServiceApi = SuccessOf<typeof makePrListCacheService>;

export class PrListCacheService extends ServiceMap.Service<
  PrListCacheService,
  PrListCacheServiceApi
>()("PrListCacheService", { make: makePrListCacheService }) {}

export const PrListCacheServiceLive = Layer.effect(PrListCacheService, makePrListCacheService).pipe(
  Layer.provide(GhServiceLive),
);
