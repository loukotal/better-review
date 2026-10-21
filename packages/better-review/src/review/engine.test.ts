import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { LiveDoc } from "@earendil-works/pi-durable";

import type { ReviewSnapshot } from "@better-review/shared";

import { openReviewEngine } from "./engine";
import { crashEngine, fixtureModels, fixtureSandbox, fixtureSession } from "./fixtures";
import { reviewMetrics } from "./metrics";

test("fresh and reopened reviews execute the explicitly requested model, not the old conversation default", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-review-model-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = fauxProvider({
    provider: "model-fixture",
    models: [{ id: "gpt-5.5" }, { id: "selected-model" }],
  });
  const actual: string[] = [];
  provider.setResponses(
    Array.from({ length: 3 }, () => (_input, _options, _state, model) => {
      actual.push(model.id);
      return fauxAssistantMessage("done");
    }),
  );
  const models = createModels();
  models.setProvider(provider.provider);
  const oldModel = { provider: "model-fixture", modelId: "gpt-5.5" };
  const selected = { provider: "model-fixture", modelId: "selected-model" };
  const options = {
    database: path.join(dir, "review.sqlite"),
    session: fixtureSession,
    models,
    model: oldModel,
    sandbox: async () => fixtureSandbox("A"),
  };
  let engine = await openReviewEngine(options);
  try {
    await engine.submit("Fresh", "fresh", selected);
    await engine.conversation.waitForIdle(context);
    assert.deepEqual(actual, ["selected-model"]);
    await engine.submit("Old selection", "old", oldModel);
    await engine.conversation.waitForIdle(context);
    await engine.close();
    engine = await openReviewEngine(options);
    engine.resume();
    await engine.conversation.waitForIdle(context);
    await engine.submit("Continue with explicit selection", "reopened", selected);
    await engine.conversation.waitForIdle(context);
    assert.deepEqual(actual, ["selected-model", "gpt-5.5", "selected-model"]);
    assert.equal((await engine.snapshot()).settlements.at(-1)?.outcome, "completed");
    await engine.submit("Unavailable", "missing", { ...selected, modelId: "removed" });
    await engine.conversation.waitForIdle(context);
    const failed = (await engine.snapshot()).settlements.at(-1);
    assert.equal(failed?.outcome, "failed");
    assert.match(failed?.error ?? "", /model|removed/i);
    assert.equal(provider.state.callCount, 3, "unavailable model must not call the default");
  } finally {
    await engine.close();
  }
});

