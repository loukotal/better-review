import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createAppUpdateControl } from "./app-update-control";

const checkout = "a".repeat(40);
const target = "b".repeat(40);
const body = () => ({
  requestId: randomUUID(),
  checkoutRevision: checkout,
  targetRevision: target,
});
function fixture() {
  const requests: { url: string; init?: RequestInit }[] = [];
  const control = createAppUpdateControl({
    instanceId: "running-instance",
    apiToken: "user-token",
    supervisorUrl: "http://127.0.0.1:12345",
    supervisorToken: "private-supervisor-token",
    checkStatus: async () => ({
      updateAvailable: true,
      checkoutRevision: checkout,
      latestRevision: target,
      updateAction: "fast-forward",
    }),
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/status")) return Response.json({});
      return Response.json({
        job: { id: "job", phase: "installing", targetRevision: target, startedAt: 1 },
      });
    },
  });
  const request = (
    value: unknown = body(),
    headers = { Authorization: "Bearer user-token", "Content-Type": "application/json" },
  ) =>
    new Request("http://localhost/api/app/update-job", {
      method: "POST",
      headers,
      body: JSON.stringify(value),
    });
  return { control, requests, request };
}

test("one-click update requires explicit bearer auth, not a cookie or cross-site form", async () => {
  const f = fixture();
  const attempts: Record<string, string>[] = [
    { Cookie: "better_review_api_token=user-token", "Content-Type": "application/json" },
    { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
  ];
  for (const headers of attempts) {
    const response = await f.control.start(
      new Request("http://localhost/api/app/update-job", {
        method: "POST",
        headers,
        body: JSON.stringify(body()),
      }),
    );
    assert.equal(response.status, 403);
  }
  assert.deepEqual(f.requests, []);
});

test("restart request uses server-owned identity and forwards only validated revisions", async () => {
  const f = fixture();
  const input = { ...body(), instanceId: "attacker", command: "do not execute" };
  const response = await f.control.start(f.request(input));
  assert.equal(response.status, 202);
  const admitted = f.requests.find((request) => request.url.endsWith("/update"))!;
  assert.deepEqual(JSON.parse(String(admitted.init!.body)), {
    requestId: input.requestId,
    instanceId: "running-instance",
    checkoutRevision: checkout,
    targetRevision: target,
  });
  assert.equal(
    (admitted.init!.headers as Record<string, string>).Authorization,
    "Bearer private-supervisor-token",
  );
  assert.ok(!(await response.text()).includes("private-supervisor-token"));
});

test("changed update advice and malformed requests never reach the supervisor", async () => {
  const f = fixture();
  assert.equal(
    (await f.control.start(f.request({ ...body(), targetRevision: checkout }))).status,
    409,
  );
  assert.equal((await f.control.start(f.request({ ...body(), requestId: "../file" }))).status, 400);
  assert.equal((await f.control.start(f.request(null))).status, 400);
  assert.ok(f.requests.every((request) => request.init?.method === "GET"));
});

test("unmanaged or unauthenticated deployments cannot enable host restart", async () => {
  for (const extra of [
    {},
    { apiToken: "user-token", authDisabled: true },
    { apiToken: "user-token" },
  ]) {
    const control = createAppUpdateControl({
      instanceId: "instance",
      checkStatus: async () => ({ updateAvailable: false }),
      ...extra,
    });
    assert.equal(control.supported, false);
    assert.deepEqual(await control.status(), { supported: false, instanceId: "instance" });
  }
});

test("a lost acknowledgement reuses its job even after the new revision is running", async () => {
  const input = body();
  let reads = 0;
  const control = createAppUpdateControl({
    instanceId: "new-instance",
    apiToken: "user-token",
    supervisorUrl: "http://127.0.0.1:12345",
    supervisorToken: "private",
    checkStatus: async () => {
      throw new Error("A retry must not re-check or re-apply Git updates");
    },
    fetch: async (_url, init) => {
      reads++;
      assert.equal(init?.method, "GET");
      return Response.json({
        job: {
          id: input.requestId,
          phase: "ready",
          previousInstanceId: "old-instance",
          targetRevision: target,
          startedAt: 1,
        },
      });
    },
  });
  const response = await control.start(
    new Request("http://localhost/api/app/update-job", {
      method: "POST",
      headers: { Authorization: "Bearer user-token", "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).instanceId, "old-instance");
  assert.equal(reads, 1);
});
