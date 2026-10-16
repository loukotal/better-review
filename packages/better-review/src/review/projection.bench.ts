import assert from "node:assert/strict";
// Run with: node --import tsx src/review/projection.bench.ts
// Fixed synthetic data, faux provider only; includes the real engine snapshot path.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { openReviewEngine } from "./engine";
import { fixtureModels, fixtureSandbox, fixtureSession } from "./fixtures";
import { reviewMetrics } from "./metrics";

const dir = await mkdtemp(path.join(tmpdir(), "review-projection-bench-"));
const { models, model } = fixtureModels([]);
const engine = await openReviewEngine({
  database: path.join(dir, "review.sqlite"),
  session: fixtureSession,
  models,
  model,
  sandbox: async () => fixtureSandbox("A"),
});
try {
  const message = fauxAssistantMessage("fixed transcript text ".repeat(100));
  message.timestamp = 1700000000000;
  await engine.conversation.commit(async (tx) => {
    for (let i = 0; i < 3000; i++)
      await tx.appendEntry(engine.conversation.id, { kind: "pi.assistant", model: [message] });
  }, context);
  await engine.snapshot();
  const times: number[] = [];
  for (let i = 0; i < 120; i++) {
    await engine.conversation.commit(async (tx) => {
      await tx.appendEntry(engine.conversation.id, { kind: "pi.assistant", model: [message] });
    }, context);
    const count = reviewMetrics()["snapshot.project.ms"]?.count ?? 0;
    const start = performance.now();
    const snapshot = await engine.snapshot();
    times.push(performance.now() - start);
    assert.equal(
      reviewMetrics()["snapshot.project.ms"]?.count,
      count + 1,
      "each measured snapshot must project a dirty commit, not return the cached snapshot",
    );
    assert.equal(snapshot.messages.length, 3001 + i);
  }
  const measured = times.slice(20).sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      initialMessages: 3000,
      appended: 120,
      warmup: 20,
      samples: measured.length,
      scope:
        "dirty engine.snapshot after one append; excludes commit, hydration, serialization and live overlays",
      medianMs: measured[50],
      p95Ms: measured[95],
      totalMs: measured.reduce((sum, n) => sum + n, 0),
    }),
  );
} finally {
  await engine.close();
  await rm(dir, { recursive: true, force: true });
}