test("native Pi tools preserve instructions, stream committed state, deduplicate input and retain revision history", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { models, model, provider } = fixtureModels([
    (input) => {
      assert.ok(
        getCurrentSystemPrompt(input.messages).includes(`Reviewed head: ${fixtureSession.headSha}`),
      );
      assert.ok(getCurrentTools(input.messages).some((tool) => tool.name === "read"));
      return fauxAssistantMessage(fauxToolCall("read", { path: "source.ts" }), {
        stopReason: "toolUse",
      });
    },
    (input) => {
      assert.match(JSON.stringify(input.messages), /revision A/);
      return fauxAssistantMessage("Finding on A");
    },
    (input) => {
      assert.match(JSON.stringify(input.messages), /Finding on A/);
      assert.ok(
        getCurrentSystemPrompt(input.messages).includes(`Reviewed head: ${"b".repeat(40)}`),
      );
      return fauxAssistantMessage(fauxToolCall("read", { path: "source.ts" }), {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage("Resolved on B"),
  ]);
  const engine = await openReviewEngine({
    database: path.join(dir, "review.sqlite"),
    session: fixtureSession,
    models,
    model,
    sandbox: async (session) => fixtureSandbox(session.headSha),
  });
  t.after(() => engine.close());
  const first = await engine.submit("Review", "request-1", model);
  await engine.conversation.waitForIdle(context);
  const snapshot = await engine.snapshot();
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.settlements[0]?.outcome, "completed");
  assert.ok(
    snapshot.messages.some((message) =>
      message.parts.some(
        (part) => part.type === "dynamic-tool" && part.output?.includes("revision A"),
      ),
    ),
  );
  assert.deepEqual(await engine.submit("Review", "request-1", model), first);
  assert.equal(provider.state.callCount, 2);
  await engine.compact();
  await engine.conversation.waitForIdle(context);
  assert.deepEqual((await engine.snapshot()).messages, snapshot.messages);
  const next = { ...fixtureSession, headSha: "b".repeat(40), worktreePath: "/fixture/B" };
  await engine.submit("Revalidate", "request-2", model, undefined, next);
  await engine.conversation.waitForIdle(context);
  const after = await engine.snapshot();
  assert.deepEqual(after.messages.slice(0, snapshot.messages.length), snapshot.messages);
  assert.equal(after.messages.at(-1)?.metadata.revision, "b".repeat(40));
  assert.equal(after.messages.filter((message) => message.role === "user").length, 2);
});

test("SIGKILL mid-tool resumes the same durable submission without duplicating its input", async (t) => {
  const metricBefore = reviewMetrics();
  const dir = await mkdtemp(path.join(tmpdir(), "pi-review-crash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const database = path.join(dir, "review.sqlite");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./fixtures.ts", import.meta.url)),
      "--crash-worker",
      database,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let error = "";
  child.stderr.on("data", (chunk) => {
    error += chunk;
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.includes("DURABLE_READ_READY")) child.kill("SIGKILL");
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (_code, signal) => {
      clearTimeout(timeout);
      if (output.includes("DURABLE_READ_READY") && signal === "SIGKILL") resolve();
      else reject(new Error(error || "worker never reached its tool"));
    });
  });
  const engine = await crashEngine(database);
  t.after(() => engine.close());
  assert.equal((await engine.snapshot()).running, true);
  assert.equal(
    reviewMetrics()["review.model.round_trips"]?.total,
    metricBefore["review.model.round_trips"]?.total,
    "hydrated pre-crash model messages are not counted again",
  );
  await assert.rejects(engine.syncSession({ ...fixtureSession, headSha: "B" }), /running/);
  engine.resume();
  engine.resume();
  await engine.conversation.waitForIdle(context);
  await new Promise((resolve) => setImmediate(resolve));
  const history = await engine.snapshot();
  assert.equal(history.running, false);
  assert.equal(history.settlements[0]?.outcome, "completed");
  assert.equal(history.messages.filter((message) => message.role === "user").length, 1);
  assert.equal(
    (reviewMetrics()["review.resume.duration.ms"]?.count ?? 0) -
      (metricBefore["review.resume.duration.ms"]?.count ?? 0),
    1,
    "multiple resume calls report a single process-local recovery interval",
  );
  assert.equal(
    reviewMetrics()["review.duration.ms"]?.count,
    metricBefore["review.duration.ms"]?.count,
    "resuming does not fabricate a full review duration",
  );
  assert.ok(
    history.messages.some((message) =>
      message.parts.some(
        (part) => part.type === "dynamic-tool" && part.output?.includes("revision A"),
      ),
    ),
  );
});

test("process-local review metrics count new commits once and exclude reopening and request retries", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-review-metrics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const answer = fauxAssistantMessage("done");
  const { models, model } = fixtureModels([
    fauxAssistantMessage(fauxToolCall("read", { path: "source.ts" }), { stopReason: "toolUse" }),
    answer,
  ]);
  const options = {
    database: path.join(dir, "review.sqlite"),
    session: fixtureSession,
    models,
    model,
    sandbox: async () => fixtureSandbox("A"),
  };
  const engine = await openReviewEngine(options);
  const before = reviewMetrics();
  try {
    await engine.submit("Review", "same-request", model);
    await engine.conversation.waitForIdle(context);
    await new Promise((resolve) => setImmediate(resolve));
    const after = reviewMetrics();
    const entries = await engine.conversation.entries({}, 500, undefined, context);
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    for (const entry of entries.items) {
      for (const message of entry.model ?? []) {
        if (entry.kind !== "pi.assistant" || message.role !== "assistant") continue;
        for (const key of Object.keys(usage) as Array<keyof typeof usage>)
          usage[key] += message.usage[key];
      }
    }
    assert.ok(usage.totalTokens > 0);
    for (const [name, expected] of [
      ["review.model.round_trips", 2],
      ["review.tool.round_trips", 1],
      ["review.tokens.input", usage.input],
      ["review.tokens.output", usage.output],
      ["review.tokens.cache_read", usage.cacheRead],
      ["review.tokens.cache_write", usage.cacheWrite],
      ["review.tokens.total", usage.totalTokens],
    ] as const)
      assert.equal((after[name]?.total ?? 0) - (before[name]?.total ?? 0), expected, name);
    assert.equal(
      (after["review.duration.ms"]?.count ?? 0) - (before["review.duration.ms"]?.count ?? 0),
      1,
    );
    await engine.submit("Review", "same-request", model);
    await engine.snapshot();
    await engine.snapshot();
    for (const name of Object.keys(after).filter((name) => name.startsWith("review."))) {
      assert.deepEqual(reviewMetrics()[name], after[name]);
    }
  } finally {
    await engine.close();
  }
  const settled = reviewMetrics();
  const reopened = await openReviewEngine(options);
  try {
    reopened.resume();
    await reopened.conversation.waitForIdle(context);
    await new Promise((resolve) => setImmediate(resolve));
    for (const name of Object.keys(settled).filter((name) => name.startsWith("review."))) {
      assert.deepEqual(reviewMetrics()[name], settled[name], name);
    }
  } finally {
    await reopened.close();
  }
});

