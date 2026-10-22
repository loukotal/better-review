import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { AgentDoc } from "@earendil-works/pi-durable";

import type { ReviewModelIntent } from "@better-review/shared";

import type { ResolvedReviewModel } from "../model-resolution";
import { fixtureModels, fixtureSandbox, fixtureSession } from "./fixtures";
import { createReviewRuntime } from "./runtime";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const emptyHistory = (id: string) => ({
  sessionId: id,
  messages: [],
  settlements: [],
  running: false,
  compacting: false,
});

test("injected model/thinking tuple is owned before held session/checkout awaits and engine reuse resolves fresh intent", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-owned-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = fauxProvider({
    provider: "owned-model-fixture",
    models: [
      { id: "selected", reasoning: true },
      { id: "other", reasoning: true },
    ],
  });
  const actual: string[] = [];
  provider.setResponses(
    Array.from({ length: 2 }, () => (_input, _options, _state, model) => {
      actual.push(model.id);
      return fauxAssistantMessage("done");
    }),
  );
  const models = createModels();
  models.setProvider(provider.provider);
  const resolved: ResolvedReviewModel = {
    model: { provider: "owned-model-fixture", modelId: "selected" },
    thinkingLevel: "low",
  };
  const sessionEntered = gate<void>(),
    sessionRelease = gate<void>(),
    checkoutEntered = gate<void>(),
    checkoutRelease = gate<void>();
  let reads = 0,
    checkouts = 0,
    resolutions = 0;
  let saved = structuredClone(fixtureSession);
  const runtime = createReviewRuntime({
    directory,
    models,
    resolveModel() {
      resolutions++;
      return resolved;
    },
    readSession: async () => {
      if (++reads === 1) {
        sessionEntered.resolve();
        await sessionRelease.promise;
      }
      return saved;
    },
    ensureCheckout: async () => {
      if (++checkouts === 1) {
        checkoutEntered.resolve();
        await checkoutRelease.promise;
      }
    },
    sandbox: async (session) => fixtureSandbox(session.headSha),
    legacy: emptyHistory,
  });
  t.after(async () => {
    sessionRelease.resolve();
    checkoutRelease.resolve();
    await runtime.close();
  });
  const admission = runtime.admit(fixtureSession.id, "Owned tuple", "owned");
  assert.equal(resolutions, 1, "resolution happens synchronously before the first await");
  await sessionEntered.promise;
  resolved.model.provider = "mutated-provider";
  resolved.model.modelId = "other";
  resolved.thinkingLevel = "high";
  sessionRelease.resolve();
  await checkoutEntered.promise;
  saved.headSha = "changed-during-checkout";
  saved.files.push("new.ts");
  checkoutRelease.resolve();
  await admission;
  const engine = await runtime.get(fixtureSession.id);
  await engine.conversation.waitForIdle(context);
  const agent = await engine.harness.snapshot(AgentDoc, engine.conversation.id, context);
  assert.deepEqual(agent?.model, { provider: "owned-model-fixture", modelId: "selected" });
  assert.equal(
    agent?.thinkingLevel,
    "low",
    "runtime uses injected thinking, never global preference thinking",
  );
  assert.deepEqual(actual, ["selected"]);
  assert.equal(
    (await engine.snapshot()).messages[0].metadata.revision,
    fixtureSession.headSha,
    "session context was copied before checkout",
  );
  assert.equal(
    resolutions,
    1,
    "admission tuple also initializes the engine without another resolution",
  );
  resolved.model.provider = "owned-model-fixture";
  await runtime.admit(fixtureSession.id, "Fresh tuple", "fresh");
  await engine.conversation.waitForIdle(context);
  assert.equal(await runtime.get(fixtureSession.id), engine);
  assert.equal(resolutions, 2);
  assert.deepEqual(actual, ["selected", "other"]);
  assert.equal(
    (await engine.harness.snapshot(AgentDoc, engine.conversation.id, context))?.thinkingLevel,
    "high",
  );
});

