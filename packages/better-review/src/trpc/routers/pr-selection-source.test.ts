import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { GhService } from "../../gh/gh";
import { runtime } from "../../runtime";
import { prRouter } from "./pr";

test("PR source metadata distinguishes changing heads and actual expanded source refs", async (t) => {
  let heads = ["old", "new"];
  const freshReads: boolean[] = [];
  const fileReads: unknown[] = [];
  const gh = {
    getHeadSha: (_url: string, fresh = false) =>
      Effect.sync(() => {
        freshReads.push(fresh);
        return heads.shift() ?? "new";
      }),
    getBaseSha: () => Effect.succeed("comparison-base"),
    getDiff: () => Effect.succeed("patch"),
    getPrInfo: () => Effect.succeed({ owner: "o", repo: "r", number: "1" }),
    listCommits: () => Effect.succeed([]),
    getFileContent: (input: unknown) =>
      Effect.sync(() => {
        fileReads.push(input);
        return "source";
      }),
  } as unknown as GhService;
  t.mock.method(runtime, "runPromise", <A>(effect: Effect.Effect<A, unknown, unknown>) =>
    Effect.runPromise(
      effect.pipe(Effect.provideService(GhService, gh)) as Effect.Effect<A, unknown>,
    ),
  );
  const caller = prRouter.createCaller({
    gh: null,
    opencode: null,
    diffCache: null,
    prContext: null,
  });
  const changed = await caller.core({ url: "https://github.com/o/r/pull/1" });
  assert.equal(changed.headSha, null);
  assert.equal(changed.comparisonBaseSha, "comparison-base");
  assert.deepEqual(freshReads, [true, true]);
  heads = ["stable", "stable"];
  assert.equal((await caller.core({ url: "https://github.com/o/r/pull/1" })).headSha, "stable");
  const expanded = await caller.fileContent({
    url: "https://github.com/o/r/pull/1",
    path: "new.ts",
    prevPath: "old.ts",
  });
  assert.equal(expanded.baseSha, "comparison-base");
  assert.equal(expanded.headSha, "new");
  assert.deepEqual(fileReads, [
    { owner: "o", repo: "r", path: "old.ts", ref: "comparison-base" },
    { owner: "o", repo: "r", path: "new.ts", ref: "new" },
  ]);
});
