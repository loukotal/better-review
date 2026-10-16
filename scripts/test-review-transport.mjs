import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { chromium } from "playwright";

import config from "./browser-vite.config.mjs";

const requireWeb = createRequire(new URL("../packages/web/package.json", import.meta.url));
const { createServer } = await import(requireWeb.resolve("vite"));
const streams = new Set();
const requests = [];
let maximumStreams = 0;
let version = 0;
let failStreams = false;
let holdPolls = false;
const pendingPolls = new Set();
const snapshot = (sessionId) => ({
  sessionId,
  revision: "stable-reviewed-revision",
  running: false,
  compacting: false,
  messages: [
    {
      id: "message",
      role: "assistant",
      parts: [{ type: "text", text: `revision-${version}` }],
      metadata: { timestamp: "2026-01-01T00:00:00Z", revision: "stable-reviewed-revision" },
    },
  ],
  settlements: version ? [{ submissionId: "admission", outcome: "completed" }] : [],
});
const frame = (entry) =>
  `event: snapshot\ndata: ${JSON.stringify({ version, snapshot: snapshot(entry.id) })}\n\n`;
const json = (response, value) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
};
const server = await createServer({
  ...config,
  configFile: false,
  plugins: [
    ...config.plugins,
    {
      name: "review-transport-http1-fixture",
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          const path = new URL(request.url, "http://localhost").pathname;
          if (path === "/transport-test") {
            response.setHeader("content-type", "text/html");
            response.end(`<!doctype html><title>Review transport regression</title><script type="module">
            import { createReviewClient } from '/src/lib/review-client.ts';
            import { mountTransportChat } from '/src/browser-tests/review-transport-fixture.ts';
            window.snapshots = []; window.errors = []; window.connections = 0;
            window.start = (id = 'session') => {
              window.stop?.();
              window.client = createReviewClient(id);
              window.stop = window.client.observe(value => window.snapshots.push(value), error => window.errors.push(error), () => window.connections++);
            };
            window.startHook = () => {
              const mounted = mountTransportChat();
              window.stop = mounted.dispose;
              window.chat = mounted.chat;
            };
            window.ready = true;
          </script>`);
            return;
          }
          if (!path.startsWith("/api/")) return next();
          requests.push({ path, method: request.method });
          if (request.headers.authorization !== "Bearer offline-test-token") {
            response.statusCode = 403;
            return response.end("Missing test auth");
          }
          if (path.endsWith("/events")) {
            if (failStreams) {
              response.statusCode = 503;
              return response.end("Controlled reconnect failure");
            }
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            });
            const entry = { response, id: path.split("/").at(-2) };
            streams.add(entry);
            maximumStreams = Math.max(maximumStreams, streams.size);
            response.write(frame(entry));
            response.on("close", () => streams.delete(entry));
          } else if (request.method === "POST") {
            // Real HTTP requests to isolated local endpoints, never a real model/GitHub API.
            json(response, { submissionId: "admission", ok: true });
          } else if (/\/api\/review\/sessions\//.test(path)) {
            if (holdPolls) {
              pendingPolls.add(response);
              response.on("close", () => pendingPolls.delete(response));
            } else json(response, snapshot(path.split("/").at(-1)));
          } else json(response, { ok: true });
        });
      },
    },
  ],
});
let browser;
async function eventually(check, message, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}
try {
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, "");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addInitScript(() =>
    localStorage.setItem("better-review.apiToken", "offline-test-token"),
  );
  const pages = [];
  const pageErrors = [];
  for (let index = 0; index < 8; index++) {
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("dialog", () => assert.fail("Unexpected authentication prompt"));
    await page.goto(`${origin}/transport-test`);
    await page.waitForFunction(() => window.ready);
    pages.push(page);
  }
  // Negative control: six uncapped streams reproduce the actual browser queue,
  // despite a healthy server. No routing/fetch mocks can mask this failure.
  const uncapped = await pages[0].evaluate(async () => {
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const headers = { Authorization: "Bearer offline-test-token" };
    try {
      await Promise.all(
        controllers.map((controller) =>
          fetch("/api/review/sessions/control/events", { headers, signal: controller.signal }),
        ),
      );
      try {
        await fetch("/api/health", { headers, signal: AbortSignal.timeout(800) });
        return false;
      } catch {
        return true;
      }
    } finally {
      controllers.forEach((controller) => controller.abort());
    }
  });
  assert.equal(uncapped, true, "Negative control did not reproduce HTTP/1.1 starvation");
  await eventually(() => streams.size === 0, "Control streams did not close");
  maximumStreams = 0;
  console.log("PASS negative control: six uncapped SSE streams block browser HTTP requests");
  await Promise.all(
    pages.map((page, index) => page.evaluate((index) => window.start(`session-${index}`), index)),
  );
  await eventually(
    async () =>
      (
        await Promise.all(pages.map((page) => page.evaluate(() => window.snapshots.length > 0)))
      ).every(Boolean),
    "All eight viewers must initialize over HTTP/1.1",
  );
  assert.equal(streams.size, 2, "Exactly two observers should hold persistent sockets");
  assert.ok(maximumStreams <= 2, "Cross-tab SSE cap exceeded");
  assert.equal(
    await pages[0].evaluate(async () => (await navigator.locks.query()).pending.length),
    0,
    "Viewers must never queue for stream locks",
  );
  const writes = await pages[7].evaluate(async () => {
    const auth = { Authorization: "Bearer offline-test-token" };
    const results = await Promise.race([
      Promise.all([
        window.client.send("mock follow-up", "test-request-key"),
        fetch("/api/trpc/pr.replyToComment", {
          method: "POST",
          headers: auth,
          body: "mock reply",
          signal: AbortSignal.timeout(3000),
        }).then((response) => response.json()),
        fetch("/api/health", { headers: auth, signal: AbortSignal.timeout(3000) }).then(
          (response) => response.json(),
        ),
      ]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Writes blocked behind review observers")), 3000),
      ),
    ]);
    return results;
  });
  assert.equal(writes[0].submissionId, "admission");
  assert.equal(writes[1].ok, true);
  assert.equal(writes[2].ok, true);
  const navigation = await context.newPage();
  await navigation.goto(`${origin}/transport-test?navigated=1`, { timeout: 3000 });
  await navigation.waitForFunction(() => window.ready, undefined, { timeout: 3000 });
  await navigation.close();
  version++;
  for (const entry of streams) entry.response.write(frame(entry));
  await eventually(
    async () =>
      (
        await Promise.all(
          pages.map((page) =>
            page.evaluate(
              () =>
                window.snapshots.at(-1)?.settlements[0]?.submissionId === "admission" &&
                window.snapshots.at(-1)?.revision === "stable-reviewed-revision",
            ),
          ),
        )
      ).every(Boolean),
    "Streaming and polling viewers must receive completion with pinned revisions",
  );
  console.log(
    "PASS eight same-origin viewers, two SSE sockets, HTTP writes/health/navigation, snapshot settlements",
  );

  const originalHolders = [...streams].map((entry) => entry.id);
  const holderIndex = Number(originalHolders[0].split("-").at(-1));
  await pages[holderIndex].evaluate(() => window.stop());
  await eventually(
    () => streams.size === 2 && [...streams].some((entry) => !originalHolders.includes(entry.id)),
    "Polling viewer did not acquire a released stream slot",
  );
  await pages[holderIndex].evaluate((index) => window.start(`session-${index}`), holderIndex);

  // All observers must release sockets/timers on hide, then reacquire on show.
  await Promise.all(
    pages.map((page) =>
      page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      }),
    ),
  );
  await eventually(() => streams.size === 0, "Hidden viewers leaked streams");
  const hiddenRequests = requests.length;
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(requests.length, hiddenRequests, "Hidden viewers should not poll");
  await Promise.all(
    pages.map((page) =>
      page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }),
    ),
  );
  await eventually(() => streams.size === 2, "Visible viewers must reacquire released slots");

  failStreams = true;
  for (const entry of streams) entry.response.end();
  await eventually(
    async () =>
      (await Promise.all(pages.map((page) => page.evaluate(() => window.errors.length)))).some(
        Boolean,
      ),
    "EOF must report reconnect status",
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  failStreams = false;
  await eventually(
    () => streams.size === 2,
    "EOF/failed fetch leaked locks or prevented reconnect",
  );
  assert.ok(maximumStreams <= 2);
  await Promise.all(pages.map((page) => page.evaluate(() => window.stop())));
  await eventually(() => streams.size === 0, "Closing observers leaked streams");
  console.log("PASS visibility release/resume, EOF/error reconnect and disposal");

  // No Web Locks: fail closed to finite polling, including cancellation of a
  // pending old-session poll before starting another observer.
  await pages[0].evaluate(() =>
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }),
  );
  holdPolls = true;
  await pages[0].evaluate(() => window.start("old-session"));
  await eventually(() => pendingPolls.size === 1, "Fallback did not poll without Web Locks");
  await pages[0].evaluate(() => {
    window.stop();
    window.snapshots = [];
  });
  await eventually(() => pendingPolls.size === 0, "Disposal did not cancel the old poll");
  holdPolls = false;
  await pages[0].evaluate(() => window.start("new-session"));
  await eventually(
    () => pages[0].evaluate(() => window.snapshots.at(-1)?.sessionId === "new-session"),
    "Fallback polling did not hydrate the new session",
  );
  assert.equal(streams.size, 0, "Missing Web Locks must not permit uncapped SSE");
  assert.deepEqual(pageErrors, []);
  await pages[0].evaluate(() => window.stop());

  // The real UI hook must settle a pending admission from polling snapshots,
  // not merely update an isolated transport callback.
  version = 0;
  await pages[0].evaluate(() => window.startHook());
  await eventually(
    () => pages[0].evaluate(() => window.chat.messages().length > 0),
    "Polling did not hydrate the actual chat hook",
  );
  await pages[0].evaluate(() => {
    window.sendResult = undefined;
    window.chat.sendMessage("mock hook follow-up").then((result) => (window.sendResult = result));
  });
  await eventually(
    () => pages[0].evaluate(() => window.chat.isStreaming()),
    "Hook did not enter pending state",
  );
  version = 1;
  await eventually(
    () =>
      pages[0].evaluate(
        () =>
          window.sendResult === true &&
          !window.chat.isStreaming() &&
          window.chat.revision() === "stable-reviewed-revision",
      ),
    "Polling did not settle the actual UI admission",
  );
  await pages[0].evaluate(() => window.stop());

  await pages[1].evaluate(() => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: () => Promise.reject(new Error("Web Locks denied")) },
    });
    window.snapshots = [];
    window.start("denied-locks");
  });
  await eventually(
    () => pages[1].evaluate(() => window.snapshots.at(-1)?.sessionId === "denied-locks"),
    "Denied Web Locks must fall back to polling",
  );
  assert.equal(streams.size, 0);
  await pages[1].evaluate(() => window.stop());
  await context.close();
  console.log("PASS no-Web-Locks fallback, old-poll cancellation and actual chat hook settlement");
} finally {
  await browser?.close();
  for (const entry of streams) entry.response.end();
  for (const response of pendingPolls) response.end();
  await server.close();
}
