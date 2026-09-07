import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Effect } from "effect";
import { Hono } from "hono";

import { STRUCTURED_REVIEW_PROMPT, type ReviewConversation } from "@better-review/shared";

import {
  FlueReviewSessionService,
  isFlueV2ReviewSession,
  type FlueReviewSession,
} from "../../flue-review-sessions";
import { GhService } from "../../gh/gh";
import { PrCheckoutService } from "../../pr-checkout";
import { runtime } from "../../runtime";
import { PrContextService } from "../../state";

test("projects persisted Flue conversation history into chat messages", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "better-review-flue-test-"));
  process.env.BETTER_REVIEW_FLUE_DB_PATH = path.join(directory, "flue.sqlite");
  const { conversationHistoryToChatMessages } = await import("./flue-review");

  const messages = conversationHistoryToChatMessages({
    v: 1,
    conversationId: "conversation-1",
    offset: "offset-1",
    settlements: [],
    messages: [
      {
        id: "user-1",
        role: "user",
        metadata: { timestamp: "2026-07-13T12:00:00.000Z" },
        parts: [{ type: "text", text: "Review this PR", state: "done" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        metadata: { timestamp: "2026-07-13T12:00:01.000Z" },
        parts: [
          { type: "reasoning", text: "Inspecting", state: "done" },
          { type: "text", text: "Found one issue", state: "done" },
          {
            type: "dynamic-tool",
            toolName: "read",
            toolCallId: "tool-1",
            state: "output-available",
            input: { path: "src/index.ts" },
            output: { lines: 10 },
          },
        ],
      },
    ],
  });

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], {
    id: "user-1",
    role: "user",
    content: "Review this PR",
    reasoning: undefined,
    toolCalls: [],
    isStreaming: false,
    timestamp: Date.parse("2026-07-13T12:00:00.000Z"),
  });
  assert.equal(messages[1]?.content, "Found one issue");
  assert.equal(messages[1]?.reasoning, "Inspecting");
  assert.deepEqual(messages[1]?.toolCalls[0], {
    id: "tool-1",
    callId: "tool-1",
    tool: "read",
    status: "completed",
    input: { path: "src/index.ts" },
    title: "read",
    output: '{\n  "lines": 10\n}',
  });
});

test("only versioned Flue 2 review sessions remain selectable", () => {
  assert.equal(isFlueV2ReviewSession(undefined), false);
  assert.equal(isFlueV2ReviewSession({ runtimeVersion: 1 } as never), false);
  assert.equal(isFlueV2ReviewSession({ runtimeVersion: 2 } as never), true);
});

