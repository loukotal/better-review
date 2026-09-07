import assert from "node:assert/strict";
import test from "node:test";

import { ReviewLaunchCoordinator, PrSessionLock } from "./review-launch-coordinator";

test("duplicate clicks share one launch while different PRs can start concurrently", async () => {
  const coordinator = new ReviewLaunchCoordinator<string>();
  let release!: (value: string) => void;
  let count = 0;
  const first = coordinator.run("pr-1", () => {
    count++;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const duplicate = coordinator.run("pr-1", async () => {
    count++;
    return "duplicate";
  });
  assert.equal(first, duplicate);
  assert.equal(await coordinator.run("pr-2", async () => "second"), "second");
  assert.equal(count, 1);
  assert.equal(coordinator.has("pr-1"), true);
  release("first");
  assert.equal(await first, "first");
  assert.equal(coordinator.has("pr-1"), false);
});

test("failed launches release their key for retry", async () => {
  const coordinator = new ReviewLaunchCoordinator<string>();
  await assert.rejects(
    coordinator.run("pr", async () => {
      throw new Error("checkout failed");
    }),
    /checkout failed/,
  );
  assert.equal(await coordinator.run("pr", async () => "retry"), "retry");
});

test("opening a PR waits for its launch setup but does not block other PRs", async () => {
  const lock = new PrSessionLock();
  let release!: () => void;
  const events: string[] = [];
  const launch = lock.run(
    "pr-1",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        events.push("launch");
      }),
  );
  const open = lock.run("pr-1", async () => {
    events.push("open existing session");
  });
  await lock.run("pr-2", async () => {
    events.push("another PR");
  });
  assert.deepEqual(events, ["launch", "another PR"]);
  release();
  await Promise.all([launch, open]);
  assert.deepEqual(events, ["launch", "another PR", "open existing session"]);
});
