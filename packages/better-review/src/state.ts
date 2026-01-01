// =============================================================================
// State Services - DiffCache and PrContext with Effect.Ref
// =============================================================================

import { Effect, Ref } from "effect";
import { type FileDiffMeta, parseFullDiff } from "./diff";
import { GhService, GhServiceLive } from "./gh/gh";

// =============================================================================
// PR Context Types
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

export class PrContextService extends Effect.Service<PrContextService>()(
  "PrContextService",
  {
    scoped: Effect.gen(function* () {
      // Current PR context
      const context = yield* Ref.make<PrContext>({
        prUrl: null,
        files: [],
        info: null,
      });

      // Session mappings: prUrl -> sessionId
      const sessions = yield* Ref.make(new Map<string, string>());

      return {
        /**
         * Set the current PR context
         */
        setCurrent: (prUrl: string, files: string[], info: PrInfo) =>
          Ref.set(context, { prUrl, files, info }),

        /**
         * Get the current PR context
         */
        getCurrent: Ref.get(context),

        /**
         * Get session ID for a PR URL
         */
        getSession: (prUrl: string) =>
          Effect.map(Ref.get(sessions), (m) => m.get(prUrl)),

        /**
         * Set session ID for a PR URL
         */
        setSession: (prUrl: string, sessionId: string) =>
          Ref.update(sessions, (m) => {
            const newMap = new Map(m);
            newMap.set(prUrl, sessionId);
            return newMap;
          }),

        /**
         * Check if a session exists for a PR URL
         */
        hasSession: (prUrl: string) =>
          Effect.map(Ref.get(sessions), (m) => m.has(prUrl)),
      };
    }),
  },
) {}
