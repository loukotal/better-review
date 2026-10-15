import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";

import { openReviewEngine } from "./engine";
import { crashEngine, fixtureModels, fixtureSandbox, fixtureSession } from "./fixtures";
import { reviewMetrics } from "./metrics";

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
