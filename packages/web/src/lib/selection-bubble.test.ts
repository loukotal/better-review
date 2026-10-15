import assert from "node:assert/strict";
import test from "node:test";

import {
  claimSelectionBubble,
  positionSelectionBubble,
  watchSelectionBubble,
  selectionEndpointRect,
} from "./selection-bubble";

test("bubble prefers above, flips below, and clamps both viewport edges", () => {
  const size = { width: 160, height: 32 };
  const viewport = { width: 800, height: 600 };
  assert.deepEqual(
    positionSelectionBubble({ left: 300, right: 400, top: 200, bottom: 220 }, size, viewport),
    { left: 270, top: 162 },
  );
  assert.deepEqual(
    positionSelectionBubble({ left: 0, right: 20, top: 10, bottom: 30 }, size, viewport),
    { left: 8, top: 36 },
  );
  assert.deepEqual(
    positionSelectionBubble({ left: 790, right: 900, top: 590, bottom: 610 }, size, viewport),
    { left: 632, top: 552 },
  );
  assert.deepEqual(
    positionSelectionBubble({ left: 10, right: 30, top: 20, bottom: 599 }, size, viewport),
    { left: 8, top: 560 },
  );
});

test("missing, invalid, and off-screen anchors dismiss instead of leaving stale bubbles", () => {
  const size = { width: 160, height: 32 };
  const viewport = { width: 800, height: 600 };
  for (const rect of [
    null,
    { left: 10, right: 30, top: -30, bottom: -1 },
    { left: 10, right: 30, top: 600, bottom: 620 },
    { left: -40, right: -1, top: 50, bottom: 60 },
    { left: 801, right: 820, top: 50, bottom: 60 },
    { left: NaN, right: 10, top: 50, bottom: 60 },
  ])
    assert.equal(positionSelectionBubble(rect, size, viewport), null);
});

test("multiline anchoring follows the endpoint fragment, never the long-line union center", () => {
  const fragments = [
    { left: 100, right: 1100, top: 100, bottom: 120 },
    { left: 100, right: 180, top: 120, bottom: 140 },
    { left: 100, right: 125, top: 140, bottom: 160 },
  ];
  assert.deepEqual(selectionEndpointRect(fragments), {
    left: 124,
    right: 125,
    top: 140,
    bottom: 160,
  });
  assert.deepEqual(selectionEndpointRect(fragments, true), {
    left: 100,
    right: 101,
    top: 100,
    bottom: 120,
  });
  assert.equal(selectionEndpointRect([]), null);
});

test("expanded placement respects code/modal boundaries and flips within them", () => {
  const boundary = { left: 200, right: 700, top: 100, bottom: 650 };
  const size = { width: 360, height: 320 };
  assert.deepEqual(
    positionSelectionBubble(
      { left: 680, right: 681, top: 120, bottom: 140 },
      size,
      { width: 1000, height: 800 },
      boundary,
    ),
    { left: 340, top: 146 },
  );
  assert.deepEqual(
    positionSelectionBubble(
      { left: 210, right: 211, top: 600, bottom: 620 },
      size,
      { width: 1000, height: 800 },
      boundary,
    ),
    { left: 200, top: 274 },
  );
});

test("only the latest candidate owns a bubble; old cleanup cannot dismiss a newer candidate", () => {
  let firstHidden = 0;
  let secondHidden = 0;
  const releaseFirst = claimSelectionBubble(() => firstHidden++);
  const releaseSecond = claimSelectionBubble(() => secondHidden++);
  assert.equal(firstHidden, 1);
  releaseFirst();
  const releaseThird = claimSelectionBubble(() => {});
  assert.equal(secondHidden, 1);
  releaseSecond();
  releaseThird();
});

test("shared lifecycle coalesces measurements, dismisses on nested scroll, cancels and removes listeners", () => {
  const root = new EventTarget();
  const window = new EventTarget();
  const frames = new Map<number, () => void>();
  let next = 0;
  let updates = 0;
  let hidden = 0;
  const watcher = watchSelectionBubble({
    events: [root, window],
    update: () => updates++,
    hide: () => hidden++,
    schedule: (callback) => {
      frames.set(++next, callback);
      return next;
    },
    cancel: (id) => {
      frames.delete(id);
    },
  });
  root.dispatchEvent(new Event("selectionchange"));
  window.dispatchEvent(new Event("resize"));
  assert.equal(frames.size, 1);
  const initial = [...frames.values()][0]!;
  frames.clear();
  initial();
  assert.equal(updates, 1);
  root.dispatchEvent(new Event("scroll"));
  assert.equal(hidden, 1);
  watcher.refresh();
  const late = [...frames.values()][0]!;
  watcher.dispose();
  assert.equal(frames.size, 0);
  late();
  root.dispatchEvent(new Event("scroll"));
  root.dispatchEvent(new Event("selectionchange"));
  window.dispatchEvent(new Event("resize"));
  assert.equal(hidden, 1);
  assert.equal(updates, 1);
  assert.equal(frames.size, 0);
});
