import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";

import {
  AdmissionIntentDoc,
  admissionFingerprint,
  ReviewAdmissionConflict,
} from "./admission-intent";
import { openReviewEngine } from "./engine";
import { fixtureModels, fixtureSandbox, fixtureSession } from "./fixtures";

test("receipt replay compares exact immutable intent across reopening and normalizes omitted thinking to off", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-intent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { models, model, provider } = fixtureModels([fauxAssistantMessage("done")]);
  const options = {
    database: path.join(directory, "review.sqlite"),
    session: fixtureSession,
    models,
    model,
    sandbox: async () => fixtureSandbox("A"),
  };
  let engine = await openReviewEngine(options);
  const body = "Review exact private input\n";
  const key = "immutable-request";
  try {
    const receipt = await engine.submit(body, key, model);
    await engine.conversation.waitForIdle(context);
    const claimed = await engine.harness.snapshot(
      AdmissionIntentDoc,
      engine.conversation.id,
      key,
      context,
    );
    assert.match(claimed?.fingerprint ?? "", /^[a-f0-9]{64}$/);
    await engine.close();
    engine = await openReviewEngine({ ...options, thinkingLevel: "high" });
    assert.deepEqual(
      await engine.submit(body, key, model, "off", { ...fixtureSession, updatedAt: 900 }),
      receipt,
    );
    assert.deepEqual(await engine.submit(body, key, model), receipt);
    for (const attempt of [
      () => engine.submit(body.trim(), key, model),
      () => engine.submit(body, key, { ...model, provider: "another-provider" }),
      () => engine.submit(body, key, { ...model, modelId: "another-model" }),
      () => engine.submit(body, key, model, "high"),
      () => engine.submit(body, key, model, "off", { ...fixtureSession, headSha: "B" }),
      () => engine.submit(body, key, model, "off", { ...fixtureSession, files: ["other.ts"] }),
      () =>
        engine.submit(body, key, model, "off", {
          ...fixtureSession,
          reviewMode: "commit",
          commitSha: "A",
        }),
    ]) {
      await assert.rejects(attempt(), (error) => {
        assert.ok(error instanceof ReviewAdmissionConflict);
        assert.equal(error.reason, "intent_changed");
        assert.equal(error.message.includes(body.trim()), false);
        return true;
      });
    }
    assert.deepEqual(
      await engine.harness.snapshot(AdmissionIntentDoc, engine.conversation.id, key, context),
      claimed,
    );
    assert.equal(provider.state.callCount, 1);
    assert.equal(
      (await engine.snapshot()).messages.filter((message) => message.role === "user").length,
      1,
    );
  } finally {
    await engine.close();
  }
});

test("concurrent same-key body, model, and thinking conflicts admit exactly one immutable winner", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-intent-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { models, model, provider } = fixtureModels(
    Array.from({ length: 3 }, () => fauxAssistantMessage("done")),
  );
  const engine = await openReviewEngine({
    database: path.join(directory, "review.sqlite"),
    session: fixtureSession,
    models,
    model,
    sandbox: async () => fixtureSandbox("A"),
  });
  t.after(() => engine.close());
  for (const change of ["body", "model", "thinking"]) {
    const key = `race-${change}`;
    const outcomes = await Promise.allSettled([
      engine.submit("Original", key, model, "off"),
      engine.submit(
        change === "body" ? "Changed" : "Original",
        key,
        change === "model" ? { ...model, modelId: "other" } : model,
        change === "thinking" ? "high" : "off",
      ),
    ]);
    assert.equal(outcomes[0]?.status, "fulfilled");
    const rejected = outcomes[1];
    assert.equal(rejected?.status, "rejected");
    if (rejected?.status === "rejected")
      assert.ok(rejected.reason instanceof ReviewAdmissionConflict);
    await engine.conversation.waitForIdle(context);
    if (outcomes[0]?.status === "fulfilled")
      assert.deepEqual(await engine.submit("Original", key, model), outcomes[0].value);
  }
  assert.equal(provider.state.callCount, 3);
});

