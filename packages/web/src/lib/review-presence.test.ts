import assert from "node:assert/strict";
import { test } from "node:test";

import { startReviewPresence } from "./review-presence";

test("review presence heartbeats, closes on pagehide, resumes on restore, and cleans up", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const events = new EventTarget();
  const sent: boolean[] = [];
  const stop = startReviewPresence("review", events, (active) => sent.push(active));
  assert.deepEqual(sent, [true]);
  t.mock.timers.tick(15_000);
  assert.deepEqual(sent, [true, true]);
  events.dispatchEvent(new Event("pagehide"));
  t.mock.timers.tick(15_000);
  assert.deepEqual(sent, [true, true, false]);
  events.dispatchEvent(new Event("pageshow"));
  assert.deepEqual(sent, [true, true, false, true]);
  stop();
  t.mock.timers.tick(15_000);
  events.dispatchEvent(new Event("pageshow"));
  assert.deepEqual(sent, [true, true, false, true, false]);
});
