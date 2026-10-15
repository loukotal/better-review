import assert from "node:assert/strict";
import test from "node:test";

import { measure, reviewMetrics, startMeasurement } from "./metrics";

test("metrics reject unsafe names and invalid values, including in debug logs", () => {
  const original = process.env.BETTER_REVIEW_METRICS;
  const info = console.info;
  const logs: string[] = [];
  process.env.BETTER_REVIEW_METRICS = "1";
  console.info = (text: string) => logs.push(text);
  try {
    const before = reviewMetrics();
    for (let i = 0; i < 1000; i++) measure(`/secret/path/command-${i}`, 1);
    for (const invalid of [NaN, Infinity, -Infinity, -1]) measure("tool.output.bytes", invalid);
    assert.deepEqual(reviewMetrics(), before);
    assert.deepEqual(logs, []);
    measure("tool.output.bytes", 3);
    assert.deepEqual(logs, ["[review-perf] tool.output.bytes=3.00"]);
  } finally {
    console.info = info;
    if (original === undefined) delete process.env.BETTER_REVIEW_METRICS;
    else process.env.BETTER_REVIEW_METRICS = original;
  }
});

test("metrics retain all-time totals but compute p95 over only the last 128 samples", () => {
  const before = reviewMetrics()["tool.duration.ms"]?.count ?? 0;
  measure("tool.duration.ms", 10000);
  for (let i = 0; i < 128; i++) measure("tool.duration.ms", 2);
  const result = reviewMetrics()["tool.duration.ms"]!;
  assert.equal(result.count - before, 129);
  assert.equal(result.max, 10000);
  assert.equal(result.total, 10256);
  assert.equal(result.mean, 10256 / 129);
  assert.equal(result.p95, 2);
});

test("measurement completion is idempotent", () => {
  const before = reviewMetrics()["snapshot.project.ms"]?.count ?? 0;
  const done = startMeasurement("snapshot.project");
  done();
  done();
  assert.equal(reviewMetrics()["snapshot.project.ms"]!.count - before, 1);
});
