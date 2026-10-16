import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

test(
  "real server boots read APIs when the durable outbox cannot open; unavailable writes fail closed",
  { timeout: 25_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "better-review-startup-"));
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    await writeFile(
      path.join(bin, "gh"),
      `#!/bin/sh
if [ "$1" = api ] && [ "$2" = user ]; then echo fixture-user; exit 0; fi
if [ "$1" = api ] && [ "$2" = graphql ]; then echo '{"data":{"requested":{"nodes":[]},"reviewed":{"nodes":[]},"authored":{"nodes":[]}}}'; exit 0; fi
exit 1
`,
      { mode: 0o755 },
    );
    const preload = path.join(directory, "no-network.mjs");
    await writeFile(
      preload,
      `globalThis.fetch = async () => { throw new Error("Network disabled in startup smoke test"); };`,
    );
    const databasePath = path.join(directory, "outbox.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA user_version=2147483647;");
    database.close();
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--import", preload, "src/index.ts"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          HOME: directory,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          NODE_ENV: "test",
          API_HOST: "127.0.0.1",
          API_PORT: "0",
          BETTER_REVIEW_DISABLE_API_AUTH: "1",
          BETTER_REVIEW_DATABASE_DIR: path.join(directory, "reviews"),
          BETTER_REVIEW_GITHUB_OUTBOX_DATABASE: databasePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<string>((resolve, reject) => {
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/API server running at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) resolve(match[1]!);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        reject(new Error(`Server exited before healthcheck (${code}/${signal}):\n${output}`)),
      );
      startupTimer = setTimeout(
        () => reject(new Error(`Server did not listen:\n${output}`)),
        15_000,
      );
    });
    try {
      const origin = await ready;
      clearTimeout(startupTimer);
      const health = await fetch(`${origin}/api/sessions/healthcheck`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });
      const list = await fetch(`${origin}/api/trpc/prs.list`);
      assert.equal(list.status, 200, await list.clone().text());
      assert.deepEqual((await list.json()).result.data.json.prs, []);
      const capability = await fetch(`${origin}/api/trpc/githubOutbox.capability`);
      assert.equal(capability.status, 503);
      assert.equal((await capability.json()).error.json.data.code, "SERVICE_UNAVAILABLE");
    } finally {
      clearTimeout(startupTimer);
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      await exited;
      clearTimeout(killTimer);
      const preserved = new DatabaseSync(databasePath);
      assert.equal(preserved.prepare("PRAGMA user_version").get()?.user_version, 2147483647);
      preserved.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
