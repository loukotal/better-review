import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createAppSupervisor, runCommand } from "./app-supervisor.mjs";

test("update commands time out and support supervisor cancellation", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 100 }),
    /timed out/,
  );
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(runCommand("must-not-be-spawned", [], { signal: cancellation.signal }), {
    name: "AbortError",
  });
});

async function fixture(t, mode = "dev") {
  const root = await mkdtemp(join(tmpdir(), "better-review-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => runCommand("git", args, { cwd: root });
  await git("init", "-b", "main");
  await writeFile(join(root, ".gitignore"), "node_modules/\npackages/web/dist/\n");
  await writeFile(join(root, "source.txt"), "original");
  const commit = async () => {
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  const revision = await commit();
  const calls = [];
  let failCommand;
  let readyFailures = 0;
  const supervisor = createAppSupervisor({
    repoRoot: root,
    mode,
    run: async (command, args, options) => {
      if (command === "git") return runCommand(command, args, options);
      calls.push(args);
      if (args.includes(failCommand)) throw new Error("injected command failure");
      if (args.includes("--outDir")) {
        const dist = args[args.indexOf("--outDir") + 1];
        await mkdir(dist, { recursive: true });
        await writeFile(join(dist, "index.html"), "new build");
      }
      return "";
    },
    stopApp: async () => {
      calls.push("stop");
    },
    startApp: async () => {
      calls.push("start");
    },
    waitReady: async () => {
      calls.push("healthy");
      if (readyFailures-- > 0) throw new Error("injected boot failure");
    },
  });
  const request = () => ({
    requestId: randomUUID(),
    checkoutRevision: revision,
    targetRevision: revision,
    instanceId: "old-instance",
  });
  return {
    root,
    git,
    revision,
    commit,
    calls,
    supervisor,
    request,
    fail: (value) => {
      failCommand = value;
    },
    failBoot: () => {
      readyFailures = 1;
    },
  };
}

test("restart preserves dirty edits, installs once, and acknowledges idempotent/concurrent clicks", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "source.txt"), "unsaved local edit");
  const request = f.request();
  const first = f.supervisor.start(request);
  assert.equal(f.supervisor.start(request).job.id, first.job.id);
  assert.equal(f.supervisor.start({ ...request, requestId: randomUUID() }).job.id, first.job.id);
  await f.supervisor.settled();
  assert.equal(f.supervisor.status().job.phase, "ready");
  assert.deepEqual(f.calls, [["install", "--frozen-lockfile"], "stop", "start", "healthy"]);
  f.supervisor.start(request);
  await f.supervisor.settled();
  assert.equal(f.calls.length, 4, "Lost response must not execute an accepted request twice");
  assert.equal(await readFile(join(f.root, "source.txt"), "utf8"), "unsaved local edit");
});

test("install failure leaves the running app up and permits an explicit new retry", async (t) => {
  const f = await fixture(t);
  f.fail("install");
  f.supervisor.start(f.request());
  await f.supervisor.settled();
  assert.equal(f.supervisor.status().job.phase, "failed");
  assert.match(f.supervisor.status().job.error, /injected command failure/);
  assert.ok(!f.calls.includes("stop"));
  f.fail(undefined);
  f.supervisor.start(f.request());
  await f.supervisor.settled();
  assert.equal(f.supervisor.status().job.phase, "ready");
});

test("changed checkout and feature branch refuse installation or restart", async (t) => {
  const f = await fixture(t);
  f.supervisor.start({ ...f.request(), checkoutRevision: "a".repeat(40) });
  await f.supervisor.settled();
  assert.match(f.supervisor.status().job.error, /checkout changed/);
  await f.git("checkout", "-b", "feature");
  f.supervisor.start(f.request());
  await f.supervisor.settled();
  assert.match(f.supervisor.status().job.error, /main branch/);
  assert.deepEqual(f.calls, []);
});

