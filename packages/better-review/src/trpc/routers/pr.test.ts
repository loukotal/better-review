import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { parseDiffMeta } from "../../diff";
import { GhService } from "../../gh/gh";
import { runtime } from "../../runtime";
import { DiffCacheService } from "../../state";
import { prRouter } from "./pr";

test("comments outside the cached patch reach GitHub with their line and range intact", async (t) => {
  const calls: unknown[] = [];
  let failure = false;
  const gh = {
    addComment: (input: unknown) => {
      calls.push(input);
      return failure
        ? Effect.fail(new Error("GitHub rejected comment: validation failed"))
        : Effect.succeed({ id: 123, body: "Check this caller" });
    },
  } as unknown as GhService;
  const diff = "@@ -10,3 +10,3 @@\n context\n-old\n+new\n context\n";
  const cache = {
    getOrFetch: () =>
      Effect.succeed(new Map([["src/example.ts", { diff, ...parseDiffMeta(diff) }]])),
  } as unknown as DiffCacheService;
  t.mock.method(runtime, "runPromise", <A>(effect: Effect.Effect<A, unknown, unknown>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(GhService, gh),
        Effect.provideService(DiffCacheService, cache),
      ) as Effect.Effect<A, unknown>,
    ),
  );
  const caller = prRouter.createCaller({
    gh: null,
    opencode: null,
    diffCache: null,
    prContext: null,
  });
  for (const side of ["RIGHT", "LEFT"] as const) {
    const input = {
      prUrl: "https://github.com/owner/repo/pull/1",
      filePath: "src/example.ts",
      line: 50,
      startLine: 48,
      side,
      startSide: side,
      body: "Check this caller",
    };
    const result = await caller.addComment(input);
    assert.deepEqual(calls.at(-1), input);
    assert.equal(result.comment.canEdit, true);
    failure = true;
    await assert.rejects(caller.addComment(input), /GitHub rejected comment/);
    failure = false;
  }
  assert.equal(calls.length, 4);
});
