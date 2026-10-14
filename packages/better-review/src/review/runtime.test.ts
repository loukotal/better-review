import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

import { fixtureModels, fixtureSandbox, fixtureSession } from "./fixtures";
import { createReviewRuntime } from "./runtime";

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
