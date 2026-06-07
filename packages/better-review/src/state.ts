// =============================================================================
// State Services - DiffCache and PrContext with Effect.Ref
// =============================================================================

import { Effect, Layer, Ref } from "effect";

import type { PrInfo, StoredSession, PrSessionData, SearchedPr } from "@better-review/shared";

import { type FileDiffMeta, parseFullDiff } from "./diff";
import { GhService, GhServiceLive, type GhServiceApi } from "./gh/gh";
import { StoreService, StoreServiceLive } from "./store";

// =============================================================================
// Types
// =============================================================================

export interface PrContext {
  prUrl: string | null;
  files: string[];
  info: PrInfo | null;
}

export interface SessionReviewScope {
  mode: "full" | "commit";
  commitSha: string | null;
}

// Re-export for convenience
export type { PrInfo, StoredSession, PrSessionData };

// =============================================================================
// Helpers
// =============================================================================

export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
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

interface DiffCacheEntry {
  fileDiffs: Map<string, FileDiffMeta>;
  cachedAt: number;
}

export interface DiffCacheOptions {
  maxEntries: number;
  maxCommitEntries: number;
  ttlMs: number;
}

const DEFAULT_DIFF_CACHE_OPTIONS: DiffCacheOptions = {
  maxEntries: Number(process.env.DIFF_CACHE_MAX_ENTRIES ?? 20),
  maxCommitEntries: Number(process.env.DIFF_COMMIT_CACHE_MAX_ENTRIES ?? 100),
  ttlMs: Number(process.env.DIFF_CACHE_TTL_MS ?? 30 * 60 * 1000),
};

function touchCacheEntry<T>(cache: Map<string, T>, key: string, entry: T): Map<string, T> {
  const next = new Map(cache);
  next.delete(key);
  next.set(key, entry);
  return next;
}

function setBoundedCacheEntry<T>(
  cache: Map<string, T>,
  key: string,
  entry: T,
  maxEntries: number,
): Map<string, T> {
  const next = touchCacheEntry(cache, key, entry);

  while (next.size > maxEntries) {
    const oldestKey = next.keys().next().value;
    if (oldestKey === undefined) break;
    next.delete(oldestKey);
  }

  return next;
}

export const createDiffCacheServiceApi = (
  gh: GhServiceApi,
  partialOptions: Partial<DiffCacheOptions> = {},
) =>
  Effect.gen(function* () {
    const options = { ...DEFAULT_DIFF_CACHE_OPTIONS, ...partialOptions };

    // Ref holding: prUrl -> cached diff entry
    const cache = yield* Ref.make(new Map<string, DiffCacheEntry>());
    // Ref holding: `${prUrl}#${commitSha}` -> cached diff entry
    const commitCache = yield* Ref.make(new Map<string, DiffCacheEntry>());

    const inFlight = new Map<string, Promise<Map<string, FileDiffMeta>>>();
    const commitInFlight = new Map<string, Promise<Map<string, FileDiffMeta>>>();

    const readFreshEntry = (
      target: Ref.Ref<Map<string, DiffCacheEntry>>,
      key: string,
    ): Effect.Effect<Map<string, FileDiffMeta> | undefined> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(target);
        const entry = current.get(key);
        if (!entry) return undefined;

        if (Date.now() - entry.cachedAt > options.ttlMs) {
          yield* Ref.update(target, (m) => {
            const next = new Map(m);
            next.delete(key);
            return next;
          });
          return undefined;
        }

        yield* Ref.update(target, (m) => touchCacheEntry(m, key, entry));
        return entry.fileDiffs;
      });

    const loadWithDedup = (
      target: Ref.Ref<Map<string, DiffCacheEntry>>,
      pending: Map<string, Promise<Map<string, FileDiffMeta>>>,
      key: string,
      maxEntries: number,
      load: Effect.Effect<Map<string, FileDiffMeta>, unknown, never>,
      waitLabel: string,
    ): Effect.Effect<Map<string, FileDiffMeta>, unknown> =>
      Effect.gen(function* () {
        const cached = yield* readFreshEntry(target, key);
        if (cached) return cached;

        const existingLoad = pending.get(key);
        if (existingLoad) {
          yield* Effect.log(`[cache] Waiting for in-flight ${waitLabel}`);
          return yield* Effect.promise(() => existingLoad);
        }

        const loadPromise = Effect.runPromise(
          load.pipe(
            Effect.tap((fileDiffs) =>
              Ref.update(target, (m) =>
                setBoundedCacheEntry(m, key, { fileDiffs, cachedAt: Date.now() }, maxEntries),
              ),
            ),
          ),
        ).finally(() => {
          pending.delete(key);
        });

        pending.set(key, loadPromise);
        return yield* Effect.promise(() => loadPromise);
      });

    return {
      /**
       * Get cached diffs for a PR, or fetch and cache them
       */
      getOrFetch: (prUrl: string) =>
        loadWithDedup(
          cache,
          inFlight,
          prUrl,
          options.maxEntries,
          Effect.gen(function* () {
            yield* Effect.log(`[cache] Fetching full diff for ${prUrl}...`);
            const fullDiff = yield* gh.getDiff(prUrl);
            yield* Effect.log(`[cache] Full diff fetched (${fullDiff.length} chars)`);

            const fileDiffs = parseFullDiff(fullDiff);
            yield* Effect.log(`[cache] Cached ${fileDiffs.size} file diffs`);
            return fileDiffs;
          }),
          `diff fetch for ${prUrl}`,
        ),

      /**
       * Get cached diffs without fetching (returns undefined if not cached)
       */
      get: (prUrl: string) => readFreshEntry(cache, prUrl),

      /**
       * Get cached diffs for a specific commit, or fetch and cache them
       */
      getOrFetchCommit: (prUrl: string, commitSha: string) =>
        loadWithDedup(
          commitCache,
          commitInFlight,
          `${prUrl}#${commitSha}`,
          options.maxCommitEntries,
          Effect.gen(function* () {
            const prInfo = yield* gh.getPrInfo(prUrl);
            yield* Effect.log(`[cache] Fetching commit diff for ${commitSha}...`);
            const fullDiff = yield* gh.getCommitDiff({
              owner: prInfo.owner,
              repo: prInfo.repo,
              sha: commitSha,
            });

            const fileDiffs = parseFullDiff(fullDiff);
            yield* Effect.log(
              `[cache] Cached ${fileDiffs.size} commit file diffs for ${commitSha}`,
            );
            return fileDiffs;
          }),
          `commit diff fetch for ${commitSha}`,
        ),

      /**
       * Get commit cached diffs without fetching (returns undefined if not cached)
       */
      getCommit: (prUrl: string, commitSha: string) =>
        readFreshEntry(commitCache, `${prUrl}#${commitSha}`),

      /**
       * Clear cache for a specific PR
       */
      clear: (prUrl: string) =>
        Effect.gen(function* () {
          yield* Ref.update(cache, (m) => {
            const newMap = new Map(m);
            newMap.delete(prUrl);
            return newMap;
          });

          yield* Ref.update(commitCache, (m) => {
            const newMap = new Map(m);
            for (const key of newMap.keys()) {
              if (key.startsWith(`${prUrl}#`)) {
                newMap.delete(key);
              }
            }
            return newMap;
          });
        }),

      /**
       * Clear all cached diffs
       */
      clearAll: Effect.gen(function* () {
        yield* Ref.set(cache, new Map());
        yield* Ref.set(commitCache, new Map());
        inFlight.clear();
        commitInFlight.clear();
      }),
    };
  });

