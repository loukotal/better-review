import { expect, test } from "bun:test";

import { Effect } from "effect";

import type { GhServiceApi } from "./gh/gh";
import { createDiffCacheServiceApi } from "./state";

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

  expect(calls).toBe(1);
  expect(first).toBe(second);
  expect(first.get("src/alpha.ts")).toBeDefined();
});

test("evicts the least recently used PR diff when over capacity", async () => {
  const gh = createMockGh((prUrl) => Effect.succeed(FULL_DIFF.replaceAll("example", prUrl)));

  const cache = await Effect.runPromise(
    createDiffCacheServiceApi(gh, { maxEntries: 1, maxCommitEntries: 1, ttlMs: 60_000 }),
  );

  await Effect.runPromise(cache.getOrFetch("first"));
  await Effect.runPromise(cache.getOrFetch("second"));

  expect(await Effect.runPromise(cache.get("first"))).toBeUndefined();
  expect(await Effect.runPromise(cache.get("second"))).toBeDefined();
});
