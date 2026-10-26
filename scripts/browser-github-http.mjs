import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** One isolated production-router/runtime process, retained across the browser reload. */
export async function createBrowserGithubHttp() {
  const directory = await mkdtemp(join(tmpdir(), "better-review-http-composition-"));
  const child = fork(
    fileURLToPath(new URL("./browser-github-http-child.mjs", import.meta.url)),
    [],
    {
      execArgv: ["--import", "tsx"],
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        TMPDIR: directory,
        XDG_CONFIG_HOME: directory,
        GH_TOKEN: "stage9b-not-a-real-token",
        BETTER_REVIEW_GITHUB_OUTBOX_DATABASE: join(directory, "outbox.sqlite"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let logs = "";
  child.stdout.on("data", (data) => {
    logs += data;
  });
  child.stderr.on("data", (data) => {
    logs += data;
  });
  const exited = once(child, "exit");
  let nextId = 0;
  const pending = new Map();
  const bounded = (work, ms, label) => {
    let timer;
    return Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}\n${logs}`)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  const request = (kind) =>
    bounded(
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        child.send({ id, kind }, (error) => {
          if (error) reject(error);
        });
      }),
      8000,
      `Fixture control timed out: ${kind}`,
    );
  let ready;
  const startup = new Promise((resolve, reject) => {
    ready = { resolve, reject };
  });
  const receive = (message) => {
    if (message.type === "ready") ready.resolve(message);
    else if (message.type === "startup-error") ready.reject(new Error(message.error));
    else {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error));
      else waiter?.resolve(message.value);
    }
  };
  child.on("message", receive);
  child.on("exit", (code, signal) => {
    const error = new Error(`Fixture process exited (${code}/${signal})\n${logs}`);
    ready.reject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  let closePromise;
  const close = () =>
    (closePromise ??= (async () => {
      let report;
      try {
        if (child.exitCode === null && child.signalCode === null) report = await request("close");
        const [code, signal] = await bounded(
          exited,
          8000,
          "Fixture did not exit after closing resources",
        );
        assert.equal(code, 0);
        assert.equal(signal, null);
        assert.ok(
          report?.serverClosed && report?.runtimeStopped,
          "HTTP server/runtime did not close",
        );
        assert.deepEqual(report.faults, [], "Production tRPC procedures reported errors");
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await bounded(exited, 3000, "Fixture process survived SIGKILL");
        }
        child.off("message", receive);
        await rm(directory, { recursive: true, force: true });
      }
      let storageRemoved = false;
      try {
        await access(directory);
      } catch (error) {
        if (error.code === "ENOENT") storageRemoved = true;
        else throw error;
      }
      assert.ok(storageRemoved);
      return {
        serverClosed: report.serverClosed,
        runtimeStopped: report.runtimeStopped,
        faults: report.faults,
        httpProcedures: report.httpCalls.reduce((counts, call) => {
          const name = call.path.split("/").at(-1);
          counts[name] = (counts[name] ?? 0) + 1;
          return counts;
        }, {}),
        processExited: true,
        storageRemoved,
      };
    })());
  try {
    const info = await bounded(startup, 15000, "Production router fixture did not start");
    return { ...info, invoke: request, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