const makeDiffCacheService = Effect.gen(function* () {
  const gh = yield* GhService;
  return yield* createDiffCacheServiceApi(gh);
});

export class DiffCacheService extends Effect.Service<DiffCacheService>()("DiffCacheService", {
  effect: makeDiffCacheService,
}) {}

export const DiffCacheServiceLive = DiffCacheService.Default.pipe(Layer.provide(GhServiceLive));

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
  const sessionToScope = yield* Ref.make(new Map<string, SessionReviewScope>());

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
      Effect.gen(function* () {
        yield* Ref.update(sessionToPr, (m) => new Map(m).set(sessionId, prUrl));
        yield* Ref.update(sessionToScope, (m) => {
          const next = new Map(m);
          if (!next.has(sessionId)) {
            next.set(sessionId, { mode: "full", commitSha: null });
          }
          return next;
        });
      }),

    /**
     * Get PR URL for a session (O(1) lookup)
     */
    getPrUrlBySessionId: (sessionId: string) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(sessionToPr);
        return map.get(sessionId) ?? null;
      }),

    setSessionScope: (sessionId: string, scope: SessionReviewScope) =>
      Ref.update(sessionToScope, (m) => new Map(m).set(sessionId, scope)),

    getSessionScope: (sessionId: string) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(sessionToScope);
        return map.get(sessionId) ?? { mode: "full", commitSha: null };
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
        yield* Ref.update(sessionToScope, (m) =>
          new Map(m).set(sessionId, { mode: "full", commitSha: null }),
        );

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

export class PrContextService extends Effect.Service<PrContextService>()("PrContextService", {
  effect: makePrContextService,
}) {}

export const PrContextServiceLive = PrContextService.Default.pipe(Layer.provide(StoreServiceLive));

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
     * Get cached data immediately, and trigger a background refresh only when stale.
     * This is the primary method for the tRPC endpoint — returns fast with cached
     * data, while kicking off a fresh fetch when needed.
     */
    getAndRefresh: Effect.gen(function* () {
      const cached = yield* Ref.get(cache);

      if (!cached) {
        return null;
      }

      const isStale = Date.now() - cached.fetchedAt > PR_LIST_REFRESH_INTERVAL_MS;
      if (!isStale) {
        return cached;
      }

      // Only refresh stale cache entries so frequent list reads stay cheap.
      yield* refresh.pipe(
        Effect.catchAll((e) => Effect.log(`[pr-list-cache] Background refresh failed: ${e}`)),
        Effect.forkDaemon,
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
        Effect.catchAll((e) => Effect.log(`[pr-list-cache] Initial fetch failed: ${e}`)),
      );

      // Loop: sleep then refresh
      while (true) {
        yield* Effect.sleep(PR_LIST_REFRESH_INTERVAL_MS);
        yield* refresh.pipe(
          Effect.catchAll((e) => Effect.log(`[pr-list-cache] Periodic refresh failed: ${e}`)),
        );
      }
    }),
  };
});

export class PrListCacheService extends Effect.Service<PrListCacheService>()("PrListCacheService", {
  effect: makePrListCacheService,
}) {}

export const PrListCacheServiceLive = PrListCacheService.Default.pipe(Layer.provide(GhServiceLive));
