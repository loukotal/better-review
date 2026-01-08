// =============================================================================
// StoreService - Generic disk-backed key-value store
// =============================================================================

import { homedir } from "node:os";
import { join } from "node:path";

import { Effect, Ref } from "effect";

const BASE_DIR = join(homedir(), ".local", "share", "better-review");

// =============================================================================
// StoreService
// =============================================================================

export class StoreService extends Effect.Service<StoreService>()("StoreService", {
  scoped: Effect.gen(function* () {
    // In-memory cache: namespace -> key -> data
    const cache = yield* Ref.make(new Map<string, Map<string, unknown>>());

    // Ensure base directory exists
    yield* Effect.tryPromise(async () => {
      const fs = await import("node:fs/promises");
      await fs.mkdir(BASE_DIR, { recursive: true });
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
        const fs = await import("node:fs/promises");
        await fs.mkdir(join(BASE_DIR, namespace), { recursive: true });
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

        // Read from disk
        const filePath = getFilePath(namespace, key);
        const file = Bun.file(filePath);

        if (!(yield* Effect.tryPromise(() => file.exists()))) {
          return null;
        }

        const data = yield* Effect.tryPromise(() => file.json() as Promise<T>);

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
        yield* Effect.tryPromise(() => Bun.write(filePath, JSON.stringify(data, null, 2)));

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
        const file = Bun.file(filePath);

        if (yield* Effect.tryPromise(() => file.exists())) {
          const fs = yield* Effect.tryPromise(() => import("node:fs/promises"));
          yield* Effect.tryPromise(() => fs.unlink(filePath));
        }

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
        const fs = yield* Effect.tryPromise(() => import("node:fs/promises"));

        const files = yield* Effect.tryPromise(() => fs.readdir(nsDir)).pipe(
          Effect.catchAll((e) => {
            // Only treat ENOENT (directory doesn't exist) as empty list
            const cause = e instanceof Error ? e : (e as { error?: Error }).error;
            if (cause && (cause as NodeJS.ErrnoException).code === "ENOENT") {
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
