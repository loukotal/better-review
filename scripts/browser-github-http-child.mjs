import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

// Parent sets HOME, fake credentials and the isolated database before any app import.
assert.ok(process.env.BETTER_REVIEW_GITHUB_OUTBOX_DATABASE?.startsWith(process.env.HOME + "/"));
globalThis.fetch = async () => {
  throw new Error("Fixture forbids outbound fetch");
};

const requireBackend = createRequire(
  new URL("../packages/better-review/package.json", import.meta.url),
);
const { createHTTPHandler } = await import(
  requireBackend.resolve("@trpc/server/adapters/standalone")
);
const { createBrowserGithubActionsFixture } = await import("./browser-github-actions.mjs");
const { githubOutboxRouter } =
  await import("../packages/better-review/src/trpc/routers/github-outbox.ts");
const { router } = await import("../packages/better-review/src/trpc/index.ts");
const { createContext } = await import("../packages/better-review/src/trpc/context.ts");
const { runtime } = await import("../packages/better-review/src/runtime.ts");
const { startGithubOutboxRuntime, getGithubOutboxRuntime, stopGithubOutboxRuntime } =
  await import("../packages/better-review/src/github-outbox/runtime.ts");

const fixture = createBrowserGithubActionsFixture();
const httpCalls = [];
const faults = [];
const token = "stage9b-loopback-only";
const handler = createHTTPHandler({
  router: router({ githubOutbox: githubOutboxRouter }),
  createContext,
  basePath: "/api/trpc/",
  onError({ error }) {
    faults.push(error.message);
  },
});
// Fixture bearer check only. This deliberately does not claim main-server middleware coverage.
const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  const record = {
    path: new URL(request.url, "http://fixture").pathname,
    method: request.method,
    authorized: true,
  };
  httpCalls.push(record);
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    record.body = Buffer.concat(chunks).toString();
  });
  handler(request, response);
});
let shuttingDown;
async function shutdown() {
  return (shuttingDown ??= (async () => {
    await fixture.close(); // Always release held GitHub acknowledgements first.
    await stopGithubOutboxRuntime();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections();
    });
    await runtime.dispose();
    let runtimeStopped = false;
    try {
      getGithubOutboxRuntime();
    } catch {
      runtimeStopped = true;
    }
    return { serverClosed: !server.listening, runtimeStopped, faults, httpCalls };
  })());
}

try {
  await startGithubOutboxRuntime(fixture.adapter);
  await getGithubOutboxRuntime().refreshIdentity();
  assert.deepEqual(getGithubOutboxRuntime().actor(), fixture.actor);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.send({
    type: "ready",
    origin: `http://127.0.0.1:${server.address().port}`,
    token,
    pid: process.pid,
  });
} catch (error) {
  process.send({ type: "startup-error", error: error.stack });
  await shutdown();
  process.disconnect();
}

process.on("message", async ({ id, kind }) => {
  try {
    let value;
    if (kind === "inspect") {
      const db = new DatabaseSync(process.env.BETTER_REVIEW_GITHUB_OUTBOX_DATABASE, {
        readOnly: true,
      });
      try {
        value = {
          ...(await fixture.invoke({ kind: "state" })),
          operations: db
            .prepare("SELECT data FROM operations ORDER BY sequence")
            .all()
            .map((row) => JSON.parse(row.data)),
          httpCalls,
          faults,
          pid: process.pid,
        };
      } finally {
        db.close();
      }
    } else if (kind === "close") value = await shutdown();
    else if (
      [
        "hold-approval",
        "release-approval",
        "lose-applied-approval-response",
        "hold-review-read",
        "release-review-read",
      ].includes(kind)
    )
      value = await fixture.invoke({ kind });
    else throw new Error(`Unsupported fixture control: ${kind}`);
    process.send({ id, value }, () => {
      if (kind === "close") process.disconnect();
    });
  } catch (error) {
    process.send({ id, error: error.stack });
  }
});

process.on("disconnect", () => {
  void shutdown();
});