test("selectSession opens a saved revision without GitHub, checkout, or conversation access", async (t) => {
  const { flueReviewRouter } = await import("./flue-review");
  const prUrl = "https://github.com/owner/repo/pull/1";
  const saved: FlueReviewSession = {
    runtimeVersion: 2,
    id: "saved-review",
    prUrl: `${prUrl}/files`,
    owner: "owner",
    repo: "repo",
    number: 1,
    baseSha: "saved-base",
    headSha: "saved-head",
    reviewMode: "commit",
    commitSha: "saved-commit",
    worktreePath: "/no-longer-present",
    files: ["old.ts"],
    createdAt: 1,
    updatedAt: 1,
  };
  const original = structuredClone(saved);
  let registered = true;
  const writes: unknown[] = [];
  const item = { id: saved.id, headSha: saved.headSha, createdAt: 1, hidden: false };
  const store = {
    get: (id: string) => Effect.succeed(id === saved.id ? saved : null),
  } as unknown as FlueReviewSessionService;
  const context = {
    listSessions: (url: string) =>
      Effect.sync(() => {
        assert.equal(url, prUrl);
        return { sessions: registered ? [item] : [], activeSessionId: "newer-session" };
      }),
    setActiveSession: (url: string, id: string) =>
      Effect.sync(() => {
        writes.push(["active", url, id]);
      }),
    registerSession: (id: string, url: string) =>
      Effect.sync(() => {
        writes.push(["register", id, url]);
      }),
    setSessionScope: (id: string, scope: unknown) =>
      Effect.sync(() => {
        writes.push(["scope", id, scope]);
      }),
  } as unknown as PrContextService;
  // Deliberately provide no GitHub or checkout services and reject any Flue transport access.
  t.mock.method(runtime, "runPromise", <A>(effect: Effect.Effect<A, unknown, unknown>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(FlueReviewSessionService, store),
        Effect.provideService(PrContextService, context),
      ) as Effect.Effect<A, unknown>,
    ),
  );
  t.mock.method(Hono.prototype, "route", () => {
    throw new Error("Unexpected conversation access");
  });
  const caller = flueReviewRouter.createCaller({
    gh: null,
    opencode: null,
    diffCache: null,
    prContext: null,
  });
  const payload = await caller.selectSession({ prUrl: `${prUrl}/files`, sessionId: saved.id });
  assert.deepEqual(payload, {
    session: { id: saved.id, title: "PR Review: owner/repo#1" },
    sessions: [item],
    activeSessionId: saved.id,
    existing: true,
    headSha: "saved-head",
    sessionHeadSha: "saved-head",
    agentName: "pr-reviewer",
  });
  assert.deepEqual(saved, original);
  assert.deepEqual(writes, [
    ["active", prUrl, saved.id],
    ["register", saved.id, prUrl],
    ["scope", saved.id, { mode: "commit", commitSha: "saved-commit" }],
  ]);
  writes.length = 0;
  saved.prUrl = "https://github.com/owner/other/pull/1";
  await assert.rejects(caller.selectSession({ prUrl, sessionId: saved.id }), /not found for PR/);
  saved.prUrl = original.prUrl;
  registered = false;
  await assert.rejects(caller.selectSession({ prUrl, sessionId: saved.id }), /not found for PR/);
  await assert.rejects(
    caller.selectSession({ prUrl, sessionId: "missing" }),
    /V2 review session not found/,
  );
  Object.assign(saved, { runtimeVersion: 1 });
  await assert.rejects(
    caller.selectSession({ prUrl, sessionId: saved.id }),
    /V2 review session not found/,
  );
  assert.deepEqual(writes, []);
});

