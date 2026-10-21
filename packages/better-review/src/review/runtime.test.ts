import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

import { fixtureModels, fixtureSandbox, fixtureSession } from "./fixtures";
import { createReviewRuntime } from "./runtime";

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
    model: () => selected,
    resolveModelIntent: (intent) => {
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
    model: () => model,
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
