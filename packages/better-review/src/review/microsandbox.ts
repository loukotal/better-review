import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { isRuntimeInstalled, Sandbox as MicroVm, type SandboxHandle } from "microsandbox";

import { STORE_BASE_DIR } from "../store";
import { BoundedOutput } from "./bounded-output";
import { measure, startMeasurement } from "./metrics";
import { ResourcePool } from "./resource-pool";

const OWNER_LABEL = "better-review.pi-durable";
const WORKTREE_LABEL = "better-review.worktree";
// Immutable multi-platform index for alpine/git:v2.49.1.
const DEFAULT_IMAGE =
  "alpine/git@sha256:c0280cf9572316299b08544065d3bf35db65043d5e3963982ec50647d2746e26";
const DEFAULT_CPU_COUNT = 2;
const DEFAULT_MEMORY_MIB = 1_024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_VM_MAX_DURATION_SECONDS = 6 * 60 * 60;
const DEFAULT_VM_IDLE_TIMEOUT_SECONDS = 5 * 60;

interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtime?: unknown;
}

export interface SubmissionSandbox {
  cwd: string;
  exec(
    command: string,
    options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFile(path: string): Promise<string>;
  readLines(path: string, offset: number, limit: number, signal?: AbortSignal): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  beginSubmission(): Promise<void>;
  endSubmission(): Promise<void>;
}

export interface WorktreeIdentity {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  worktreePath: string;
}

interface PoolEntry {
  vm: MicroVm;
  identity: WorktreeIdentity;
  gitRoot: string;
  conversationUids: Map<string, number>;
  nextUid: number;
  resuming?: Promise<void>;
}

let pool: ResourcePool<PoolEntry> | undefined;
function sandboxPool() {
  return (pool ??= new ResourcePool(
    Number(process.env.BETTER_REVIEW_MICROSANDBOX_POOL_SIZE ?? 4),
    Number(
      process.env.BETTER_REVIEW_MICROSANDBOX_IDLE_TIMEOUT_SECONDS ??
        DEFAULT_VM_IDLE_TIMEOUT_SECONDS,
    ) * 1000,
    async (entry) => {
      await removeHandle(await MicroVm.get(entry.vm.name));
      measure("sandbox.evictions", 1);
    },
  ));
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function assertMicrosandboxInstalled(): void {
  if (!isRuntimeInstalled()) {
    throw new Error(
      "Microsandbox runtime is not installed. Run `pnpm setup:microsandbox` once on this machine.",
    );
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function microsandboxIdentity(identity: WorktreeIdentity): string {
  return [
    identity.owner,
    identity.repo,
    String(identity.number),
    identity.headSha,
    path.resolve(identity.worktreePath),
  ].join("\0");
}

export function microsandboxName(identity: WorktreeIdentity): string {
  return `better-review-pi-${hash(microsandboxIdentity(identity)).slice(0, 32)}`;
}

function worktreeLabel(worktreePath: string): string {
  return hash(path.resolve(worktreePath)).slice(0, 32);
}

export function microsandboxScratchRoot(conversationId: string): string {
  return `/tmp/better-review/${hash(conversationId).slice(0, 24)}`;
}

export function microsandboxSubmissionScratch(
  conversationId: string,
  submissionNonce: string,
): string {
  return `${microsandboxScratchRoot(conversationId)}/${submissionNonce}`;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function linkedGitRoot(worktreePath: string): Promise<string> {
  const gitFile = await readFile(path.join(worktreePath, ".git"), "utf8");
  const match = /^gitdir:\s*(.+)\s*$/m.exec(gitFile);
  if (!match?.[1])
    throw new Error(`Prepared worktree has no linked Git directory: ${worktreePath}`);

  const gitDir = path.resolve(worktreePath, match[1]);
  const marker = `${path.sep}worktrees${path.sep}`;
  const markerIndex = gitDir.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error(`Unexpected linked Git directory: ${gitDir}`);

  const root = await realpath(gitDir.slice(0, markerIndex));
  const expectedRoot = path.join(STORE_BASE_DIR, "git-cache", "github");
  if (!isInside(expectedRoot, root)) {
    throw new Error(`Linked Git directory is outside Better Review's cache: ${root}`);
  }
  return root;
}

async function createPoolEntry(session: WorktreeIdentity, owner = "1"): Promise<PoolEntry> {
  assertMicrosandboxInstalled();
  const identity: WorktreeIdentity = {
    owner: session.owner,
    repo: session.repo,
    number: session.number,
    headSha: session.headSha,
    worktreePath: await realpath(session.worktreePath),
  };
  const name = microsandboxName(identity) + (owner === "1" ? "" : `-${hash(owner).slice(0, 8)}`);
  const done = startMeasurement("sandbox.create");
  try {
    const gitRoot = await linkedGitRoot(identity.worktreePath);
    const image = process.env.BETTER_REVIEW_MICROSANDBOX_IMAGE ?? DEFAULT_IMAGE;
    const vm = await MicroVm.builder(name)
      .image(image)
      .registry((registry) => registry.auth({ kind: "anonymous" }))
      .cpus(Number(process.env.BETTER_REVIEW_MICROSANDBOX_CPUS ?? DEFAULT_CPU_COUNT))
      .memory(Number(process.env.BETTER_REVIEW_MICROSANDBOX_MEMORY_MIB ?? DEFAULT_MEMORY_MIB))
      .maxDuration(
        Number(
          process.env.BETTER_REVIEW_MICROSANDBOX_MAX_DURATION_SECONDS ??
            DEFAULT_VM_MAX_DURATION_SECONDS,
        ),
      )
      .idleTimeout(
        Number(
          process.env.BETTER_REVIEW_MICROSANDBOX_IDLE_TIMEOUT_SECONDS ??
            DEFAULT_VM_IDLE_TIMEOUT_SECONDS,
        ),
      )
      .security("restricted")
      .disableNetwork()
      .detached(true)
      .workdir(identity.worktreePath)
      .labels({
        [OWNER_LABEL]: owner,
        [WORKTREE_LABEL]: worktreeLabel(identity.worktreePath),
      })
      .volume(identity.worktreePath, (mount) =>
        mount.bind(identity.worktreePath).readonly().nosuid().nodev(),
      )
      .volume(gitRoot, (mount) => mount.bind(gitRoot).readonly().nosuid().nodev())
      .volume("/tmp/better-review", (mount) => mount.tmpfs().nosuid().nodev().size(256))
      .create();

    const entry = {
      vm,
      identity,
      gitRoot,
      conversationUids: new Map<string, number>(),
      nextUid: 10_000,
    };
    return entry;
  } finally {
    done();
  }
}

async function ensurePoolEntryRunning(entry: PoolEntry): Promise<void> {
  if (entry.resuming) return entry.resuming;
  const resuming = (async () => {
    const handle = await MicroVm.get(entry.vm.name);
    if (handle.status === "stopped") {
      entry.vm = await MicroVm.startDetached(entry.vm.name);
    }
  })();
  entry.resuming = resuming;
  try {
    await resuming;
  } finally {
    entry.resuming = undefined;
  }
}

function resolveGuestPath(cwd: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

function toFileStat(metadata: Awaited<ReturnType<ReturnType<MicroVm["fs"]>["stat"]>>): FileStat {
  return {
    isFile: metadata.kind === "file",
    isDirectory: metadata.kind === "directory",
    isSymbolicLink: metadata.kind === "symlink",
    size: metadata.size,
    ...(metadata.modified ? { mtime: metadata.modified } : {}),
  };
}

export function createSubmissionSandbox(
  entry: PoolEntry,
  conversationId: string,
): SubmissionSandbox {
  const { identity } = entry;
  let vm = entry.vm;
  let fs = vm.fs();
  const baseScratch = microsandboxScratchRoot(conversationId);
  const uid = entry.conversationUids.get(conversationId) ?? entry.nextUid++;
  entry.conversationUids.set(conversationId, uid);
  let scratch = microsandboxSubmissionScratch(conversationId, randomUUID());
  const activeExecutions = new Set<Awaited<ReturnType<MicroVm["execStreamWith"]>>>();
  let lifecycle = Promise.resolve();

  const assertWritable = (value: string) => {
    const resolved = resolveGuestPath(identity.worktreePath, value);
    if (!isInside(baseScratch, resolved)) {
      throw new Error(`Microsandbox writes are restricted to submission scratch: ${resolved}`);
    }
    return resolved;
  };

  const assertReadable = (value: string) => {
    const resolved = resolveGuestPath(identity.worktreePath, value);
    if (
      !isInside(identity.worktreePath, resolved) &&
      !isInside(entry.gitRoot, resolved) &&
      !isInside(baseScratch, resolved)
    ) {
      throw new Error(`Microsandbox reads are restricted to the review worktree: ${resolved}`);
    }
    return resolved;
  };

  const killExecutions = async () => {
    await Promise.allSettled([...activeExecutions].map((execution) => execution.kill()));
    activeExecutions.clear();
  };

  const resetScratch = (initialize: boolean) => {
    lifecycle = lifecycle
      .catch(() => undefined)
      .then(async () => {
        await killExecutions();
        scratch = microsandboxSubmissionScratch(conversationId, randomUUID());
        const done = startMeasurement(initialize ? "sandbox.setup" : "sandbox.cleanup");
        try {
          const output = await vm.exec("/bin/sh", [
            "-ec",
            [
              `for f in ${quote(baseScratch)}/pids/*; do [ -f "$f" ] || continue; pid=$(cat "$f"); case "$pid" in ''|*[!0-9]*) continue;; esac; kill -KILL -- "-$pid" 2>/dev/null || :; done`,
              `rm -rf -- ${quote(baseScratch)}`,
              ...(initialize
                ? [
                    `mkdir -p -- ${quote(scratch)} ${quote(`${baseScratch}/pids`)}`,
                    `git config --file ${quote(`${baseScratch}/gitconfig`)} --add safe.directory ${quote(identity.worktreePath)}`,
                    `chown -R ${uid}:${uid} ${quote(baseScratch)}`,
                    `chmod 700 ${quote(baseScratch)} ${quote(scratch)}`,
                  ]
                : []),
            ].join("\n"),
          ]);
          if (output.code !== 0) throw new Error(output.stderr());
        } finally {
          done();
        }
      });
    return lifecycle;
  };

  const driver: Omit<SubmissionSandbox, "cwd" | "beginSubmission" | "endSubmission"> = {
    async exec(command, options = {}) {
      options.signal?.throwIfAborted();
      const timeoutMs = Math.min(
        options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        DEFAULT_COMMAND_TIMEOUT_MS,
      );
      const cwd = assertReadable(options.cwd ?? identity.worktreePath);
      const pidDirectory = `${baseScratch}/pids`;
      const pidFile = `${pidDirectory}/${randomUUID()}`;
      const done = startMeasurement("sandbox.exec");
      // BusyBox setsid lacks --wait and forks when it is the process-group leader.
      // Launch it as a child of a waiting shell so it can exec and preserve exit status.
      const execution = await vm.execStreamWith("/bin/sh", (builder) =>
        builder
          .args([
            "-c",
            'setsid /bin/sh -c \'echo "$$" > "$1"; exec /bin/sh -lc "$2"\' better-review "$1" "$2" & wait "$!"',
            "better-review",
            pidFile,
            command,
          ])
          .cwd(cwd)
          .envs({
            HOME: scratch,
            TMPDIR: scratch,
            GIT_CONFIG_GLOBAL: `${baseScratch}/gitconfig`,
            PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          })
          .user(String(uid))
          .timeout(timeoutMs),
      );
      activeExecutions.add(execution);

      const terminate = async () => {
        try {
          const pid = (await fs.readToString(pidFile)).trim();
          if (/^\d+$/.test(pid)) await vm.exec("kill", ["-KILL", "--", `-${pid}`]);
        } finally {
          await execution.kill().catch(() => undefined);
        }
      };
      const abort = () => void terminate().catch(() => undefined);
      const timeout = setTimeout(abort, timeoutMs);
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
      try {
        const stdout = new BoundedOutput();
        const stderr = new BoundedOutput();
        let code: number | undefined;
        for (let event = await execution.recv(); event; event = await execution.recv()) {
          if (event.kind === "stdout") stdout.append(event.data);
          if (event.kind === "stderr") stderr.append(event.data);
          if (event.kind === "exited") code = event.code;
        }
        code ??= (await execution.wait()).code;
        measure("sandbox.output.bytes", stdout.totalBytes + stderr.totalBytes);
        return {
          stdout: stdout.text(),
          stderr: stderr.text(),
          exitCode: code,
        };
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        activeExecutions.delete(execution);
        done();
      }
    },
    async readLines(value, offset, limit, signal) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 2000
      )
        throw new Error("Invalid file line range");
      const file = assertReadable(value);
      const done = startMeasurement("sandbox.read");
      try {
        // Slice inside the guest. Neither the complete file nor unlimited lines cross the VM boundary.
        const result = await driver.exec(
          `awk -v start=${offset} -v count=${limit} 'BEGIN { budget=20000 } NR >= start { text=NR ": " $0; size=length(text)+1; if(size > budget) { print substr(text,1,budget); print "[Read output truncated; request a narrower range]"; exit } print text; budget-=size; if (++n >= count) exit }' ${quote(file)}`,
          { signal },
        );
        if (result.exitCode !== 0) throw new Error(result.stderr || "Could not read file");
        return result.stdout;
      } finally {
        done();
      }
    },
    readFile: (value) => fs.readToString(assertReadable(value)),
    readFileBuffer: (value) => fs.read(assertReadable(value)),
    writeFile: (value, content) => fs.write(assertWritable(value), content),
    async stat(value) {
      return toFileStat(await fs.stat(assertReadable(value)));
    },
    async readdir(value) {
      const listed = await fs.list(assertReadable(value));
      return listed.map((entry) => path.basename(entry.path));
    },
    async exists(value) {
      return fs.exists(assertReadable(value));
    },
    async mkdir(value, options) {
      const resolved = assertWritable(value);
      if (!options?.recursive) return fs.mkdir(resolved);
      const output = await vm.exec("mkdir", ["-p", "--", resolved]);
      if (output.code !== 0) throw new Error(output.stderr());
    },
    async rm(value, options) {
      const resolved = assertWritable(value);
      const args = [
        options?.recursive ? "-r" : "",
        options?.force ? "-f" : "",
        "--",
        resolved,
      ].filter(Boolean);
      const output = await vm.exec("rm", args);
      if (output.code !== 0) throw new Error(output.stderr());
    },
  };

  const sandbox: SubmissionSandbox = {
    ...driver,
    cwd: identity.worktreePath,
    beginSubmission: async () => {
      await ensurePoolEntryRunning(entry);
      vm = entry.vm;
      fs = vm.fs();
      await resetScratch(true);
    },
    endSubmission: () => resetScratch(false),
  };
  return sandbox;
}

/** Reuse the checkout sandbox with a separate runtime's conversation and lifecycle. */
export async function createReviewMicrosandbox(
  identity: WorktreeIdentity,
  conversationId: string,
  owner = "1",
): Promise<SubmissionSandbox> {
  const canonical = { ...identity, worktreePath: await realpath(identity.worktreePath) };
  const key = microsandboxName(canonical) + (owner === "1" ? "" : `-${hash(owner).slice(0, 8)}`);
  const done = startMeasurement("sandbox.acquire");
  let cold = false;
  const started = performance.now();
  const lease = await sandboxPool().acquire(key, () => {
    cold = true;
    return createPoolEntry(canonical, owner);
  });
  measure(
    cold ? "sandbox.cold.acquire.ms" : "sandbox.warm.acquire.ms",
    performance.now() - started,
  );
  done();
  const sandbox = createSubmissionSandbox(lease.value, conversationId);
  return {
    ...sandbox,
    async beginSubmission() {
      try {
        await sandbox.beginSubmission();
      } catch (error) {
        await lease.release();
        throw error;
      }
    },
    async endSubmission() {
      try {
        await sandbox.endSubmission();
      } finally {
        await lease.release();
      }
    },
  };
}

async function removeHandle(handle: SandboxHandle) {
  await handle.killWithTimeout(5_000).catch(() => undefined);
  await handle.remove();
}

async function removeMatchingMicrosandboxes(labels: Record<string, string>): Promise<void> {
  const handles: SandboxHandle[] = [];
  let cursor: string | undefined;
  do {
    const page = await MicroVm.listWith((list) => {
      list.labels(labels);
      return cursor ? list.cursor(cursor) : list;
    });
    handles.push(...page.sandboxes);
    cursor = page.nextCursor;
  } while (cursor);

  // Finish pagination before deleting records so cleanup cannot skip a page.
  await Promise.all(
    handles.map(async (handle) => {
      const result = pool ? await pool.evict(handle.name) : "missing";
      if (result === "missing") await removeHandle(handle);
    }),
  );
}

export async function cleanupOrphanedMicrosandboxes(owner = "1"): Promise<void> {
  assertMicrosandboxInstalled();
  if (pool) {
    await pool.close();
    pool = undefined;
  }
  await removeMatchingMicrosandboxes({ [OWNER_LABEL]: owner });
}

export async function removeMicrosandboxForWorktree(worktreePath: string): Promise<void> {
  const canonicalPath = await realpath(worktreePath).catch(() => path.resolve(worktreePath));
  const label = worktreeLabel(canonicalPath);
  await removeMatchingMicrosandboxes({ [OWNER_LABEL]: "1", [WORKTREE_LABEL]: label });
}

export async function shutdownMicrosandboxes(): Promise<void> {
  await cleanupOrphanedMicrosandboxes();
}
