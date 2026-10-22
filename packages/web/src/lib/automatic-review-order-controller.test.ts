import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTO_ORDER_PREFERENCE_KEY,
  createAutomaticReviewOrder,
  type AutomaticReviewOrderContext,
  type AvailableReviewOrder,
  type ReviewOrderObservation,
} from "./automatic-review-order";

const appliedKey = "better-review:applied-review-orders";
const order: AvailableReviewOrder = {
  prUrl: "pr/1",
  sessionId: "session",
  revision: "head",
  mode: "full",
  messageId: "message",
  files: ["b", "a"],
};
const context = (): AutomaticReviewOrderContext => ({
  requestedUrl: "pr/1",
  loadedUrl: "pr/1",
  mode: "full",
  revision: "head",
  paths: ["a", "b"],
  loading: false,
  loadingCommits: false,
  switchingPr: false,
});
const observation = (
  value: AvailableReviewOrder | null = order,
  snapshotLoaded = true,
): ReviewOrderObservation => ({
  order: value,
  hydration: { prUrl: "pr/1", mode: "full", revision: "head", snapshotLoaded },
});
function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
function fixture(storage = memory()) {
  const applications: { files: string[]; pending: boolean }[] = [];
  const events: string[] = [];
  const owner = createAutomaticReviewOrder({
    storage,
    apply(files) {
      applications.push({ files, pending: owner.getState().initialPending });
      events.push("apply");
    },
  });
  owner.subscribe(() => events.push(`pending:${owner.getState().initialPending}`));
  owner.updateContext(context());
  return { owner, applications, events, storage };
}

test("automatic order controller: atomic hydration applies once before pending release", (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  f.owner.beginInitialLoad("pr/1");
  assert.deepEqual(f.owner.getState(), { enabled: true, initialPending: true });
  f.owner.observe(observation());
  assert.deepEqual(f.applications, [{ files: ["b", "a"], pending: true }]);
  assert.deepEqual(f.events, ["pending:true", "apply", "pending:false"]);
  f.owner.observe(observation());
  f.owner.updateContext(context());
  assert.equal(
    f.applications.length,
    1,
    "live phase of the same observation cannot apply hydrated history twice",
  );
});

test("automatic order controller: synchronous context accessor avoids effect-order dependence during observation", (t) => {
  let current: AutomaticReviewOrderContext = { ...context(), revision: "stale" };
  const applications: string[][] = [];
  const owner = createAutomaticReviewOrder({
    storage: memory(),
    context: () => current,
    apply: (files) => {
      applications.push(files);
    },
  });
  t.after(() => owner.dispose());
  owner.updateContext(current);
  owner.beginInitialLoad("pr/1");
  current = context(); // No updateContext/effect has run for the new revision yet.
  owner.observe(observation());
  assert.deepEqual(applications, [["b", "a"]]);
  assert.equal(owner.getState().initialPending, false);
});

test("automatic order controller: exact 10,000ms timeout retains fallback and consumes late history without applying", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  t.after(() => f.owner.dispose());
  f.owner.beginInitialLoad("pr/1");
  t.mock.timers.tick(5_000);
  for (let index = 0; index < 5; index++) f.owner.updateContext(context());
  t.mock.timers.tick(4_999);
  assert.equal(f.owner.getState().initialPending, true);
  t.mock.timers.tick(1);
  assert.equal(
    f.owner.getState().initialPending,
    false,
    "repeated context updates do not restart the timer",
  );
  f.owner.observe(observation());
  assert.deepEqual(f.applications, []);
  assert.equal(JSON.parse(f.storage.values.get(appliedKey)!).keys.length, 1);
  f.owner.observe(observation());
  assert.deepEqual(f.applications, []);
  f.owner.observe({ order: { ...order, messageId: "future-completed-message" } });
  assert.deepEqual(f.applications, [{ files: ["b", "a"], pending: false }]);
});

test("automatic order controller: failed hydration releases wait but only the first late loaded history is suppressed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  t.after(() => f.owner.dispose());
  f.owner.beginInitialLoad("pr/1");
  f.owner.observe(observation(null, false));
  assert.equal(f.owner.getState().initialPending, false);
  t.mock.timers.tick(10_000);
  f.owner.observe(observation());
  assert.equal(f.applications.length, 0);
  const future = { ...order, messageId: "new-after-recovery" };
  f.owner.observe(observation(future));
  assert.deepEqual(f.applications, [{ files: future.files, pending: false }]);
});

