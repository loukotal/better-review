import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import type { ReviewSnapshot } from "@better-review/shared";

import { GhService } from "../../gh/gh";
import { PrCheckoutService } from "../../pr-checkout";
import { PrReviewSessionService } from "../../pr-review-sessions";
import type { PrReviewSession } from "../../pr-review-sessions";
import { fixtureSession } from "../../review/fixtures";
import { reviewConversations } from "../../review/runtime";
import { runtime } from "../../runtime";
import { PrContextService } from "../../state";
import { prReviewRouter } from "./pr-review";

test("selecting history keeps the saved revision; historical source references are validated", async (t) => {
  const session = {
    ...fixtureSession,
    revisionHistory: [{ headSha: "old", baseSha: "base", commitSha: null, pulledAt: 1 }],
  };
  const calls: unknown[] = [];
  const store = {
    get: (id: string) => Effect.succeed(id === session.id ? session : null),
  } as unknown as PrReviewSessionService;
  const context = {
    listSessions: () =>
      Effect.succeed({
        sessions: [{ id: session.id, headSha: session.headSha, createdAt: 1, hidden: false }],
        activeSessionId: session.id,
      }),
    setActiveSession: () => Effect.void,
    registerSession: () => Effect.void,
    setSessionScope: () => Effect.void,
  } as unknown as PrContextService;
  const gh = {
    getFileContent: (input: unknown) =>
      Effect.sync(() => {
        calls.push(input);
        return "source";
      }),
  } as unknown as GhService;
  t.mock.method(runtime, "runPromise", <A>(effect: Effect.Effect<A, unknown, unknown>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(PrReviewSessionService, store),
        Effect.provideService(PrContextService, context),
        Effect.provideService(GhService, gh),
      ) as Effect.Effect<A, unknown>,
    ),
  );
  const caller = prReviewRouter.createCaller({
    gh: null,
    opencode: null,
    diffCache: null,
    prContext: null,
  });
  assert.equal(
    (await caller.selectSession({ prUrl: session.prUrl, sessionId: session.id })).sessionHeadSha,
    fixtureSession.headSha,
  );
  assert.equal(
    (await caller.source({ sessionId: session.id, path: "source.ts", ref: "old" })).ref,
    "old",
  );
  await assert.rejects(
    caller.source({ sessionId: session.id, path: "source.ts", ref: "arbitrary" }),
    /Revision not found/,
  );
  await assert.rejects(caller.source({ sessionId: session.id, path: "../secret" }));
  await assert.rejects(
    caller.selectSession({ prUrl: "https://github.com/other/repo/pull/2", sessionId: session.id }),
    /not found for PR/,
  );
  assert.equal(calls.length, 1);
});

test("automatic reviews coalesce concurrent launches, retain completed results, and explicitly rerun into a new session", async (t) => {
  const sessions = new Map<string, PrReviewSession>();
  const histories = new Map<string, ReviewSnapshot>();
  let active: string | null = null;
  let admissions = 0;
  const list = () => ({
    sessions: [...sessions.values()].map((s) => ({
      id: s.id,
      headSha: s.headSha,
      createdAt: s.createdAt,
      hidden: false,
    })),
    activeSessionId: active,
  });
  const store = {
    get: (id: string) => Effect.succeed(sessions.get(id) ?? null),
    create: (input: PrReviewSession) =>
      Effect.sync(() => {
        const session = { ...input, createdAt: sessions.size + 1, updatedAt: 1 };
        sessions.set(session.id, session);
        return session;
      }),
    save: (session: PrReviewSession) =>
      Effect.sync(() => {
        sessions.set(session.id, session);
      }),
  } as unknown as PrReviewSessionService;
  const context = {
    listSessions: () => Effect.sync(list),
    setCurrent: () => Effect.void,
    registerSession: () => Effect.void,
    setSessionScope: () => Effect.void,
    addSession: (_url: string, id: string) =>
      Effect.sync(() => {
        active = id;
        return list();
      }),
  } as unknown as PrContextService;
  const gh = {
    getHeadSha: () => Effect.succeed("A"),
    getBaseSha: () => Effect.succeed("base"),
    getHeadRef: () => Effect.succeed("feature"),
    getBaseRef: () => Effect.succeed("main"),
    getDiff: () => Effect.succeed(""),
  } as unknown as GhService;
  const checkout = {
    prepare: () => Effect.succeed({ worktreePath: "/fixture/A" }),
  } as unknown as PrCheckoutService;
  t.mock.method(runtime, "runPromise", <A>(effect: Effect.Effect<A, unknown, unknown>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(PrReviewSessionService, store),
        Effect.provideService(PrContextService, context),
        Effect.provideService(GhService, gh),
        Effect.provideService(PrCheckoutService, checkout),
      ) as Effect.Effect<A, unknown>,
    ),
  );
  t.mock.method(reviewConversations, "history", async (id: string) => histories.get(id) ?? null);
  t.mock.method(reviewConversations, "send", async (id: string, body: string) => {
    admissions++;
    const submissionId = `submission-${admissions}`;
    histories.set(id, {
      sessionId: id,
      running: true,
      compacting: false,
      settlements: [],
      messages: [
        {
          id: submissionId,
          submissionId,
          role: "user",
          parts: [{ type: "text", text: body }],
          metadata: { timestamp: new Date().toISOString() },
        },
      ],
    });
    return { submissionId };
  });
  const caller = prReviewRouter.createCaller({
    gh: null,
    opencode: null,
    diffCache: null,
    prContext: null,
  });
  const [first, duplicate] = await Promise.all([
    caller.startAutomatic({ prUrl: fixtureSession.prUrl }),
    caller.startAutomatic({ prUrl: fixtureSession.prUrl }),
  ]);
  assert.deepEqual(first, duplicate);
  assert.equal(admissions, 1);
  assert.equal(
    (await caller.startAutomatic({ prUrl: fixtureSession.prUrl, rerun: true })).sessionId,
    first.sessionId,
  );
  const history = histories.get(first.sessionId!)!;
  history.running = false;
  history.settlements.push({ submissionId: "submission-1", outcome: "completed" });
  assert.equal((await caller.startAutomatic({ prUrl: fixtureSession.prUrl })).state, "completed");
  assert.equal(admissions, 1);
  const next = await caller.startAutomatic({ prUrl: fixtureSession.prUrl, rerun: true });
  assert.notEqual(next.sessionId, first.sessionId);
  assert.equal(admissions, 2);
  assert.equal(history.messages.length, 1);
});