test("automatic reruns preserve results, deduplicate running work, and report stored revisions", async (t) => {
  const { flueReviewRouter, getOrCreateReviewSession } = await import("./flue-review");
  const prUrl = "https://github.com/owner/repo/pull/1";
  const input = { prUrl, prNumber: 1, repoOwner: "owner", repoName: "repo", files: [] };
  let headSha = "head-1";
  let baseSha = "base-1";
  let ghCalls = 0;
  let preparations = 0;
  let admissions = 0;
  const sessions = new Map<string, FlueReviewSession>();
  const histories = new Map<string, ReviewConversation>();
  const list = () => ({
    sessions: [...sessions.values()].map((s) => ({
      id: s.id,
      headSha: s.headSha,
      createdAt: s.createdAt,
      hidden: false,
    })),
    activeSessionId: [...sessions.keys()].at(-1) ?? null,
  });
  const gh = {
    getHeadSha: () =>
      Effect.sync(() => {
        ghCalls++;
        return headSha;
      }),
    getBaseSha: () => Effect.succeed(baseSha),
    getHeadRef: () => Effect.succeed("feature"),
    getBaseRef: () => Effect.succeed("main"),
    getDiff: () => Effect.succeed(""),
  } as unknown as GhService;
  const store = {
    get: (id: string) => Effect.sync(() => structuredClone(sessions.get(id) ?? null)),
    save: (session: FlueReviewSession) =>
      Effect.sync(() => {
        sessions.set(session.id, structuredClone(session));
      }),
    create: (session: FlueReviewSession) =>
      Effect.sync(() => {
        const created = { ...session, createdAt: sessions.size + 1, updatedAt: sessions.size + 1 };
        sessions.set(created.id, structuredClone(created));
        return created;
      }),
  } as unknown as FlueReviewSessionService;
  const context = {
    listSessions: () => Effect.sync(list),
    setCurrent: () => Effect.void,
    addSession: () => Effect.sync(list),
    setSessionScope: () => Effect.void,
    registerSession: () => Effect.void,
  } as unknown as PrContextService;
  const checkout = {
    prepare: () =>
      Effect.sync(() => {
        preparations++;
        return { worktreePath: "/test/worktree" };
      }),
  } as unknown as PrCheckoutService;
  const run = <A>(effect: Effect.Effect<A, unknown, unknown>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(GhService, gh),
        Effect.provideService(FlueReviewSessionService, store),
        Effect.provideService(PrContextService, context),
        Effect.provideService(PrCheckoutService, checkout),
      ) as Effect.Effect<A, unknown>,
    );
  t.mock.method(runtime, "runPromise", run);
  t.mock.method(Hono.prototype, "route", function (this: Hono) {
    return this.all("/agents/pr-reviewer/:id", (c) => {
      const id = c.req.param("id");
      if (c.req.method === "POST") {
        admissions++;
        const submissionId = `submission-${admissions}`;
        histories.set(id, {
          messages: [
            {
              role: "user",
              submissionId,
              parts: [{ type: "text", text: STRUCTURED_REVIEW_PROMPT }],
            },
          ],
          settlements: [],
        });
        return Response.json({ submissionId });
      }
      const history = histories.get(id);
      return history ? Response.json(history) : new Response(null, { status: 404 });
    });
  });
  const caller = flueReviewRouter.createCaller({
    gh: null,
    opencode: null,
    diffCache: null,
    prContext: null,
  });
  const settle = (id: string, outcome: "completed" | "failed") => {
    const history = histories.get(id)!;
    history.settlements.push({ submissionId: history.messages[0]!.submissionId!, outcome });
  };

  assert.deepEqual(await caller.automaticStatuses({ prUrls: [prUrl] }), {
    [prUrl]: { state: "none", sessionId: undefined, headSha: undefined },
  });
  assert.equal(ghCalls, 0);
  assert.equal(preparations, 0);

  const first = await caller.startAutomatic({ prUrl });
  settle(first.sessionId!, "completed");
  const priorSession = structuredClone(sessions.get(first.sessionId!)!);
  const priorHistory = structuredClone(histories.get(first.sessionId!)!);
  assert.equal((await caller.startAutomatic({ prUrl })).sessionId, first.sessionId);
  assert.equal(admissions, 1);

  const [second, duplicate] = await Promise.all([
    caller.startAutomatic({ prUrl, rerun: true }),
    caller.startAutomatic({ prUrl, rerun: true }),
  ]);
  assert.deepEqual(second, duplicate);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(second.headSha, "head-1");
  assert.equal(admissions, 2);
  assert.deepEqual(sessions.get(first.sessionId!), priorSession);
  assert.deepEqual(histories.get(first.sessionId!), priorHistory);

  headSha = "head-2";
  baseSha = "base-2";
  const beforeJoining = preparations;
  assert.equal((await caller.startAutomatic({ prUrl, rerun: true })).sessionId, second.sessionId);
  assert.equal(preparations, beforeJoining);
  assert.equal(admissions, 2);
  settle(second.sessionId!, "failed");
  const beforeStatus = ghCalls;
  assert.deepEqual((await caller.automaticStatuses({ prUrls: [prUrl] }))[prUrl], {
    state: "failed",
    sessionId: second.sessionId,
    headSha: "head-1",
  });
  assert.equal(ghCalls, beforeStatus);
  assert.equal(preparations, beforeJoining);

  // Failed same-revision reruns also retain the prior conversation.
  headSha = "head-1";
  baseSha = "base-1";
  const third = await caller.startAutomatic({ prUrl, rerun: true });
  assert.notEqual(third.sessionId, second.sessionId);
  assert.equal(histories.get(second.sessionId!)!.settlements[0]!.outcome, "failed");
  settle(third.sessionId!, "completed");

  headSha = "head-2";
  const revised = await caller.startAutomatic({ prUrl });
  assert.notEqual(revised.sessionId, third.sessionId);
  assert.equal(revised.headSha, headSha);
  settle(revised.sessionId!, "completed");

  baseSha = "base-2";
  const rebased = await run(getOrCreateReviewSession(input));
  assert.equal(rebased.existing, false);
  assert.equal(sessions.get(revised.sessionId!)!.baseSha, "base-1");
  assert.equal((await run(getOrCreateReviewSession(input))).existing, true);
  const commit = await run(
    getOrCreateReviewSession({ ...input, reviewMode: "commit", commitSha: "commit-1" }),
  );
  assert.equal(commit.existing, false);
  assert.equal(sessions.get(rebased.session.id)!.reviewMode, "full");
  const otherCommit = await run(
    getOrCreateReviewSession({ ...input, reviewMode: "commit", commitSha: "commit-2" }),
  );
  assert.equal(otherCommit.existing, false);
  assert.equal(sessions.get(commit.session.id)!.commitSha, "commit-1");
});
