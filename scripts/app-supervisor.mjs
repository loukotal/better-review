import { spawn } from "node:child_process";
import { mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export function runCommand(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const { signal, timeout, ...spawnOptions } = options;
    signal?.throwIfAborted();
    const child = spawn(command, args, {
      ...spawnOptions,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let failure;
    let killTimer;
    const terminate = () => {
      if (!child.pid) return;
      const kill = (name) => {
        try {
          if (process.platform === "win32") child.kill(name);
          else process.kill(-child.pid, name);
        } catch {}
      };
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 3000);
      killTimer.unref();
    };
    const abort = () => {
      failure = signal.reason;
      terminate();
    };
    const timer = timeout
      ? setTimeout(() => {
          failure = new Error(`${command} ${args[0] ?? ""} timed out`);
          terminate();
        }, timeout)
      : undefined;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const capture = (chunk) => {
      output = (output + chunk.toString()).slice(-16_000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      if (failure) reject(failure);
      else if (code === 0) resolveRun(output.trim());
      else reject(new Error(`${command} ${args[0] ?? ""} failed (${code}).\n${output.trim()}`));
    });
  });
}

/** Runs outside the app being restarted. Inputs are revision IDs, never shell commands. */
export function createAppSupervisor({
  repoRoot,
  mode,
  env = process.env,
  stopApp,
  startApp,
  waitReady,
  signal,
  run = runCommand,
}) {
  let job;
  let flight;
  const options = {
    cwd: repoRoot,
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_SSH_COMMAND: env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes -oConnectTimeout=5",
    },
    timeout: 10 * 60_000,
    signal,
  };
  const git = (...args) => run("git", args, { ...options, timeout: 30_000 });
  const pnpm = (...args) => run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, options);
  const phase = (value) => {
    job = { ...job, phase: value };
  };
  const head = () => git("rev-parse", "HEAD");
  const ancestor = async (before, after) => {
    try {
      await git("merge-base", "--is-ancestor", before, after);
      return true;
    } catch {
      return false;
    }
  };
  const clean = async () => {
    if (await git("status", "--porcelain", "--untracked-files=normal"))
      throw new Error(
        "Local changes found. Save or commit them before updating. Nothing was discarded.",
      );
  };
  async function update(request) {
    let stopped = false;
    let stage;
    let backup;
    try {
      if ((await git("symbolic-ref", "--quiet", "--short", "HEAD")) !== "main")
        throw new Error("One-click updates require the main branch.");
      if (
        (await realpath(await git("rev-parse", "--show-toplevel"))) !== (await realpath(repoRoot))
      )
        throw new Error("The application is not running from its repository root.");
      if ((await head()) !== request.checkoutRevision)
        throw new Error("The checkout changed. Check for updates again.");
      if (!(await ancestor(request.targetRevision, request.checkoutRevision))) {
        await clean();
        phase("fetching");
        await git("fetch", "--no-tags", "origin", "main");
        const fetched = await git("rev-parse", "FETCH_HEAD");
        if (fetched !== request.targetRevision)
          throw new Error(
            "Upstream changed since this update was offered. Check for updates again.",
          );
        if (
          (await git("symbolic-ref", "--quiet", "--short", "HEAD")) !== "main" ||
          (await head()) !== request.checkoutRevision
        )
          throw new Error("The checkout changed while fetching. Update cancelled.");
        await clean();
        if (!(await ancestor(request.checkoutRevision, request.targetRevision)))
          throw new Error("The checkout has diverged. Reconcile it manually before updating.");
        await git("merge", "--ff-only", request.targetRevision);
      }
      const installedRevision = await head();
      phase("installing");
      await pnpm("install", "--frozen-lockfile");
      if (mode === "production") {
        phase("building");
        stage = join(repoRoot, "node_modules", ".cache", `better-review-update-${job.id}`);
        await mkdir(stage, { recursive: true });
        await pnpm(
          "--filter",
          "./packages/web",
          "build",
          "--outDir",
          join(stage, "dist"),
          "--emptyOutDir",
        );
      }
      if (
        (await git("symbolic-ref", "--quiet", "--short", "HEAD")) !== "main" ||
        (await head()) !== installedRevision
      )
        throw new Error("The checkout changed during installation. Restart cancelled; try again.");
      phase("restarting");
      await stopApp();
      stopped = true;
      if (stage) {
        const dist = join(repoRoot, "packages", "web", "dist");
        await mkdir(dirname(dist), { recursive: true });
        if (await stat(dist).catch(() => null)) {
          const previous = join(stage, "previous-dist");
          await rename(dist, previous);
          backup = previous;
        }
        await rename(join(stage, "dist"), dist);
      }
      await startApp();
      await waitReady(request.instanceId);
      phase("ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Update failed";
      // Keep the supervisor alive and recover an app process so failures reach the UI.
      if (stopped) {
        try {
          await stopApp();
          if (backup) {
            const dist = join(repoRoot, "packages", "web", "dist");
            if (await stat(dist).catch(() => null)) await rename(dist, join(stage, "failed-dist"));
            await rename(backup, dist);
            backup = undefined;
          }
          await startApp();
          await waitReady(request.instanceId);
        } catch {
          /* The supervisor log retains the failure if the app cannot boot. */
        }
      }
      job = { ...job, phase: "failed", error: message };
      console.error(`[update] ${message}`);
    } finally {
      // Only this job's generated build directory; never remove checkout/user files.
      if (stage && (!backup || job.phase === "ready"))
        await rm(stage, { recursive: true, force: true }).catch(() => {});
      else if (backup) console.error(`[update] Previous build retained at ${backup}`);
    }
  }
  return {
    status: () => (job ? { job } : {}),
    start(request) {
      signal?.throwIfAborted();
      if (
        !request ||
        !/^[a-f0-9]{40,64}$/.test(request.targetRevision) ||
        !/^[a-f0-9]{40,64}$/.test(request.checkoutRevision) ||
        !/^[a-f0-9-]{36}$/.test(request.requestId) ||
        typeof request.instanceId !== "string" ||
        !request.instanceId
      )
        throw new Error("Invalid update request");
      if (flight || job?.id === request.requestId) return { job };
      job = {
        id: request.requestId,
        phase: "preparing",
        startedAt: Date.now(),
        targetRevision: request.targetRevision,
        previousInstanceId: request.instanceId,
      };
      flight = Promise.resolve()
        .then(() => update(request))
        .finally(() => {
          flight = undefined;
        });
      return { job };
    },
    settled: () => flight ?? Promise.resolve(),
  };
}
