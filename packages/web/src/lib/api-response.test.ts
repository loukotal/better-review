import assert from "node:assert/strict";
import test from "node:test";

import { checkApiResponse } from "./api-response";

test("empty and HTML proxy failures explain API unavailability rather than JSON parsing", () => {
  for (const status of [502, 503, 504]) {
    assert.throws(() => checkApiResponse(new Response("", { status })), /API is unavailable/);
    assert.throws(
      () =>
        checkApiResponse(
          new Response("<h1>Bad gateway</h1>", {
            status,
            headers: { "content-type": "text/html" },
          }),
        ),
      /API is unavailable/,
    );
  }
});

test("structured errors and successes remain available to the tRPC decoder", async () => {
  const error = Response.json({ error: { message: "Precise server failure" } }, { status: 500 });
  assert.equal(checkApiResponse(error), error);
  assert.deepEqual(await error.json(), { error: { message: "Precise server failure" } });
  const ok = Response.json({ result: "ok" });
  assert.equal(checkApiResponse(ok), ok);
});