test("concurrent retries attach only one duration observer to a submission", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-review-concurrent-metrics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { models, model, provider } = fixtureModels([fauxAssistantMessage("done")]);
  const engine = await openReviewEngine({
    database: path.join(dir, "review.sqlite"),
    session: fixtureSession,
    models,
    model,
    sandbox: async () => fixtureSandbox("A"),
  });
  t.after(() => engine.close());
  const before = reviewMetrics()["review.duration.ms"]?.count ?? 0;
  const receipts = await Promise.all([
    engine.submit("Review", "concurrent-request", model),
    engine.submit("Review", "concurrent-request", model),
  ]);
  assert.deepEqual(receipts[0], receipts[1]);
  await engine.conversation.waitForIdle(context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.state.callCount, 1);
  assert.equal((reviewMetrics()["review.duration.ms"]?.count ?? 0) - before, 1);
});

test("abort stops an active tool and allows a new submission", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-review-abort-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { models, model } = fixtureModels([
    fauxAssistantMessage(fauxToolCall("bash", { command: "wait" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Retry complete"),
  ]);
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const vm = fixtureSandbox("A");
  const exec = vm.exec;
  vm.exec = async (...args) => {
    started();
    return exec(...args);
  };
  const engine = await openReviewEngine({
    database: path.join(dir, "review.sqlite"),
    session: fixtureSession,
    models,
    model,
    sandbox: async () => vm,
  });
  t.after(() => engine.close());
  const durationsBefore = reviewMetrics()["review.duration.ms"]?.count ?? 0;
  await engine.submit("Wait", "first", model);
  await running;
  await engine.abort();
  const after = await engine.snapshot();
  assert.equal(after.running, false);
  assert.equal(after.settlements[0]?.outcome, "aborted");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((reviewMetrics()["review.duration.ms"]?.count ?? 0) - durationsBefore, 1);
  await engine.submit("Retry", "second", model);
  await engine.conversation.waitForIdle(context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((reviewMetrics()["review.duration.ms"]?.count ?? 0) - durationsBefore, 2);
  assert.equal((await engine.snapshot()).settlements.at(-1)?.outcome, "completed");
});

test("late tool results replace only their original slot without mutating prior snapshots or live overlays", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-review-projection-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { models, model } = fixtureModels([]);
  const options = {
    database: path.join(dir, "review.sqlite"),
    session: fixtureSession,
    models,
    model,
    sandbox: async () => fixtureSandbox("A"),
  };
  let engine = await openReviewEngine(options);
  try {
    const call = fauxToolCall("read", { path: "source.ts" });
    await engine.conversation.commit(async (tx) => {
      await tx.appendEntry(engine.conversation.id, {
        kind: "pi.assistant",
        model: [fauxAssistantMessage(call, { stopReason: "toolUse" })],
      });
      await tx.appendEntry(engine.conversation.id, {
        kind: "pi.assistant",
        model: [fauxAssistantMessage("An unrelated later message")],
      });
    }, context);
    const original = await engine.snapshot();
    const serialized = JSON.stringify(original);
    const originalTool = original.messages[0]!.parts[0]!;
    assert.equal(originalTool.type, "dynamic-tool");

    await engine.conversation.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, engine.conversation.id);
      live.tools = [{ callId: call.id, name: "read", status: "running", output: "partial" }];
      const { role, api, provider, model, stopReason, timestamp, usage } =
        fauxAssistantMessage("Still thinking");
      live.generation = {
        attempt: 1,
        message: {
          role,
          api,
          provider,
          model,
          stopReason,
          timestamp,
          usage,
          content: [{ type: "text", text: "Still thinking" }],
        },
      };
    }, context);
    const partial = await engine.snapshot();
    assert.equal(partial.messages.length, 3);
    assert.equal(partial.messages[1], original.messages[1]);
    assert.deepEqual(partial.messages[0]!.parts[0], { ...originalTool, output: "partial" });
    assert.equal(partial.messages[2]!.metadata.revision, fixtureSession.headSha);
    assert.equal(JSON.stringify(original), serialized);

    await engine.conversation.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, engine.conversation.id);
      delete live.generation;
      delete live.tools;
      await tx.appendEntry(engine.conversation.id, {
        kind: "review.revision",
        data: { ref: "B" },
      });
      await tx.appendEntry(engine.conversation.id, {
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: call.id,
            toolName: "read",
            content: [{ type: "text", text: "late failure" }],
            isError: true,
            timestamp: 1700000000000,
          },
        ],
      });
      await tx.appendEntry(engine.conversation.id, {
        kind: "pi.assistant",
        model: [fauxAssistantMessage("After revision")],
      });
    }, context);
    const completed = await engine.snapshot();
    assert.equal(completed.messages.length, 3);
    assert.notEqual(completed.messages[0], original.messages[0]);
    assert.equal(completed.messages[1], original.messages[1]);
    assert.equal(completed.messages[0]!.metadata.revision, fixtureSession.headSha);
    assert.equal(completed.messages[2]!.metadata.revision, "B");
    assert.deepEqual(completed.messages[0]!.parts[0], {
      ...originalTool,
      state: "output-error",
      output: "late failure",
      errorText: "late failure",
    });
    assert.equal(JSON.stringify(original), serialized);
    assert.deepEqual(partial.messages[0]!.parts[0], { ...originalTool, output: "partial" });
    assert.equal(await engine.snapshot(), completed);
    await engine.close();
    engine = await openReviewEngine(options);
    assert.deepEqual(await engine.snapshot(), completed);
  } finally {
    await engine.close();
  }
});