test("dirty checkout refuses a Git update without discarding files", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "untracked.txt"), "keep me");
  f.supervisor.start({ ...f.request(), targetRevision: "a".repeat(40) });
  await f.supervisor.settled();
  assert.match(f.supervisor.status().job.error, /Local changes/);
  assert.equal(await readFile(join(f.root, "untracked.txt"), "utf8"), "keep me");
  assert.deepEqual(f.calls, []);
});

test("clean checkout fast-forwards only to the offered upstream revision", async (t) => {
  const f = await fixture(t);
  const remote = join(f.root, "node_modules", "upstream.git");
  await mkdir(join(f.root, "node_modules"), { recursive: true });
  await f.git("init", "--bare", "-b", "main", remote);
  await f.git("remote", "add", "origin", remote);
  await f.git("push", "origin", "main");
  await writeFile(join(f.root, "source.txt"), "upstream change");
  const target = await f.commit();
  await f.git("push", "origin", "main");
  // Test-only fixture preparation: make the local branch lag its upstream.
  await f.git("checkout", "-b", "old-main", f.revision);
  await f.git("branch", "-f", "main", f.revision);
  await f.git("checkout", "main");
  f.supervisor.start({ ...f.request(), targetRevision: target });
  await f.supervisor.settled();
  assert.equal(f.supervisor.status().job.phase, "ready");
  assert.equal(await f.git("rev-parse", "HEAD"), target);
  assert.equal(await readFile(join(f.root, "source.txt"), "utf8"), "upstream change");
});

test("diverged local commits and a newly moved upstream are never merged automatically", async (t) => {
  const f = await fixture(t);
  const remote = join(f.root, "node_modules", "upstream.git");
  await mkdir(join(f.root, "node_modules"), { recursive: true });
  await f.git("init", "--bare", "-b", "main", remote);
  await f.git("remote", "add", "origin", remote);
  await f.git("push", "origin", "main");
  await writeFile(join(f.root, "source.txt"), "upstream");
  const target = await f.commit();
  await f.git("push", "origin", "main");
  await f.git("checkout", "-b", "local-work", f.revision);
  await f.git("branch", "-f", "main", f.revision);
  await f.git("checkout", "main");
  await writeFile(join(f.root, "source.txt"), "local commit");
  const local = await f.commit();
  f.supervisor.start({ ...f.request(), checkoutRevision: local, targetRevision: target });
  await f.supervisor.settled();
  assert.match(f.supervisor.status().job.error, /diverged/);
  assert.equal(await f.git("rev-parse", "HEAD"), local);
  assert.equal(await readFile(join(f.root, "source.txt"), "utf8"), "local commit");
  f.supervisor.start({ ...f.request(), checkoutRevision: local, targetRevision: "c".repeat(40) });
  await f.supervisor.settled();
  assert.match(f.supervisor.status().job.error, /Upstream changed/);
  assert.equal(await f.git("rev-parse", "HEAD"), local);
  assert.deepEqual(f.calls, []);
});

