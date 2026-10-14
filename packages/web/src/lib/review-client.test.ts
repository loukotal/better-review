import assert from "node:assert/strict";
import test from "node:test";

import { createReviewClient } from "./review-client";

test("review admission sends authentication and the caller's idempotency key", async (t) => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "test-token", removeItem: () => {}, setItem: () => {} },
  });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, "/api/review/sessions/session");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
    assert.deepEqual(JSON.parse(String(init?.body)), { body: "Review", requestId: "same-key" });
    return Response.json({ submissionId: "1" });
  });
  assert.deepEqual(await createReviewClient("session").send("Review", "same-key"), {
    submissionId: "1",
  });
});
