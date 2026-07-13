import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { corsMiddleware } from "./cors";

const allowedOrigin = `http://localhost:${process.env.WEB_PORT ?? "3000"}`;

function createTestApp() {
  const child = new Hono().get("/agents/:name/:id", (context) =>
    context.json({ id: context.req.param("id") }, 404),
  );
  const app = new Hono();
  app.use("*", corsMiddleware);
  app.route("/flue", child);
  return app;
}

test("adds CORS headers to mounted Flue-style routes", async () => {
  const response = await createTestApp().request("http://api/flue/agents/pr-reviewer/session", {
    headers: { Origin: allowedOrigin },
  });

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), allowedOrigin);
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.match(response.headers.get("Access-Control-Expose-Headers") ?? "", /Stream-Next-Offset/);
  assert.match(response.headers.get("Access-Control-Expose-Headers") ?? "", /Stream-Up-To-Date/);
});

test("answers allowed preflight requests before mounted routes", async () => {
  const response = await createTestApp().request("http://api/flue/agents/pr-reviewer/session", {
    method: "OPTIONS",
    headers: { Origin: allowedOrigin },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), allowedOrigin);
});

test("does not allow unknown origins", async () => {
  const response = await createTestApp().request("http://api/flue/agents/pr-reviewer/session", {
    headers: { Origin: "https://example.com" },
  });

  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});