test("automatic order controller: initial empty snapshot releases wait without consuming future completed output", (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  f.owner.beginInitialLoad("pr/1");
  f.owner.observe(observation(null));
  assert.equal(f.owner.getState().initialPending, false);
  assert.equal(f.storage.values.has(appliedKey), false);
  f.owner.observe({ order });
  assert.equal(f.applications.length, 1);
});

test("automatic order controller: reset cancels stale deadlines and stale PR hydration", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  t.after(() => f.owner.dispose());
  f.owner.beginInitialLoad("pr/1");
  t.mock.timers.tick(6_000);
  f.owner.cancelInitialLoad();
  assert.equal(f.owner.getState().initialPending, false);
  f.owner.updateContext({ ...context(), loadedUrl: "pr/2", requestedUrl: "pr/2" });
  f.owner.beginInitialLoad("pr/2");
  t.mock.timers.tick(4_000);
  f.owner.observe(observation());
  assert.equal(
    f.owner.getState().initialPending,
    true,
    "old timer and old hydration cannot release the new PR gate",
  );
  assert.equal(f.applications.length, 0);
  t.mock.timers.tick(5_999);
  assert.equal(f.owner.getState().initialPending, true);
  t.mock.timers.tick(1);
  assert.equal(f.owner.getState().initialPending, false);
});

for (const patch of [
  { prUrl: "pr/2" },
  { mode: "commit" as const },
  { revision: "other" },
  { revision: null },
]) {
  test(`automatic order controller: hydration rejects mismatched ${JSON.stringify(patch)} without consumption`, (t) => {
    const f = fixture();
    t.after(() => f.owner.dispose());
    f.owner.beginInitialLoad("pr/1");
    const value = observation();
    f.owner.observe({ ...value, hydration: { ...value.hydration!, ...patch } });
    assert.equal(f.owner.getState().initialPending, true);
    assert.equal(f.storage.values.has(appliedKey), false);
    assert.equal(f.applications.length, 0);
    f.owner.observe(observation());
    assert.equal(f.applications.length, 1);
  });
}

for (const patch of [
  { loadedUrl: null },
  { requestedUrl: "edited-before-load" },
  { mode: "commit" as const },
  { revision: "other" },
  { revision: null },
  { loading: true },
  { loadingCommits: true },
  { switchingPr: true },
]) {
  test(`automatic order controller: live order waits for matching context ${JSON.stringify(patch)}`, (t) => {
    const f = fixture();
    t.after(() => f.owner.dispose());
    f.owner.updateContext({ ...context(), ...patch });
    f.owner.observe({ order });
    assert.equal(f.applications.length, 0);
    assert.equal(f.storage.values.has(appliedKey), false);
    f.owner.updateContext(context());
    assert.equal(
      f.applications.length,
      1,
      "context changes reevaluate the retained order without another observation",
    );
  });
}

test("automatic order controller: missing paths are not consumed and can apply when paths arrive", (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  f.owner.updateContext({ ...context(), paths: ["a"] });
  f.owner.beginInitialLoad("pr/1");
  f.owner.observe(observation());
  assert.equal(f.owner.getState().initialPending, false);
  assert.equal(f.applications.length, 0);
  assert.equal(f.storage.values.has(appliedKey), false);
  f.owner.updateContext(context());
  assert.deepEqual(f.applications, [{ files: ["b", "a"], pending: false }]);
});

test("automatic order controller: invalid empty/duplicate orders are not consumed", (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  for (const files of [[], ["a", "a"], ["missing"]])
    f.owner.observe({ order: { ...order, files } });
  assert.equal(f.applications.length, 0);
  assert.equal(f.storage.values.has(appliedKey), false);
  f.owner.observe({ order });
  assert.equal(f.applications.length, 1);
});

test("automatic order controller: disable clears wait; reenable applies retained live order without restarting a timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  t.after(() => f.owner.dispose());
  f.owner.beginInitialLoad("pr/1");
  f.owner.setEnabled(false);
  assert.deepEqual(f.owner.getState(), { enabled: false, initialPending: false });
  assert.equal(f.storage.values.get(AUTO_ORDER_PREFERENCE_KEY), '{"version":1,"enabled":false}');
  f.owner.observe({ order });
  assert.equal(f.applications.length, 0);
  f.owner.setEnabled(true);
  assert.equal(f.applications.length, 1);
  assert.equal(f.owner.getState().initialPending, false);
  assert.equal(f.storage.values.get(AUTO_ORDER_PREFERENCE_KEY), '{"version":1,"enabled":true}');
  const before = f.events.length;
  t.mock.timers.tick(10_000);
  assert.equal(f.events.length, before, "cancelled timer cannot publish after reenable");
});