test("imported revisions remain original through appends, compaction and reopening", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-review-import-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacy: ReviewSnapshot = {
    sessionId: fixtureSession.id,
    running: false,
    compacting: false,
    revision: fixtureSession.headSha,
    usage: { input: 0, output: 0, cost: 0 },
    settlements: [{ submissionId: "imported", outcome: "completed" }],
    messages: [
      {
        id: "imported-A",
        role: "user",
        metadata: { timestamp: new Date(1).toISOString() },
        parts: [{ type: "text", text: "Historical question" }],
      },
      {
        id: "imported-explicit",
        role: "assistant",
        metadata: { timestamp: new Date(2).toISOString(), revision: "explicit" },
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "imported-call",
            toolName: "read",
            input: { path: "source.ts" },
            state: "output-available",
            output: "Historical result",
          },
        ],
      },
    ],
  };
  const { models, model } = fixtureModels([fauxAssistantMessage("New answer")]);
  const options = {
    database: path.join(dir, "review.sqlite"),
    session: {
      ...fixtureSession,
      revisionHistory: [
        {
          headSha: "original",
          baseSha: fixtureSession.baseSha,
          commitSha: null,
          pulledAt: 1,
        },
      ],
    },
    models,
    model,
    legacy,
    sandbox: async () => fixtureSandbox("A"),
  };
  let engine = await openReviewEngine(options);
  try {
    const imported = await engine.snapshot();
    assert.equal(imported.messages[0]!.metadata.revision, "original");
    assert.equal(imported.messages[1]!.metadata.revision, "explicit");
    await engine.submit("Continue", "new", model);
    await engine.conversation.waitForIdle(context);
    const appended = await engine.snapshot();
    assert.equal(appended.messages[0], imported.messages[0]);
    assert.equal(appended.messages[1], imported.messages[1]);
    assert.equal(appended.messages.at(-1)!.metadata.revision, fixtureSession.headSha);
    assert.equal(appended.messages.at(-1)!.submissionId, appended.settlements[1]!.submissionId);
    await engine.compact();
    await engine.conversation.waitForIdle(context);
    const compacted = await engine.snapshot();
    for (let i = 0; i < appended.messages.length; i++)
      assert.equal(compacted.messages[i], appended.messages[i]);
    await engine.close();
    engine = await openReviewEngine(options);
    assert.deepEqual((await engine.snapshot()).messages, compacted.messages);
    assert.deepEqual((await engine.snapshot()).settlements, compacted.settlements);
  } finally {
    await engine.close();
  }
});

