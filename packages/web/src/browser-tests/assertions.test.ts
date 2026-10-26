import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { createAssertions } from "./assertions";

function frames(t: TestContext) {
  let now = 100;
  let count = 0;
  t.mock.method(performance, "now", () => now);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value(callback: FrameRequestCallback) {
      now += 10;
      callback(now);
      return ++count;
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "requestAnimationFrame", previous);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  });
  return () => count;
}

test("assertion waits require an explicit finite positive timeout", () => {
  for (const timeout of [0, -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => createAssertions(timeout), {
      name: "RangeError",
      message: "Assertion wait timeout must be finite and positive",
    });
  }
});

test("only successful checks count and each case owns its count", () => {
  const first = createAssertions(50);
  const second = createAssertions(50);
  first.check(true, "first success");
  assert.throws(() => first.check(false, "supplied failure"), { message: "supplied failure" });
  second.check(1, "second success");
  second.check("truthy", "another success");
  assert.deepEqual(first.result(), { passed: 1 });
  assert.deepEqual(second.result(), { passed: 2 });
  assert.equal(Number.isSafeInteger(first.result().passed), true);
});

test("polling counts terminal success once without rechecking the successful predicate", async (t) => {
  const frameCount = frames(t);
  const assertions = createAssertions(50);
  let polls = 0;
  await assertions.wait(() => ++polls === 4, "terminal condition");
  assert.equal(polls, 4);
  assert.equal(frameCount(), 3);
  assert.deepEqual(assertions.result(), { passed: 1 });
});

test("a monotonic deadline fails with the supplied diagnostic and no successful assertion", async (t) => {
  const frameCount = frames(t);
  const assertions = createAssertions(15);
  let polls = 0;
  await assert.rejects(
    assertions.wait(() => {
      polls++;
      return false;
    }, "held response never arrived"),
    {
      message: "held response never arrived",
    },
  );
  assert.equal(polls, 3);
  assert.equal(frameCount(), 2);
  assert.deepEqual(assertions.result(), { passed: 0 });
});

test("predicate exceptions retain their cause and do not count as success", async () => {
  const assertions = createAssertions(50);
  const cause = new Error("fixture predicate failed");
  await assert.rejects(
    assertions.wait(() => {
      throw cause;
    }, "do not mask cause"),
    (error) => error === cause,
  );
  assert.deepEqual(assertions.result(), { passed: 0 });
});
