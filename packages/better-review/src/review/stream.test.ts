import assert from "node:assert/strict";
import test from "node:test";

import { applyReviewUpdate, type ReviewSnapshot } from "@better-review/shared";

import { encodeReviewFrame, reviewStream } from "./stream";

test("shared stream sends small ordered patches and full snapshots after skipped updates", async () => {
  let current: ReviewSnapshot = {
    sessionId: "review",
    running: false,
    compacting: false,
    settlements: [],
    messages: Array.from({ length: 500 }, (_, index) => ({
      id: String(index),
      role: "assistant",
      parts: [{ type: "text", text: "Earlier finding ".repeat(40) }],
      metadata: { timestamp: "2026-10-14T00:00:00Z" },
    })),
  };
  let notify!: () => void;
  let reads = 0;
  const channel = reviewStream({
    snapshot: async () => {
      reads++;
      return current;
    },
    subscribe: (callback) => {
      notify = callback;
      return () => {};
    },
  });
  try {
    const first = await channel.current();
    const delivered: number[] = [];
    const stopA = channel.subscribe((frame) => delivered.push(frame.version));
    const stopB = channel.subscribe((frame) => delivered.push(frame.version));
    current = {
      ...current,
      messages: [
        ...current.messages,
        {
          id: "live",
          role: "assistant",
          parts: [{ type: "text", text: "New finding" }],
          metadata: { timestamp: "2026-10-14T00:00:01Z" },
        },
      ],
    };
    notify();
    const [second, same] = await Promise.all([channel.current(), channel.current()]);
    assert.equal(second, same);
    assert.equal(reads, 2);
    assert.deepEqual(delivered, [2, 2]);
    const encoded = encodeReviewFrame(second, first.version);
    assert.equal(encoded.event, "update");
    assert.ok(encoded.data.length < JSON.stringify(first.snapshot).length / 100);
    assert.deepEqual(applyReviewUpdate(first.snapshot, first.version, second.update!), current);
    assert.equal(encodeReviewFrame(second).event, "snapshot");
    assert.throws(() => applyReviewUpdate(first.snapshot, 0, second.update!), /out of sync/);
    current = { ...current, running: true };
    notify();
    const third = await channel.current();
    assert.equal(encodeReviewFrame(third, first.version).event, "snapshot");
    stopA();
    stopB();
  } finally {
    channel.close();
  }
});
