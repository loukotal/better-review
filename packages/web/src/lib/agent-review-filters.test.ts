import assert from "node:assert/strict";
import test from "node:test";

import type { ReviewSession, ReviewSessionStatus } from "@better-review/shared";

import { filterAgentReviewSessions } from "./agent-review-filters";

const now = Date.UTC(2026, 8, 15, 12);

function session(id: string, status: ReviewSessionStatus, createdAt: number): ReviewSession {
  return {
    id,
    status,
    createdAt,
    mode: "plan",
    origin: "pi",
    title: id,
    payload: { kind: "markdown", content: "" },
  };
}

const sessions = [
  session("recent-pending", "pending", now - 2 * 60 * 60 * 1_000),
  session("boundary-pending", "pending", now - 24 * 60 * 60 * 1_000),
  session("old-pending", "pending", now - 24 * 60 * 60 * 1_000 - 1),
  session("recent-approved", "approved", now - 60 * 60 * 1_000),
];

test("the default filters include only pending reviews no older than 24 hours", () => {
  assert.deepEqual(
    filterAgentReviewSessions(sessions, "pending", "24h", now).map(({ id }) => id),
    ["recent-pending", "boundary-pending"],
  );
});

test("status and age filters can both be broadened", () => {
  assert.deepEqual(
    filterAgentReviewSessions(sessions, "all", "24h", now).map(({ id }) => id),
    ["recent-pending", "boundary-pending", "recent-approved"],
  );
  assert.deepEqual(
    filterAgentReviewSessions(sessions, "pending", "all", now).map(({ id }) => id),
    ["recent-pending", "boundary-pending", "old-pending"],
  );
});