for (const savedIntent of [true, false]) {
  test(`engine opening and pending automatic admission separately resolve ${savedIntent ? "saved intent" : "current defaults"} at their existing points`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-auto-resolution-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const provider = fauxProvider({
      provider: "auto-resolution-fixture",
      models: [
        { id: "opening", reasoning: true },
        { id: "automatic", reasoning: true },
      ],
    });
    const actual: string[] = [];
    provider.setResponses([
      (_input, _options, _state, model) => {
        actual.push(model.id);
        return fauxAssistantMessage("auto done");
      },
    ]);
    const models = createModels();
    models.setProvider(provider.provider);
    const intent: ReviewModelIntent = {
      providerId: "auto-resolution-fixture",
      modelId: "opening",
      variant: null,
      thinkingLevel: "low",
    };
    const session = {
      ...fixtureSession,
      automaticReview: {
        prompt: "Automatic",
        idempotencyKey: "auto",
        ...(savedIntent ? { model: intent } : {}),
      },
    };
    const calls: (ReviewModelIntent | undefined)[] = [];
    const resolved: ResolvedReviewModel = {
      model: { provider: "auto-resolution-fixture", modelId: "opening" },
      thinkingLevel: "low",
    };
    const acknowledgements: string[] = [];
    const runtime = createReviewRuntime({
      directory,
      models,
      readSession: async () => session,
      ensureCheckout: async () => {},
      sandbox: async () => fixtureSandbox("A"),
      resolveModel(value) {
        calls.push(value && structuredClone(value));
        return resolved;
      },
      legacy(id) {
        // Engine opening can yield while credential/current-model facts change.
        // The automatic submission must resolve afresh, not reuse that tuple.
        resolved.model.modelId = "automatic";
        resolved.thinkingLevel = "high";
        return emptyHistory(id);
      },
      admitted: async (_id, key, submissionId) => {
        acknowledgements.push(`${key}:${submissionId}`);
      },
    });
    t.after(() => runtime.close());
    assert.equal(calls.length, 0, "construction does not freeze current selection");
    const engine = await runtime.get(session.id);
    await engine.conversation.waitForIdle(context);
    assert.deepEqual(calls, [savedIntent ? intent : undefined, savedIntent ? intent : undefined]);
    const revision = (await engine.conversation.entries({}, 500, undefined, context)).items.find(
      (entry) => entry.kind === "review.revision",
    )!;
    const opening = await engine.harness.snapshotAsOf(
      AgentDoc,
      engine.conversation.id,
      revision.id,
      context,
    );
    assert.equal(opening?.model?.modelId, "opening");
    assert.equal(opening?.thinkingLevel, "low");
    const after = await engine.harness.snapshot(AgentDoc, engine.conversation.id, context);
    assert.equal(after?.model?.modelId, "automatic");
    assert.equal(after?.thinkingLevel, "high");
    assert.deepEqual(actual, ["automatic"]);
    assert.equal(acknowledgements.length, 1);
    assert.match(acknowledgements[0], /^auto:\d+$/);
    assert.equal(await runtime.get(session.id), engine);
    assert.equal(
      calls.length,
      2,
      "engine reuse does not reinitialize or resubmit pending automatic work",
    );
  });

  test(`manual admission initializes with its tuple but pending automatic work resolves its own ${savedIntent ? "saved intent" : "current default"}`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-manual-auto-model-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const provider = fauxProvider({
      provider: "manual-auto-fixture",
      models: [
        { id: "manual", reasoning: true },
        { id: "automatic", reasoning: true },
      ],
    });
    const actual: string[] = [];
    provider.setResponses(
      Array.from({ length: 2 }, () => (_input, _options, _state, model) => {
        actual.push(model.id);
        return fauxAssistantMessage("done");
      }),
    );
    const models = createModels();
    models.setProvider(provider.provider);
    const automatic: ReviewModelIntent = {
      providerId: "manual-auto-fixture",
      modelId: "automatic",
      variant: null,
      thinkingLevel: "high",
    };
    const manual: ReviewModelIntent = { ...automatic, modelId: "manual", thinkingLevel: "low" };
    const session = {
      ...fixtureSession,
      automaticReview: {
        prompt: "Automatic",
        idempotencyKey: "auto",
        ...(savedIntent ? { model: automatic } : {}),
      },
    };
    const outerRead = gate<void>(),
      releaseOuterRead = gate<void>();
    let reads = 0;
    const calls: (ReviewModelIntent | undefined)[] = [];
    const runtime = createReviewRuntime({
      directory,
      models,
      resolveModel(value) {
        calls.push(value && structuredClone(value));
        const selected = value ?? automatic;
        return {
          model: { provider: selected.providerId, modelId: selected.modelId },
          thinkingLevel: selected.thinkingLevel,
        };
      },
      readSession: async () => {
        if (++reads === 2) {
          outerRead.resolve();
          await releaseOuterRead.promise;
        }
        return session;
      },
      ensureCheckout: async () => {},
      sandbox: async () => fixtureSandbox("A"),
      legacy: emptyHistory,
    });
    t.after(async () => {
      releaseOuterRead.resolve();
      await runtime.close();
    });
    const admission = runtime.admit(session.id, "Manual", "manual", manual);
    await outerRead.promise;
    const engine = await runtime.get(session.id);
    await engine.conversation.waitForIdle(context);
    assert.deepEqual(calls, [manual, savedIntent ? automatic : undefined]);
    const revision = (await engine.conversation.entries({}, 500, undefined, context)).items.find(
      (entry) => entry.kind === "review.revision",
    )!;
    const opening = await engine.harness.snapshotAsOf(
      AgentDoc,
      engine.conversation.id,
      revision.id,
      context,
    );
    assert.equal(opening?.model?.modelId, "manual");
    assert.equal(opening?.thinkingLevel, "low");
    assert.deepEqual(actual, ["automatic"]);
    releaseOuterRead.resolve();
    await admission;
    await engine.conversation.waitForIdle(context);
    assert.deepEqual(actual, ["automatic", "manual"]);
    assert.equal(
      (await engine.harness.snapshot(AgentDoc, engine.conversation.id, context))?.thinkingLevel,
      "low",
    );
    assert.equal(calls.length, 2);
  });
}

