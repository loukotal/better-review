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

test("native Pi tools preserve instructions, stream committed state, deduplicate input and retain revision history", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { models, model, provider } = fixtureModels([
    (input) => {
      assert.match(getCurrentSystemPrompt(input.messages), /Reviewed head: A/);
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
      assert.match(getCurrentSystemPrompt(input.messages), /Reviewed head: unrelated-B/);
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
  const next = { ...fixtureSession, headSha: "unrelated-B", worktreePath: "/fixture/B" };
  await engine.submit("Revalidate", "request-2", model, undefined, next);
  await engine.conversation.waitForIdle(context);
  const after = await engine.snapshot();
  assert.deepEqual(after.messages.slice(0, snapshot.messages.length), snapshot.messages);
  assert.equal(after.messages.at(-1)?.metadata.revision, "unrelated-B");
  assert.equal(after.messages.filter((message) => message.role === "user").length, 2);
});

test("SIGKILL mid-tool resumes the same durable submission without duplicating its input", async (t) => {
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
  await assert.rejects(engine.syncSession({ ...fixtureSession, headSha: "B" }), /running/);
  engine.resume();
  await engine.conversation.waitForIdle(context);
  const history = await engine.snapshot();
  assert.equal(history.running, false);
  assert.equal(history.settlements[0]?.outcome, "completed");
  assert.equal(history.messages.filter((message) => message.role === "user").length, 1);
  assert.ok(
    history.messages.some((message) =>
      message.parts.some(
        (part) => part.type === "dynamic-tool" && part.output?.includes("revision A"),
      ),
    ),
  );
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
  await engine.submit("Wait", "first", model);
  await running;
  await engine.abort();
  const after = await engine.snapshot();
  assert.equal(after.running, false);
  assert.equal(after.settlements[0]?.outcome, "aborted");
  await engine.submit("Retry", "second", model);
  await engine.conversation.waitForIdle(context);
  assert.equal((await engine.snapshot()).settlements.at(-1)?.outcome, "completed");
});
