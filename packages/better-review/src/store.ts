// =============================================================================
// StoreService - Generic disk-backed key-value store
// =============================================================================

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Effect, Ref } from "effect";

const BASE_DIR = join(homedir(), ".local", "share", "better-review");

function getErrnoCode(error: unknown): string | undefined {
  let current = error;

  while (current && typeof current === "object") {
    const record = current as { code?: unknown; cause?: unknown; error?: unknown };
    if (typeof record.code === "string") return record.code;
    current = record.cause ?? record.error;
  }

  return undefined;
}

// =============================================================================
// StoreService
// =============================================================================

export interface StoreServiceApi {
  get: <T>(namespace: string, key: string) => Effect.Effect<T | null, Error>;
  set: <T>(namespace: string, key: string, data: T) => Effect.Effect<void, Error>;
  delete: (namespace: string, key: string) => Effect.Effect<void, Error>;
  list: (namespace: string) => Effect.Effect<string[], Error>;
  clearCache: Effect.Effect<void>;
}

export class StoreService extends Effect.Service<StoreService>()("StoreService", {
  effect: Effect.gen(function* () {
    // In-memory cache: namespace -> key -> data
    const cache = yield* Ref.make(new Map<string, Map<string, unknown>>());

    // Ensure base directory exists
    yield* Effect.tryPromise(async () => {
      await mkdir(BASE_DIR, { recursive: true });
    });

    /**
     * Get the file path for a key in a namespace
     */
    const getFilePath = (namespace: string, key: string): string =>
      join(BASE_DIR, namespace, `${key}.json`);

    /**
     * Ensure namespace directory exists
     */
    const ensureNamespace = (namespace: string) =>
      Effect.tryPromise(async () => {
        await mkdir(join(BASE_DIR, namespace), { recursive: true });
      });

    /**
     * Get a value from the store
     */
    const get = <T>(namespace: string, key: string): Effect.Effect<T | null, Error> =>
      Effect.gen(function* () {
        // Check cache first
        const cached = yield* Ref.get(cache);
        const nsCache = cached.get(namespace);
        if (nsCache?.has(key)) {
          return nsCache.get(key) as T;
        }

        const filePath = getFilePath(namespace, key);
        const text = yield* Effect.tryPromise(() => readFile(filePath, "utf8")).pipe(
          Effect.catchAll((e) => {
            if (getErrnoCode(e) === "ENOENT") {
              return Effect.succeed(null);
            }
            return Effect.fail(e);
          }),
        );

        if (text === null) return null;

        const data = JSON.parse(text) as T;

        // Update cache
        yield* Ref.update(cache, (c) => {
          const newCache = new Map(c);
          const nsMap = new Map(newCache.get(namespace) || []);
          nsMap.set(key, data);
          newCache.set(namespace, nsMap);
          return newCache;
        });

        return data;
      });

    /**
     * Set a value in the store
     */
    const set = <T>(namespace: string, key: string, data: T): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        yield* ensureNamespace(namespace);

        const filePath = getFilePath(namespace, key);
        yield* Effect.tryPromise(() => writeFile(filePath, JSON.stringify(data, null, 2)));

        // Update cache
        yield* Ref.update(cache, (c) => {
          const newCache = new Map(c);
          const nsMap = new Map(newCache.get(namespace) || []);
          nsMap.set(key, data);
          newCache.set(namespace, nsMap);
          return newCache;
        });
      });

    /**
     * Delete a value from the store
     */
    const del = (namespace: string, key: string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const filePath = getFilePath(namespace, key);
        yield* Effect.tryPromise(() => unlink(filePath)).pipe(
          Effect.catchAll((e) => {
            if (getErrnoCode(e) === "ENOENT") {
              return Effect.void;
            }
            return Effect.fail(e);
          }),
        );

        // Update cache
        yield* Ref.update(cache, (c) => {
          const newCache = new Map(c);
          const nsMap = newCache.get(namespace);
          if (nsMap) {
            const newNsMap = new Map(nsMap);
            newNsMap.delete(key);
            newCache.set(namespace, newNsMap);
          }
          return newCache;
        });
      });

    /**
     * List all keys in a namespace
     */
    const list = (namespace: string): Effect.Effect<string[], Error> =>
      Effect.gen(function* () {
        const nsDir = join(BASE_DIR, namespace);

        const files = yield* Effect.tryPromise(() => readdir(nsDir)).pipe(
          Effect.catchAll((e) => {
            // Only treat ENOENT (directory doesn't exist) as empty list
            if (getErrnoCode(e) === "ENOENT") {
              return Effect.succeed([] as string[]);
            }
            // Re-throw other errors (permission denied, etc.)
            return Effect.fail(e);
          }),
        );

        return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)); // Remove .json extension
      });

    /**
     * Clear all cached data (useful for testing)
     */
    const clearCache = Ref.set(cache, new Map());

    return {
      get,
      set,
      delete: del,
      list,
      clearCache,
    };
  }),
}) {}

export const StoreServiceLive = StoreService.Default;
