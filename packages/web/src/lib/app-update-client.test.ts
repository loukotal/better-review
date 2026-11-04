import assert from "node:assert/strict";
import { test } from "node:test";

import type { AppUpdateControl, AppUpdateJob } from "@better-review/shared";

import { waitForAppUpdate } from "./app-update-client";

const job = (phase: AppUpdateJob["phase"]): AppUpdateJob => ({
  id: "job",
  phase,
  startedAt: 1,
  targetRevision: "a".repeat(40),
});
function fixture(reads: (AppUpdateControl | Error)[]) {
  let time = 0;
  const progress: string[] = [];
  const abort = new AbortController();
  return {
    abort,
    progress,
    run: () =>
      waitForAppUpdate({
        jobId: "job",
        instanceId: "old",
        signal: abort.signal,
        now: () => time,
        timeoutMs: 10,
        delay: async () => {
          time++;
        },
        progress: (value) => progress.push(value.phase),
        read: async () => {
          const value = reads.shift();
          if (!value || value instanceof Error) throw value ?? new Error("offline");
          return value;
        },
      }),
  };
}

test("update polling tolerates downtime and finishes only on a healthy new instance", async () => {
  const f = fixture([
    { supported: true, instanceId: "old", job: job("installing") },
    new Error("connection refused"),
    { supported: true, instanceId: "old", job: job("ready") },
    { supported: true, instanceId: "new", job: job("ready") },
  ]);
  await f.run();
  assert.deepEqual(f.progress, ["installing", "ready", "ready"]);
});

test("failed update, replaced job, timeout and disposal cannot falsely finish", async () => {
  await assert.rejects(
    fixture([
      { supported: true, instanceId: "old", job: { ...job("failed"), error: "Local changes" } },
    ]).run(),
    /Local changes/,
  );
  await assert.rejects(
    fixture([{ supported: true, instanceId: "new", job: { ...job("ready"), id: "other" } }]).run(),
    /Another update/,
  );
  await assert.rejects(fixture([]).run(), /did not finish/);
  const f = fixture([]);
  f.abort.abort();
  await assert.rejects(f.run(), { name: "AbortError" });
});
