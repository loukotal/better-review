import type { ReviewSnapshot, ReviewUpdate } from "@better-review/shared";

import { measure, startMeasurement } from "./metrics";

export type ReviewFrame = { version: number; snapshot: ReviewSnapshot; update?: ReviewUpdate };

/** One projection per conversation update, shared by every observing tab. */
export function reviewStream(engine: {
  snapshot(): Promise<ReviewSnapshot>;
  subscribe(notify: () => void): () => void;
}) {
  let frame: ReviewFrame | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<ReviewFrame> | undefined;
  let dirty = true;
  const listeners = new Set<(frame: ReviewFrame) => void>();
  async function refresh(): Promise<ReviewFrame> {
    if (pending) return pending;
    pending = (async () => {
      if (!dirty && frame) return frame;
      dirty = false;
      const done = startMeasurement("stream.project");
      const snapshot = await engine.snapshot();
      if (snapshot === frame?.snapshot) return frame;
      const previous = frame;
      const version = (previous?.version ?? 0) + 1;
      let update: ReviewUpdate | undefined;
      if (previous) {
        const old = previous.snapshot.messages;
        const next = snapshot.messages;
        let start = 0;
        let end = 0;
        while (start < old.length && start < next.length && old[start] === next[start]) start++;
        while (
          end < old.length - start &&
          end < next.length - start &&
          old[old.length - end - 1] === next[next.length - end - 1]
        )
          end++;
        const { messages: _messages, ...state } = snapshot;
        update = {
          baseVersion: previous.version,
          version,
          state,
          messages: {
            start,
            deleteCount: old.length - start - end,
            items: next.slice(start, next.length - end),
          },
        };
      }
      frame = { version, snapshot, update };
      done();
      for (const notify of listeners) notify(frame);
      return frame;
    })().finally(() => {
      pending = undefined;
      if (dirty && listeners.size) schedule();
    });
    return pending;
  }
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh().catch((error) => console.error("[Review] Stream projection failed:", error));
    }, 75);
    timer.unref();
  }
  const unsubscribe = engine.subscribe(() => {
    dirty = true;
    if (listeners.size) schedule();
  });
  return {
    current: refresh,
    subscribe(notify: (frame: ReviewFrame) => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    close() {
      clearTimeout(timer);
      unsubscribe();
      listeners.clear();
    },
  };
}

export function encodeReviewFrame(frame: ReviewFrame, lastVersion?: number) {
  const event = frame.update && frame.update.baseVersion === lastVersion ? "update" : "snapshot";
  const data = JSON.stringify(
    event === "update" ? frame.update : { version: frame.version, snapshot: frame.snapshot },
  );
  measure(`stream.${event}.bytes`, Buffer.byteLength(data));
  return { event, data };
}