test("empty-history snapshots invalidate for live-only commits and session notifications use the committed revision", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-review-empty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { models, model } = fixtureModels([]);
  const engine = await openReviewEngine({
    database: path.join(dir, "review.sqlite"),
    session: fixtureSession,
    models,
    model,
    sandbox: async () => fixtureSandbox("A"),
  });
  t.after(() => engine.close());
  const empty = await engine.snapshot();
  assert.equal(empty.messages.length, 0);
  await engine.conversation.commit(async (tx) => {
    const { role, api, provider, model, stopReason, timestamp, usage } =
      fauxAssistantMessage("Live only");
    (await tx.doc(LiveDoc, engine.conversation.id)).generation = {
      attempt: 1,
      message: {
        role,
        api,
        provider,
        model,
        stopReason,
        timestamp,
        usage,
        content: [{ type: "text", text: "Live only" }],
      },
    };
  }, context);
  const live = await engine.snapshot();
  assert.equal(live.messages.length, 1);
  await engine.conversation.commit(async (tx) => {
    delete (await tx.doc(LiveDoc, engine.conversation.id)).generation;
  }, context);
  assert.equal((await engine.snapshot()).messages.length, 0);
  assert.equal(live.messages.length, 1);
  const queued = await engine.conversation.commit(
    (tx) =>
      tx.createSubmission({
        conversationId: engine.conversation.id,
        type: "input",
        status: "queued",
      }),
    context,
  );
  const running = await engine.snapshot();
  assert.equal(running.running, true);
  assert.equal(running.messages.length, 0);
  await engine.conversation.commit(async (tx) => {
    tx.settleSubmission(queued.id, { status: "unanswered", reason: "aborted" });
  }, context);
  const settled = await engine.snapshot();
  assert.equal(settled.running, false);
  assert.deepEqual(settled.settlements, [
    { submissionId: String(queued.id), outcome: "aborted", error: '"aborted"' },
  ]);
  assert.equal(running.running, true);
  const observed: Promise<ReviewSnapshot>[] = [];
  const stop = engine.subscribe(() => {
    observed.push(engine.snapshot());
  });
  try {
    await engine.syncSession({ ...fixtureSession, headSha: "B" });
    const notifications = await Promise.all(observed);
    assert.ok(notifications.length > 0);
    assert.ok(notifications.every((snapshot) => snapshot.revision === "B"));
    assert.equal((await engine.snapshot()).revision, "B");
  } finally {
    stop();
  }
});

test("real Pi compaction and reset head publications retain the full review transcript across reopening", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-review-heads-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { models, model, provider } = fixtureModels([fauxAssistantMessage("Compacted summary")]);
  const options = {
    database: path.join(dir, "review.sqlite"),
    session: fixtureSession,
    models,
    model,
    sandbox: async () => fixtureSandbox("A"),
  };
  let engine = await openReviewEngine(options);
  try {
    await engine.conversation.commit(async (tx) => {
      for (let i = 0; i < 2; i++)
        await tx.appendEntry(engine.conversation.id, {
          kind: "pi.assistant",
          model: [fauxAssistantMessage(`${i}: ${"checkpoint ".repeat(12000)}`)],
        });
    }, context);
    const before = await engine.snapshot();
    await engine.compact();
    await engine.conversation.waitForIdle(context);
    assert.equal(
      provider.state.callCount,
      1,
      "must actually summarize, not exercise a no-op compaction",
    );
    const entries = await engine.conversation.entries({}, 100, undefined, context);
    assert.ok(
      entries.items.some((entry) => entry.kind === "pi.compaction" && entry.head !== undefined),
    );
    const compacted = await engine.snapshot();
    assert.deepEqual(compacted.messages, before.messages);
    assert.equal(compacted.messages[0], before.messages[0]);
    await engine.conversation.reset("New model context", context);
    const reset = await engine.snapshot();
    assert.deepEqual(reset.messages, before.messages);
    const resetEntries = await engine.conversation.entries({}, 100, undefined, context);
    assert.ok(
      resetEntries.items.some((entry) => entry.kind === "pi.reset" && entry.head === entry.id),
    );
    await engine.close();
    engine = await openReviewEngine(options);
    assert.deepEqual((await engine.snapshot()).messages, before.messages);
  } finally {
    await engine.close();
  }
});
