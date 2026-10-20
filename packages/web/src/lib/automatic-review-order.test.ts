import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReviewSnapshot } from "@better-review/shared";

import {
  availableReviewOrder,
  createAutomaticOrderTracker,
  loadAutomaticReviewOrder,
  saveAutomaticReviewOrder,
} from "./automatic-review-order";

const scope = { prUrl: "pr/1", sessionId: "s", revision: "head", mode: "full" as const };
const savedScope = { sessionId: "s", mode: "full" as const, commitSha: null };
function snapshot(content = '<<REVIEW_ORDER>>["b", "a"]<</REVIEW_ORDER>>'): ReviewSnapshot {
  return {
    sessionId: "s",
    revision: "head",
    running: false,
    compacting: false,
    settlements: [{ submissionId: "run", outcome: "completed" }],
    messages: [
      {
        id: "m",
        role: "assistant",
        submissionId: "run",
        parts: [{ type: "text", text: content }],
        metadata: { timestamp: "2026-01-01", revision: "head" },
      },
    ],
  };
}
function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
test("preference defaults on, preserves explicit versioned choices, survives reload", () => {
  const store = memory();
  assert.equal(loadAutomaticReviewOrder(store), true);
  saveAutomaticReviewOrder(true, store);
  assert.equal(loadAutomaticReviewOrder(store), true);
  saveAutomaticReviewOrder(false, store);
  assert.equal(loadAutomaticReviewOrder(store), false);
  for (const value of [
    "null",
    "true",
    "false",
    "{",
    "[]",
    "{}",
    '{"version":2,"enabled":true}',
    '{"version":2,"enabled":false}',
    '{"enabled":false}',
    '{"version":1}',
    '{"version":1,"enabled":"true"}',
    '{"version":1,"enabled":"false"}',
    '{"version":1,"enabled":0}',
    '{"version":1,"enabled":null}',
  ]) {
    assert.equal(loadAutomaticReviewOrder({ ...store, getItem: () => value }), true, value);
  }
});
test("storage errors are nonfatal and in-memory consumption still works", () => {
  const store = {
    getItem: () => {
      throw Error("denied");
    },
    setItem: () => {
      throw Error("quota");
    },
  };
  assert.equal(loadAutomaticReviewOrder(store), true);
  assert.doesNotThrow(() => saveAutomaticReviewOrder(true, store));
  const tracker = createAutomaticOrderTracker(store),
    order = availableReviewOrder(snapshot(), scope, savedScope)!;
  assert.deepEqual(tracker.take(order, ["a", "b"]), ["b", "a"]);
  assert.equal(tracker.take(order, ["a", "b"]), null);
});
test("only completed, session/revision matched orders, never live or failed output", () => {
  const value = snapshot();
  assert.deepEqual(availableReviewOrder(value, scope, savedScope)?.files, ["b", "a"]);
  assert.equal(availableReviewOrder({ ...value, running: true }, scope, savedScope), null);
  assert.equal(availableReviewOrder({ ...value, sessionId: "old" }, scope, savedScope), null);
  assert.equal(availableReviewOrder({ ...value, revision: "old" }, scope, savedScope), null);
  assert.equal(availableReviewOrder(value, { ...scope, revision: "new" }, savedScope), null);
  for (const outcome of ["aborted", "failed"] as const)
    assert.equal(
      availableReviewOrder(
        { ...value, settlements: [{ submissionId: "run", outcome }] },
        scope,
        savedScope,
      ),
      null,
    );
  for (const content of [
    '<<REVIEW_ORDER>>["a"]',
    "<<REVIEW_ORDER>>[1]<</REVIEW_ORDER>>",
    "<<REVIEW_ORDER>>[]<</REVIEW_ORDER>>",
    '<<REVIEW_ORDER>>["a","a"]<</REVIEW_ORDER>>',
  ])
    assert.equal(availableReviewOrder(snapshot(content), scope, savedScope), null);
});
test("consume once across polls and reload; distinct PR/session/head/message/order/scope applies anew", () => {
  const store = memory(),
    tracker = createAutomaticOrderTracker(store),
    order = availableReviewOrder(snapshot(), scope, savedScope)!;
  assert.equal(tracker.take(order, ["a"]), null);
  assert.deepEqual(tracker.take(order, ["a", "b"]), ["b", "a"]);
  assert.equal(tracker.take({ ...order }, ["a", "b"]), null);
  assert.equal(createAutomaticOrderTracker(store).take(order, ["a", "b"]), null);
  for (const changed of [
    { prUrl: "pr/2" },
    { sessionId: "other" },
    { revision: "new" },
    { messageId: "new" },
    { files: ["a", "b"] },
    { mode: "commit" as const },
  ])
    assert.ok(tracker.take({ ...order, ...changed }, ["a", "b"]));
});
test("saved session scope, not equal SHAs or UI mode, authorizes automatic order", () => {
  const value = snapshot();
  const commitScope = { ...savedScope, mode: "commit" as const, commitSha: "head" };
  assert.equal(availableReviewOrder(value, scope, null), null);
  assert.equal(availableReviewOrder(value, scope, commitScope), null);
  assert.equal(availableReviewOrder(value, { ...scope, mode: "commit" }, savedScope), null);
  assert.ok(availableReviewOrder(value, { ...scope, mode: "commit" }, commitScope));
  assert.equal(
    availableReviewOrder(
      value,
      { ...scope, mode: "commit" },
      { ...commitScope, commitSha: "other" },
    ),
    null,
  );
  assert.equal(availableReviewOrder(value, scope, { ...savedScope, sessionId: "other" }), null);
});
test("conversion boundary rejects old same-SHA output until the admitted full-PR continuation", () => {
  const value = snapshot();
  assert.equal(
    availableReviewOrder(value, scope, { ...savedScope, afterSubmissionId: null }),
    null,
  );
  const converted = { ...savedScope, afterSubmissionId: "full-pr-continuation" };
  assert.equal(availableReviewOrder(value, scope, converted), null);
  value.messages.push({
    ...value.messages[0],
    id: "new-order",
    submissionId: "full-pr-continuation",
  });
  assert.equal(availableReviewOrder({ ...value, running: true }, scope, converted), null);
  value.settlements.push({ submissionId: "full-pr-continuation", outcome: "completed" });
  assert.equal(availableReviewOrder(value, scope, converted)?.messageId, "new-order");
  assert.equal(
    availableReviewOrder(value, scope, { ...savedScope, afterSubmissionId: "different" }),
    null,
  );
});