test("pulling updates the same session and durably admits continuation on the server", async (t) => {
  let session = structuredClone(fixtureSession);
  let running = false;
  let admissions = 0;
  const store = {
    get: () => Effect.sync(() => structuredClone(session)),
    save: (value: typeof session) =>
      Effect.sync(() => {
        session = structuredClone(value);
      }),
  } as unknown as PrReviewSessionService;
  const list = () =>
    Effect.succeed({
      sessions: [{ id: session.id, headSha: session.headSha, createdAt: 1, hidden: false }],
      activeSessionId: session.id,
    });
  const context = {
    listSessions: list,
    setActiveSession: () => Effect.void,
    registerSession: () => Effect.void,
    setSessionScope: () => Effect.void,
    updateSessionHead: () => Effect.void,
  } as unknown as PrContextService;
  const gh = {
    getHeadSha: () => Effect.succeed("rewritten-B"),
    getBaseSha: () => Effect.succeed("base"),
    getHeadRef: () => Effect.succeed("feature"),
    getBaseRef: () => Effect.succeed("main"),
    getDiff: () => Effect.succeed(""),
  } as unknown as GhService;
  const checkout = {
    prepare: () =>
      Effect.succeed({
        worktreePath: "/fixture/B",
        repoAccess: { checkedAt: 1, trackedFileCount: 1, sampledFiles: [], sparseCheckout: false },
      }),
  } as unknown as PrCheckoutService;
  t.mock.method(runtime, "runPromise", <A>(effect: Effect.Effect<A, unknown, unknown>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(PrReviewSessionService, store),
        Effect.provideService(PrContextService, context),
        Effect.provideService(GhService, gh),
        Effect.provideService(PrCheckoutService, checkout),
      ) as Effect.Effect<A, unknown>,
    ),
  );
  t.mock.method(reviewConversations, "history", async () => ({
    sessionId: session.id,
    messages: [],
    settlements: [],
    running,
    compacting: false,
  }));
  t.mock.method(reviewConversations, "admit", async (_id: string, prompt: string) => {
    admissions++;
    assert.ok(prompt.includes(`Previous revision: ${fixtureSession.headSha}`));
    return { submissionId: "new-request" };
  });
  const caller = prReviewRouter.createCaller({
    gh: null,
    opencode: null,
    diffCache: null,
    prContext: null,
  });
  running = true;
  await assert.rejects(
    caller.pullLatest({ sessionId: session.id, prUrl: session.prUrl }),
    /finish before pulling/,
  );
  running = false;
  const result = await caller.pullLatest({ sessionId: session.id, prUrl: session.prUrl });
  assert.equal(result.headSha, "rewritten-B");
  assert.equal(session.id, fixtureSession.id);
  assert.equal(session.revisionHistory?.[0]?.headSha, fixtureSession.headSha);
  assert.equal(session.automaticReview?.submissionId, "new-request");
  assert.equal(admissions, 1);
  assert.equal(
    (await caller.pullLatest({ sessionId: session.id, prUrl: session.prUrl })).changed,
    false,
  );
  assert.equal(admissions, 1);
});