test("legacy replay uses historical admission evidence; unverifiable receipts fail closed without changing history", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-intent-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { models, model, provider } = fixtureModels([fauxAssistantMessage("legacy done")]);
  const options = {
    database: path.join(directory, "review.sqlite"),
    session: fixtureSession,
    models,
    model,
    sandbox: async () => fixtureSandbox("A"),
  };
  let engine = await openReviewEngine(options);
  try {
    await engine.conversation.configure({ model, thinkingLevel: "high" }, context);
    const original = await engine.conversation.submit(
      { type: "input", content: "Legacy body", requestId: "legacy" },
      context,
    );
    await engine.conversation.waitForIdle(context);
    await engine.syncSession({ ...fixtureSession, headSha: "B" });
    await engine.conversation.configure(
      { model: { ...model, modelId: "current-not-original" }, thinkingLevel: "low" },
      context,
    );
    await engine.conversation.commit(
      (tx) =>
        tx.createSubmission({
          conversationId: engine.conversation.id,
          type: "input",
          status: "unanswered",
          reason: "aborted",
          requestId: "unverifiable",
        }),
      context,
    );
    const before = await engine.snapshot();
    await engine.close();
    engine = await openReviewEngine({ ...options, thinkingLevel: "low" });
    for (const attempt of [
      () => engine.submit("Different body", "legacy", model, "high", fixtureSession),
      () =>
        engine.submit(
          "Legacy body",
          "legacy",
          { ...model, modelId: "current-not-original" },
          "high",
          fixtureSession,
        ),
      () => engine.submit("Legacy body", "legacy", model, "low", fixtureSession),
    ]) {
      await assert.rejects(
        attempt(),
        (error) => error instanceof ReviewAdmissionConflict && error.reason === "intent_changed",
      );
    }
    assert.equal(
      await engine.harness.snapshot(AdmissionIntentDoc, engine.conversation.id, "legacy", context),
      undefined,
    );
    assert.deepEqual(await engine.submit("Legacy body", "legacy", model, "high", fixtureSession), {
      submissionId: String(original.id),
    });
    assert.match(
      (await engine.harness.snapshot(AdmissionIntentDoc, engine.conversation.id, "legacy", context))
        ?.fingerprint ?? "",
      /^[a-f0-9]{64}$/,
    );
    for (const body of ["Legacy body", "Different body"]) {
      await assert.rejects(
        engine.submit(body, "unverifiable", model, "high", fixtureSession),
        (error) =>
          error instanceof ReviewAdmissionConflict && error.reason === "legacy_unverifiable",
      );
    }
    assert.equal(
      await engine.harness.snapshot(
        AdmissionIntentDoc,
        engine.conversation.id,
        "unverifiable",
        context,
      ),
      undefined,
    );
    assert.deepEqual((await engine.snapshot()).messages, before.messages);
    assert.equal(
      (await engine.snapshot()).revision,
      "B",
      "replay must not overwrite the current review scope",
    );
    assert.equal(provider.state.callCount, 1);
  } finally {
    await engine.close();
  }
});

test("admission snapshots caller-owned model and review context before asynchronous work", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-intent-capture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { models, model, provider } = fixtureModels([
    (input, _options, _state, actual) => {
      assert.equal(actual.id, "review");
      assert.match(
        getCurrentSystemPrompt(input.messages),
        new RegExp(`Reviewed head: ${fixtureSession.headSha}`),
      );
      return fauxAssistantMessage("done");
    },
  ]);
  const engine = await openReviewEngine({
    database: path.join(directory, "review.sqlite"),
    session: fixtureSession,
    models,
    model,
    sandbox: async () => fixtureSandbox("A"),
  });
  t.after(() => engine.close());
  const suppliedModel = { ...model };
  const suppliedSession = structuredClone(fixtureSession);
  const admitted = engine.submit("Capture", "capture", suppliedModel, "off", suppliedSession);
  suppliedModel.modelId = "mutated-after-submit";
  suppliedSession.headSha = "mutated-after-submit";
  const receipt = await admitted;
  await engine.conversation.waitForIdle(context);
  assert.deepEqual(
    await engine.submit("Capture", "capture", model, "off", fixtureSession),
    receipt,
  );
  assert.equal(provider.state.callCount, 1);
});

test("a durable claim left before submission only permits the same intent to finish after reopening", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-intent-claim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { models, model, provider } = fixtureModels([fauxAssistantMessage("recovered")]);
  const options = {
    database: path.join(directory, "review.sqlite"),
    session: fixtureSession,
    models,
    model,
    sandbox: async () => fixtureSandbox("A"),
  };
  let engine = await openReviewEngine(options);
  try {
    await engine.conversation.commit(async (tx) => {
      (await tx.doc(AdmissionIntentDoc, engine.conversation.id, "claim-only", null)).fingerprint =
        admissionFingerprint("Original", model, "off", fixtureSession);
    }, context);
    await engine.close();
    engine = await openReviewEngine(options);
    await assert.rejects(engine.submit("Changed", "claim-only", model), ReviewAdmissionConflict);
    assert.equal(provider.state.callCount, 0);
    const receipt = await engine.submit("Original", "claim-only", model);
    await engine.conversation.waitForIdle(context);
    assert.deepEqual(await engine.submit("Original", "claim-only", model), receipt);
    assert.equal(provider.state.callCount, 1);
  } finally {
    await engine.close();
  }
});
