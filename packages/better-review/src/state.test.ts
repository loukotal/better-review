import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import type { GhServiceApi } from "./gh/gh";
import { createDiffCacheServiceApi } from "./state";
import { StoreService, StoreServiceLive } from "./store";

const FULL_DIFF = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1,2 @@
-const before = true;
+const before = true;
+const after = true;
`;

function createMockGh(getDiff: GhServiceApi["getDiff"]): GhServiceApi {
  return {
    getDiff,
  } as unknown as GhServiceApi;
}

test("deduplicates concurrent PR diff fetches", async () => {
  let calls = 0;
  const gh = createMockGh((prUrl) =>
    Effect.promise(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return FULL_DIFF.replaceAll("example", prUrl);
    }),
  );

  const cache = await Effect.runPromise(createDiffCacheServiceApi(gh));

  const [first, second] = await Promise.all([
    Effect.runPromise(cache.getOrFetch("alpha")),
    Effect.runPromise(cache.getOrFetch("alpha")),
  ]);

  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.ok(first.get("src/alpha.ts"));
});

test("evicts the least recently used PR diff when over capacity", async () => {
  const gh = createMockGh((prUrl) => Effect.succeed(FULL_DIFF.replaceAll("example", prUrl)));

  const cache = await Effect.runPromise(
    createDiffCacheServiceApi(gh, { maxEntries: 1, maxCommitEntries: 1, ttlMs: 60_000 }),
  );

  await Effect.runPromise(cache.getOrFetch("first"));
  await Effect.runPromise(cache.getOrFetch("second"));

  assert.equal(await Effect.runPromise(cache.get("first")), undefined);
  assert.ok(await Effect.runPromise(cache.get("second")));
});

test("store treats missing files and namespaces as empty", async () => {
  const namespace = `missing-test-${Date.now()}`;
  const key = "does-not-exist";

  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* StoreService;

      assert.equal(yield* store.get(namespace, key), null);
      assert.deepEqual(yield* store.list(namespace), []);
      yield* store.delete(namespace, key);
    }).pipe(Effect.provide(StoreServiceLive)),
  );
});