test("admission captures the selected model before async session and checkout work", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-admission-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = fauxProvider({
    provider: "admission-fixture",
    models: [{ id: "selected" }, { id: "other" }],
  });
  const actual: string[] = [];
  provider.setResponses(
    Array.from({ length: 2 }, () => (_input, _options, _state, model) => {
      actual.push(model.id);
      return fauxAssistantMessage("done");
    }),
  );
  const models = createModels();
  models.setProvider(provider.provider);
  let selected = { provider: "admission-fixture", modelId: "selected" };
  let savedSession = fixtureSession;
  const runtime = createReviewRuntime({
    directory,
    models,
    resolveModel: (intent) => {
      if (!intent) return { model: selected, thinkingLevel: "medium" };
      if (
        intent.providerId !== "admission-fixture" ||
        !["selected", "other"].includes(intent.modelId)
      )
        throw new Error("Requested model not found. Choose a model again.");
      return {
        model: { provider: intent.providerId, modelId: intent.modelId },
        thinkingLevel: intent.thinkingLevel,
      };
    },
    readSession: async () => savedSession,
    ensureCheckout: async () => {},
    sandbox: async () => fixtureSandbox("A"),
    legacy: () => ({
      sessionId: fixtureSession.id,
      messages: [],
      settlements: [],
      running: false,
      compacting: false,
    }),
  });
  t.after(() => runtime.close());
  const receipt = runtime.admit(fixtureSession.id, "Review", "captured-selection");
  selected = { ...selected, modelId: "other" };
  await receipt;
  await (await runtime.get(fixtureSession.id)).conversation.waitForIdle(context);
  assert.deepEqual(actual, ["selected"]);
  const intent = {
    providerId: "admission-fixture",
    modelId: "selected",
    variant: null,
    thinkingLevel: "medium",
  };
  const post = (model: unknown, requestId: string, body = "Captured before browser preparation") =>
    runtime.app.request(`/sessions/${fixtureSession.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, requestId, model }),
    });
  assert.equal((await post(intent, "explicit-model")).status, 200);
  await (await runtime.get(fixtureSession.id)).conversation.waitForIdle(context);
  assert.deepEqual(
    actual,
    ["selected", "selected"],
    "explicit model beats a different global selection at HTTP admission",
  );
  assert.equal(
    (await post(intent, "explicit-model")).status,
    200,
    "identical intent replays its receipt",
  );
  for (const [changed, body] of [
    [intent, "Changed confidential body"],
    [{ ...intent, modelId: "other" }, "Captured before browser preparation"],
    [{ ...intent, thinkingLevel: "high" }, "Captured before browser preparation"],
  ] as const) {
    const response = await post(changed, "explicit-model", body);
    assert.equal(response.status, 409);
    const result = await response.json();
    assert.equal(result.error.code, "REVIEW_REQUEST_CONFLICT");
    assert.equal(result.error.message.includes(body), false);
    assert.equal(result.error.stack, undefined);
  }
  savedSession = { ...fixtureSession, headSha: "B" };
  assert.equal(
    (await post(intent, "explicit-model")).status,
    409,
    "changed review context cannot reuse a receipt",
  );
  savedSession = fixtureSession;
  assert.equal((await post({ ...intent, modelId: "removed" }, "unavailable-model")).status, 404);
  assert.equal((await post({ modelId: "selected" }, "invalid-model")).status, 400);
  assert.equal(
    provider.state.callCount,
    2,
    "invalid or unavailable intent must not invoke the global default",
  );
});

test("normal HTTP review transport admits durable work, supports reconnect snapshots, and rejects unknown sessions", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { models, model } = fixtureModels();
  const runtime = createReviewRuntime({
    directory,
    models,
    resolveModel: () => ({ model, thinkingLevel: "off" }),
    readSession: async (id) => (id === fixtureSession.id ? fixtureSession : null),
    ensureCheckout: async () => {},
    sandbox: async (session) => fixtureSandbox(session.headSha),
    legacy: (id) => ({
      sessionId: id,
      messages: [],
      settlements: [],
      running: false,
      compacting: false,
    }),
  });
  t.after(() => runtime.close());
  const request = () =>
    runtime.app.request(`/sessions/${fixtureSession.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Review", requestId: "one" }),
    });
  const first = await (await request()).json();
  assert.deepEqual(await (await request()).json(), first);
  await (await runtime.get(fixtureSession.id)).conversation.waitForIdle(context);
  const response = await runtime.app.request(`/sessions/${fixtureSession.id}`);
  const snapshot = await response.json();
  assert.equal(snapshot.running, false);
  assert.equal(
    snapshot.messages.filter((message: { role: string }) => message.role === "user").length,
    1,
  );
  assert.equal(snapshot.settlements[0].outcome, "completed");
  const engine = await runtime.get(fixtureSession.id);
  await engine.conversation.commit(
    (tx) =>
      tx.createSubmission({
        conversationId: engine.conversation.id,
        type: "input",
        status: "unanswered",
        reason: "aborted",
        requestId: "legacy-unverifiable",
      }),
    context,
  );
  const legacy = await runtime.app.request(`/sessions/${fixtureSession.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "Do not execute", requestId: "legacy-unverifiable" }),
  });
  assert.equal(legacy.status, 409);
  const legacyError = await legacy.json();
  assert.equal(legacyError.error.code, "REVIEW_REQUEST_CONFLICT");
  assert.match(legacyError.error.message, /legacy.*verifiable/);
  assert.equal(legacyError.error.stack, undefined);
  const stream = await runtime.app.request(`/sessions/${fixtureSession.id}/events`);
  const reader = stream.body!.getReader();
  const chunk = await reader.read();
  assert.match(new TextDecoder().decode(chunk.value), /event: snapshot/);
  await reader.cancel();
  assert.equal((await runtime.app.request("/sessions/missing")).status, 404);
  assert.equal(
    (
      await runtime.app.request(`/sessions/${fixtureSession.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    400,
  );
});