test("automatic order controller: disabled preference at begin never creates initial wait", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const storage = memory();
  storage.setItem(AUTO_ORDER_PREFERENCE_KEY, '{"version":1,"enabled":false}');
  const f = fixture(storage);
  t.after(() => f.owner.dispose());
  f.owner.beginInitialLoad("pr/1");
  assert.equal(f.owner.getState().initialPending, false);
  f.owner.setEnabled(true);
  t.mock.timers.tick(10_000);
  assert.deepEqual(f.owner.getState(), { enabled: true, initialPending: false });
});

test("automatic order controller: consumption survives manual override and reload, while distinct future tuples apply", () => {
  const storage = memory();
  let displayed = ["a", "b"];
  const create = () =>
    createAutomaticReviewOrder({
      storage,
      apply(files) {
        displayed = files;
      },
    });
  let owner = create();
  owner.updateContext(context());
  owner.observe({ order });
  assert.deepEqual(displayed, ["b", "a"]);
  displayed = ["a", "b"]; // Manual apply owns display; it does not disable automatic ordering.
  owner.observe({ order });
  assert.deepEqual(displayed, ["a", "b"]);
  owner.dispose();
  owner = create();
  owner.updateContext(context());
  owner.observe({ order });
  assert.deepEqual(
    displayed,
    ["a", "b"],
    "saved consumption cannot undo a manual override on reload",
  );
  for (const patch of [
    { prUrl: "pr/2" },
    { sessionId: "other" },
    { revision: "new-head" },
    { mode: "commit" as const },
    { messageId: "future" },
    { files: ["a", "b"] },
  ]) {
    const next = { ...order, ...patch };
    owner.updateContext({
      ...context(),
      requestedUrl: next.prUrl,
      loadedUrl: next.prUrl,
      revision: next.revision,
      mode: next.mode,
    });
    owner.observe({ order: next });
  }
  const value = JSON.parse(storage.values.get(appliedKey)!);
  assert.equal(value.version, 1);
  assert.equal(value.keys.length, 7);
  assert.equal(
    value.keys[0],
    JSON.stringify(["pr/1", "session", "full", "head", "message", ["b", "a"]]),
  );
  owner.dispose();
});

test("automatic order controller: persistence retains the exact last 100 tuple keys", (t) => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  for (let index = 0; index <= 100; index++)
    f.owner.observe({ order: { ...order, messageId: `m${index}` } });
  const saved = JSON.parse(f.storage.values.get(appliedKey)!);
  assert.deepEqual(Object.keys(saved), ["version", "keys"]);
  assert.equal(saved.keys.length, 100);
  assert.equal(
    saved.keys[0],
    JSON.stringify(["pr/1", "session", "full", "head", "m1", ["b", "a"]]),
  );
  assert.equal(
    saved.keys[99],
    JSON.stringify(["pr/1", "session", "full", "head", "m100", ["b", "a"]]),
  );
});

test("automatic order controller: storage failure retains preference and consumption in memory", () => {
  let applications = 0;
  const owner = createAutomaticReviewOrder({
    storage: {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("quota");
      },
    },
    apply() {
      applications++;
    },
  });
  owner.updateContext(context());
  assert.equal(owner.getState().enabled, true);
  owner.setEnabled(false);
  owner.observe({ order });
  assert.equal(applications, 0);
  owner.setEnabled(true);
  assert.equal(applications, 1);
  owner.observe({ order });
  owner.updateContext(context());
  assert.equal(applications, 1);
  owner.dispose();
});

test("automatic order controller: disposal clears timers and suppresses all publication/application", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.owner.beginInitialLoad("pr/1");
  let publications = 0;
  f.owner.subscribe(() => publications++);
  const before = f.owner.getState();
  f.owner.dispose();
  t.mock.timers.tick(10_000);
  f.owner.observe(observation());
  f.owner.updateContext(context());
  f.owner.setEnabled(false);
  f.owner.cancelInitialLoad();
  f.owner.beginInitialLoad("pr/2");
  assert.equal(f.owner.getState(), before);
  assert.equal(publications, 0);
  assert.equal(f.applications.length, 0);
  assert.equal(f.storage.values.size, 0);
});
