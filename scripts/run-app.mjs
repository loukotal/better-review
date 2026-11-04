import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createAppSupervisor } from "./app-supervisor.mjs";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "production") throw new Error("Expected dev or production");
const repoRoot = resolve(import.meta.dirname, "..");
const secret = randomBytes(32).toString("hex");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
let child;
let exiting = false;
let controlUrl;
const shutdownSignal = new AbortController();

const startApp = async () => {
  if (exiting) throw new Error("Supervisor is shutting down");
  const args =
    mode === "production"
      ? ["--filter", "./packages/better-review", "start"]
      : [
          "exec",
          "concurrently",
          "--kill-others",
          "--names",
          "api,web",
          "--prefix-colors",
          "blue,green",
          "pnpm dev:api",
          "pnpm wait:api && pnpm dev:web",
        ];
  child = spawn(pnpm, args, {
    cwd: repoRoot,
    stdio: "inherit",
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      BETTER_REVIEW_SUPERVISOR_URL: controlUrl,
      BETTER_REVIEW_SUPERVISOR_TOKEN: secret,
    },
  });
  const launched = child;
  await new Promise((resolveSpawn, reject) => {
    launched.once("spawn", resolveSpawn);
    launched.once("error", reject);
  });
  launched.once("exit", (code) => {
    if (
      !exiting &&
      child === launched &&
      (!supervisor.status().job || ["ready", "failed"].includes(supervisor.status().job.phase))
    )
      void shutdown(code ?? 1);
  });
};
const stopApp = async () => {
  const current = child;
  child = undefined;
  if (!current?.pid) return;
  const closed =
    current.exitCode !== null || current.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolveClose) => current.once("exit", resolveClose));
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(current.pid), "/T", "/F"]);
  } else {
    try {
      process.kill(-current.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const timer = setTimeout(() => {
    if (process.platform !== "win32") {
      try {
        process.kill(-current.pid, "SIGKILL");
      } catch {}
    }
  }, 10_000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
  if (process.platform !== "win32") {
    const alive = () => {
      try {
        process.kill(-current.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 10_000;
    while (alive() && Date.now() < deadline) await delay(100);
    if (alive()) {
      try {
        process.kill(-current.pid, "SIGKILL");
      } catch {}
    }
  }
};
const waitReady = async (previousInstance) => {
  const token =
    process.env.BETTER_REVIEW_API_TOKEN?.trim() ||
    (await readFile(resolve(repoRoot, ".better-review-api-token"), "utf8").catch(() => "")).trim();
  const host =
    process.env.API_HOST && process.env.API_HOST !== "0.0.0.0" && process.env.API_HOST !== "::"
      ? process.env.API_HOST
      : "127.0.0.1";
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${process.env.API_PORT ?? 3001}/api/sessions/healthcheck`;
  const deadline = Date.now() + 90_000;
  while (!exiting && Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(2000),
      });
      const health = await response.json();
      if (response.ok && health.ok && health.instanceId && health.instanceId !== previousInstance) {
        if (mode === "dev") {
          const web = await fetch(`http://127.0.0.1:${process.env.WEB_PORT ?? 3000}/`, {
            signal: AbortSignal.timeout(2000),
          });
          if (!web.ok) throw new Error("Web is not ready");
        }
        return;
      }
    } catch {
      /* App is down briefly while the new process starts. */
    }
    await delay(500);
  }
  throw new Error("The restarted app did not become ready. Check the Better Review terminal logs.");
};
const supervisor = createAppSupervisor({
  repoRoot,
  mode,
  stopApp,
  startApp,
  waitReady,
  signal: shutdownSignal.signal,
});
const server = createServer(async (request, response) => {
  const provided = Buffer.from(request.headers.authorization?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    response.writeHead(401).end();
    return;
  }
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  try {
    if (request.method === "GET" && request.url === "/status") {
      response.end(JSON.stringify(supervisor.status()));
      return;
    }
    if (request.method !== "POST" || request.url !== "/update") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 4096) {
        response.writeHead(413).end();
        return;
      }
    }
    const result = supervisor.start(JSON.parse(body));
    response.writeHead(202).end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(400).end(JSON.stringify({ error: error.message }));
  }
});
async function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  shutdownSignal.abort();
  await stopApp();
  await supervisor.settled();
  server.closeAllConnections();
  server.close();
  process.exitCode = code;
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
controlUrl = `http://127.0.0.1:${server.address().port}`;
await startApp();