test("production build is staged and a failed boot restores the previous build", async (t) => {
  const f = await fixture(t, "production");
  const dist = join(f.root, "packages", "web", "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "index.html"), "previous build");
  f.fail("build");
  f.supervisor.start(f.request());
  await f.supervisor.settled();
  assert.equal(f.supervisor.status().job.phase, "failed");
  assert.equal(await readFile(join(dist, "index.html"), "utf8"), "previous build");
  assert.ok(!f.calls.includes("stop"));
  f.fail(undefined);
  f.failBoot();
  f.supervisor.start(f.request());
  await f.supervisor.settled();
  assert.equal(f.supervisor.status().job.phase, "failed");
  assert.equal(await readFile(join(dist, "index.html"), "utf8"), "previous build");
  f.supervisor.start(f.request());
  await f.supervisor.settled();
  assert.equal(f.supervisor.status().job.phase, "ready");
  assert.equal(await readFile(join(dist, "index.html"), "utf8"), "new build");
});

test(
  "real launcher survives its app stopping, waits for a new healthy instance, and shuts down its children",
  { timeout: 45_000, skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t, "production");
    const scripts = join(f.root, "scripts");
    const bin = join(f.root, "bin");
    await mkdir(scripts);
    await mkdir(bin);
    for (const file of ["run-app.mjs", "app-supervisor.mjs"])
      await copyFile(new URL(file, import.meta.url), join(scripts, file));
    const reservation = createServer();
    await new Promise((ready) => reservation.listen(0, "127.0.0.1", ready));
    const port = reservation.address().port;
    await new Promise((closed) => reservation.close(closed));
    const executable = join(bin, "pnpm");
    await writeFile(
      executable,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {randomUUID} = require('node:crypto');
const args = process.argv.slice(2);
if (args.includes('install')) process.exit(0);
if (args.includes('build')) {
 const dir = args[args.indexOf('--outDir') + 1];
 fs.mkdirSync(dir, {recursive:true}); fs.writeFileSync(path.join(dir,'index.html'),'built'); process.exit(0);
}
const instanceId = randomUUID();
const server = http.createServer(async (request,response) => {
 response.setHeader('content-type','application/json');
 if(request.url === '/api/sessions/healthcheck') return response.end(JSON.stringify({ok:true,instanceId}));
 const action = request.url === '/trigger' ? '/update' : '/status';
 const result = await fetch(process.env.BETTER_REVIEW_SUPERVISOR_URL+action, {
  method: action === '/update' ? 'POST' : 'GET',
  headers:{authorization:'Bearer '+process.env.BETTER_REVIEW_SUPERVISOR_TOKEN},
  ...(action === '/update' ? {body:JSON.stringify({requestId:randomUUID(),instanceId,checkoutRevision:${JSON.stringify(f.revision)},targetRevision:${JSON.stringify(f.revision)}})} : {})
 });
 response.statusCode=result.status; response.end(await result.text());
});
server.listen(Number(process.env.API_PORT),'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`,
    );
    await chmod(executable, 0o755);
    let output = "";
    const launcher = spawn(process.execPath, [join(scripts, "run-app.mjs"), "production"], {
      cwd: f.root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        API_PORT: String(port),
        BETTER_REVIEW_API_TOKEN: "fixture",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    launcher.stdout.on("data", (chunk) => {
      output += chunk;
    });
    launcher.stderr.on("data", (chunk) => {
      output += chunk;
    });
    t.after(async () => {
      if (launcher.exitCode === null && launcher.signalCode === null) {
        const exited = new Promise((done) => launcher.once("exit", done));
        launcher.kill("SIGTERM");
        await exited;
      }
    });
    const base = `http://127.0.0.1:${port}`;
    async function until(read, predicate) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try {
          const value = await read();
          if (predicate(value)) return value;
        } catch {}
        if (launcher.exitCode !== null) throw new Error(`Launcher exited: ${output}`);
        await delay(100);
      }
      throw new Error(`Timed out waiting for launcher: ${output}`);
    }
    const health = () =>
      fetch(`${base}/api/sessions/healthcheck`, { signal: AbortSignal.timeout(1000) }).then(
        (response) => response.json(),
      );
    const initial = await until(health, (value) => value.ok);
    const admitted = await fetch(`${base}/trigger`).then((response) => response.json());
    assert.equal(admitted.job.phase, "preparing");
    const next = await until(
      health,
      (value) => value.ok && value.instanceId !== initial.instanceId,
    );
    assert.notEqual(next.instanceId, initial.instanceId);
    const final = await until(
      () => fetch(`${base}/status`).then((response) => response.json()),
      (value) => value.job.phase === "ready",
    );
    assert.equal(final.job.id, admitted.job.id);
    assert.equal(launcher.exitCode, null);
    const exited = new Promise((done) => launcher.once("exit", done));
    launcher.kill("SIGTERM");
    await exited;
    await assert.rejects(health(), "Supervisor shutdown must not leave its app listening");
  },
);
