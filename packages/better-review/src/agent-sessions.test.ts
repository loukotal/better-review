import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import { makeReviewSessionService } from "./agent-sessions";
import { StoreService } from "./store";

test("closing the last review tab settles the waiting agent without approving", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const data = new Map<string, unknown>();
  const store = new StoreService({
    get: <T>(ns: string, key: string) =>
      Effect.succeed((data.get(`${ns}/${key}`) as T | undefined) ?? null),
    set: (ns, key, value) =>
      Effect.sync(() => {
        data.set(`${ns}/${key}`, value);
      }),
    delete: (ns, key) =>
      Effect.sync(() => {
        data.delete(`${ns}/${key}`);
      }),
    list: () => Effect.succeed([]),
    clearCache: Effect.void,
  });
  const make = () =>
    Effect.runPromise(makeReviewSessionService.pipe(Effect.provideService(StoreService, store)));
  const service = await make();
  const create = (id: string) =>
    Effect.runPromise(
      service.createSession({
        id,
        mode: "message",
        origin: "manual",
        title: "Review",
        payload: { kind: "message", content: "hello" },
      }),
    );
  await create("closed");
  await create("unopened");
  assert.equal(await Effect.runPromise(service.getResult("closed")), null);
  await Effect.runPromise(service.updatePresence("closed", "tab-one", true));
  await Effect.runPromise(service.updatePresence("closed", "tab-one", false));
  assert.equal(await Effect.runPromise(service.getResult("closed")), null);
  t.mock.timers.tick(10_001);
  const result = await Effect.runPromise(service.getResult("closed"));
  assert.equal(result?.cancelled, true);
  assert.equal(result?.approved, false);
  assert.match(result?.feedback ?? "", /closed|disconnected/);
  assert.equal((await Effect.runPromise(service.getSession("closed")))?.status, "cancelled");
  assert.equal(await Effect.runPromise(service.getResult("unopened")), null);

  await create("reload");
  await Effect.runPromise(service.updatePresence("reload", "old-tab", true));
  await Effect.runPromise(service.updatePresence("reload", "old-tab", false));
  t.mock.timers.tick(5000);
  await Effect.runPromise(service.updatePresence("reload", "new-tab", true));
  t.mock.timers.tick(6000);
  assert.equal(await Effect.runPromise(service.getResult("reload")), null);

  await create("multi");
  await Effect.runPromise(service.updatePresence("multi", "one", true));
  await Effect.runPromise(service.updatePresence("multi", "two", true));
  await Effect.runPromise(service.updatePresence("multi", "one", false));
  t.mock.timers.tick(10_001);
  assert.equal(await Effect.runPromise(service.getResult("multi")), null);
  await Effect.runPromise(service.updatePresence("multi", "two", false));
  t.mock.timers.tick(10_001);
  assert.equal((await Effect.runPromise(service.getResult("multi")))?.cancelled, true);

  await create("crashed");
  await Effect.runPromise(service.updatePresence("crashed", "tab", true));
  t.mock.timers.tick(90_001);
  const restarted = await make();
  assert.equal((await Effect.runPromise(restarted.getResult("crashed")))?.cancelled, true);

  await create("submitted");
  await Effect.runPromise(service.updatePresence("submitted", "tab", true));
  await Effect.runPromise(
    service.submitResult("submitted", {
      mode: "message",
      approved: true,
      feedback: "",
      annotations: [],
    }),
  );
  await Effect.runPromise(service.updatePresence("submitted", "tab", false));
  t.mock.timers.tick(100_000);
  assert.equal((await Effect.runPromise(service.getResult("submitted")))?.approved, true);
  await assert.rejects(
    Effect.runPromise(
      service.submitResult("closed", {
        mode: "message",
        approved: true,
        feedback: "",
        annotations: [],
      }),
    ),
    /already completed/,
  );
});
