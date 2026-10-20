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
  const hydrated = await caller.selectSession({ prUrl: session.prUrl, sessionId: session.id });
  assert.equal(hydrated.sessionHeadSha, fixtureSession.headSha);
  assert.deepEqual(hydrated.sessionScope, {
    mode: session.reviewMode,
    commitSha: session.commitSha,
  });
  session.reviewMode = "commit";
  session.commitSha = session.headSha;
  const switched = await caller.switch({ prUrl: session.prUrl, sessionId: session.id });
  assert.deepEqual(switched.sessionScope, { mode: "commit", commitSha: session.headSha });
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

test("automatic reviews coalesce busy launches while explicit creation always makes a fresh conversation", async (t) => {
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
  // Exercise the actual explicit-create route, not a fake createSession callback.
  const createInput = {
    prUrl: fixtureSession.prUrl,
    prNumber: fixtureSession.number,
    repoOwner: fixtureSession.owner,
    repoName: fixtureSession.repo,
    files: fixtureSession.files,
  };
  for (const compacting of [false, true]) {
    active = first.sessionId!;
    const busy = histories.get(active)!;
    busy.running = !compacting;
    busy.compacting = compacting;
    const fresh = await caller.create(createInput);
    assert.deepEqual(fresh.sessionScope, { mode: "full", commitSha: null });
    assert.notEqual(
      fresh.session.id,
      first.sessionId,
      "explicit new must not reuse a busy conversation",
    );
    assert.equal(fresh.existing, false);
    assert.equal(
      histories.has(fresh.session.id),
      false,
      "creating must not send a full-review prompt",
    );
    assert.equal(admissions, 1);
  }
  const commit = await caller.create({ ...createInput, reviewMode: "commit", commitSha: "A" });
  assert.deepEqual(commit.sessionScope, { mode: "commit", commitSha: "A" });
  histories.set(commit.session.id, {
    sessionId: commit.session.id,
    running: true,
    compacting: false,
    settlements: [],
    messages: [],
  });
  const busyCommitInFullView = await caller.getOrCreateSession({
    ...createInput,
    reviewMode: "full",
  });
  assert.equal(busyCommitInFullView.session.id, commit.session.id);
  assert.deepEqual(busyCommitInFullView.sessionScope, { mode: "commit", commitSha: "A" });
  active = first.sessionId!;
  histories.get(active)!.running = true;
  histories.get(active)!.compacting = false;
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

test("pull converts same-SHA commit scope, refreshes changed heads, and hydrates unchanged scope", async (t) => {
  let session = structuredClone(fixtureSession);
  session.reviewMode = "commit";
  session.commitSha = session.headSha;
  let latestHead = session.headSha;
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
    getHeadSha: () => Effect.succeed(latestHead),
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
    return { submissionId: `new-request-${admissions}` };
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
  assert.equal(result.headSha, fixtureSession.headSha);
  assert.equal(result.changed, true, "Same SHA still converts commit scope to full PR");
  assert.deepEqual(result.session, { id: session.id });
  assert.deepEqual(result.sessionScope, {
    mode: "full",
    commitSha: null,
    afterSubmissionId: "new-request-1",
  });
  assert.equal(session.reviewMode, "full");
  assert.equal(session.commitSha, null);
  assert.equal(session.id, fixtureSession.id);
  assert.equal(session.revisionHistory?.[0]?.headSha, fixtureSession.headSha);
  assert.equal(session.automaticReview?.submissionId, "new-request-1");
  assert.equal(admissions, 1);
  const unchanged = await caller.pullLatest({ sessionId: session.id, prUrl: session.prUrl });
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.sessionScope, result.sessionScope);
  assert.equal(admissions, 1);
  latestHead = "rewritten-B";
  const changed = await caller.pullLatest({ sessionId: session.id, prUrl: session.prUrl });
  assert.equal(changed.changed, true);
  assert.equal(changed.headSha, latestHead);
  assert.deepEqual(changed.sessionScope, {
    mode: "full",
    commitSha: null,
    afterSubmissionId: "new-request-2",
  });
  assert.equal(admissions, 2);
  const rehydrated = await caller.selectSession({ sessionId: session.id, prUrl: session.prUrl });
  assert.deepEqual(rehydrated.sessionScope, changed.sessionScope);
});
