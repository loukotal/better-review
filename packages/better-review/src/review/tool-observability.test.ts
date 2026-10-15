import assert from "node:assert/strict";
import test from "node:test";

import { reviewMetrics } from "./metrics";
import { createToolObservability, type ToolObservation } from "./tool-observability";

const total = (name: string) => reviewMetrics()[name]?.total ?? 0;

test("tool observations preserve results, count UTF-8 chunks, and report flags once per call", async () => {
  const observer = createToolObservability();
  const before = reviewMetrics();
  const result = { ok: true };
  let late!: ToolObservation;
  assert.equal(
    await observer.observe("secret-tool-name", { path: "/secret" }, (observation) => {
      late = observation;
      observation.output("é");
      observation.output("🙂", { truncated: true, cacheHit: true });
      observation.metadata({ truncated: true, cacheHit: true });
      return result;
    }),
    result,
  );
  for (const [name, expected] of [
    ["tool.output.bytes", 6],
    ["tool.truncated", 1],
    ["tool.cache_hit", 1],
    ["tool.errors", 0],
  ] as const) {
    assert.equal(total(name) - (before[name]?.total ?? 0), expected);
  }
  const finished = reviewMetrics();
  late.output("ignored", { cacheHit: true });
  assert.deepEqual(reviewMetrics(), finished);
  assert.doesNotMatch(JSON.stringify(finished), /secret/);
});

test("repeated requests canonicalize object keys, distinguish tools and values, and remain isolated", async () => {
  const observer = createToolObservability();
  const before = total("tool.repeated");
  const execute = () => undefined;
  await observer.observe("read", { path: "secret", offset: 1 }, execute);
  await observer.observe("read", { offset: 1, path: "secret" }, execute);
  await observer.observe("read", { path: "secret", offset: "1" }, execute);
  await observer.observe("bash", { offset: 1, path: "secret" }, execute);
  await createToolObservability().observe("read", { path: "secret", offset: 1 }, execute);
  assert.equal(total("tool.repeated") - before, 1);
  observer.reset();
  await observer.observe("read", { path: "secret", offset: 1 }, execute);
  assert.equal(total("tool.repeated") - before, 1);
});

test("repeat history evicts old fingerprints and ignores cyclic/oversized argument graphs", async () => {
  const observer = createToolObservability();
  const before = total("tool.repeated");
  for (let i = 0; i <= 256; i++) await observer.observe("read", { path: `${i}` }, () => {});
  await observer.observe("read", { path: "0" }, () => {});
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const value of [cyclic, cyclic, Array(5000).fill(0), Array(5000).fill(0)]) {
    await observer.observe("read", value, () => {});
  }
  assert.equal(total("tool.repeated") - before, 0);
});

test("throwing tools record partial output and duration while preserving the original error", async () => {
  const observer = createToolObservability();
  const before = total("tool.errors");
  const bytes = total("tool.output.bytes");
  const durations = reviewMetrics()["tool.duration.ms"]?.count ?? 0;
  const error = new Error("private command");
  await assert.rejects(
    observer.observe("bash", {}, (observation) => {
      observation.output("partial");
      throw error;
    }),
    (caught) => caught === error,
  );
  assert.equal(total("tool.errors") - before, 1);
  assert.equal(total("tool.output.bytes") - bytes, 7);
  assert.equal(reviewMetrics()["tool.duration.ms"]!.count - durations, 1);
});

test("repeat fingerprints distinguish sparse array lengths and skip non-JSON containers", async () => {
  const observer = createToolObservability();
  const before = total("tool.repeated");
  for (const args of [[], Array(1), Array(2), new Date(0), new Map(), new Set(), {}]) {
    await observer.observe("read", args, () => {});
  }
  assert.equal(total("tool.repeated") - before, 0);
});

test("concurrent identical requests are repeats, not implicit cache hits; error results can be marked", async () => {
  const observer = createToolObservability();
  const repeats = total("tool.repeated");
  const hits = total("tool.cache_hit");
  const errors = total("tool.errors");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = observer.observe("read", {}, () => blocked);
  await observer.observe("read", {}, (observation) => {
    observation.metadata({ isError: true });
    return { isError: true };
  });
  release();
  await first;
  assert.equal(total("tool.repeated") - repeats, 1);
  assert.equal(total("tool.cache_hit") - hits, 0);
  assert.equal(total("tool.errors") - errors, 1);
});

test("cancellation preserves the abort reason and records partial output once", async () => {
  const observer = createToolObservability();
  const controller = new AbortController();
  const error = new DOMException("private command cancelled", "AbortError");
  const before = reviewMetrics();
  const running = observer.observe("bash", {}, async (observation) => {
    observation.output("partial");
    await new Promise<void>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
        once: true,
      });
    });
  });
  controller.abort(error);
  await assert.rejects(running, (caught) => caught === error);
  assert.equal(total("tool.errors") - (before["tool.errors"]?.total ?? 0), 1);
  assert.equal(total("tool.output.bytes") - (before["tool.output.bytes"]?.total ?? 0), 7);
  assert.equal(
    reviewMetrics()["tool.duration.ms"]!.count - (before["tool.duration.ms"]?.count ?? 0),
    1,
  );
});
