import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { decodeGithubReviewComments, GhError, GhService } from "../../gh/gh";
import { runtime } from "../../runtime";
import { prRouter } from "./pr";

test("extras keeps missing thread evidence unknown rather than unresolved", async (t) => {
  let fail = true;
  const gh = {
    listComments: () =>
      Effect.succeed([{ id: 1, node_id: "C1", body: "body", user: { login: "me" } }]),
    listIssueComments: () => Effect.succeed([]),
    getPrStatus: () => Effect.succeed(null),
    getCurrentUser: () => Effect.succeed("me"),
    getReviewThreads: () =>
      fail
        ? Effect.fail(new GhError({ command: "threads", cause: new Error("scope denied") }))
        : Effect.succeed([{ threadId: "T1", isResolved: false, commentNodeIds: ["C1"] }]),
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
  const missing = await caller.extras({ url: "https://github.com/o/r/pull/1" });
  assert.equal(missing.reviewThreads.status, "unavailable");
  assert.equal(missing.comments?.[0]?.isResolved, undefined);
  assert.equal(missing.comments?.[0]?.threadMetadataStatus, "unknown");
  fail = false;
  const known = await caller.extras({ url: "https://github.com/o/r/pull/1" });
  assert.equal(known.reviewThreads.status, "available");
  assert.equal(known.comments?.[0]?.isResolved, false);
  assert.equal(known.comments?.[0]?.threadMetadataStatus, "available");
});

test("overview extras preserve actual decoded current and original GitHub comment revisions", async (t) => {
  const current = "a".repeat(40),
    original = "b".repeat(40);
  const decoded = decodeGithubReviewComments([
    {
      id: 1,
      node_id: "C1",
      path: "src/a.ts",
      line: null,
      original_line: 7,
      side: "LEFT",
      body: "historical comment",
      html_url: "https://github.com/o/r/pull/1#discussion_r1",
      user: { login: "me", avatar_url: "" },
      created_at: "2026-01-01T00:00:00Z",
      commit_id: current,
      original_commit_id: original,
    },
  ]);
  const gh = {
    listComments: () => Effect.succeed(decoded),
    listIssueComments: () => Effect.succeed([]),
    getPrStatus: () => Effect.succeed(null),
    getCurrentUser: () => Effect.succeed("me"),
    getReviewThreads: () => Effect.succeed([]),
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
  const overview = await caller.extras({ url: "https://github.com/o/r/pull/1" });
  assert.equal(overview.comments?.[0]?.commit_id, current);
  assert.equal(overview.comments?.[0]?.original_commit_id, original);
  assert.equal(overview.comments?.[0]?.line, null);
  assert.equal(overview.comments?.[0]?.side, "LEFT");
  assert.equal(overview.comments?.[0]?.original_line, 7);
});
