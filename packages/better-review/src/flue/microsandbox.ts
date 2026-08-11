import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  createBashTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  sandboxFromDriver,
  type FileStat,
  type Sandbox as FlueSandbox,
  type SandboxDriver,
  type SandboxFactory,
} from "@flue/runtime";
import { isInstalled, Sandbox as MicroVm } from "microsandbox";

import type { FlueReviewSession } from "../flue-review-sessions";
import { readFlueReviewSession } from "../flue-review-sessions";
import { STORE_BASE_DIR } from "../store";

const OWNER_LABEL = "better-review.flue-v2";
const WORKTREE_LABEL = "better-review.worktree";
// Immutable multi-platform index for alpine/git:v2.49.1.
const DEFAULT_IMAGE =
  "alpine/git@sha256:c0280cf9572316299b08544065d3bf35db65043d5e3963982ec50647d2746e26";
const DEFAULT_CPU_COUNT = 2;
const DEFAULT_MEMORY_MIB = 1_024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_VM_MAX_DURATION_SECONDS = 6 * 60 * 60;
const DEFAULT_VM_IDLE_TIMEOUT_SECONDS = 60 * 60;

interface SubmissionSandbox extends FlueSandbox {
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
}

const entries = new Map<string, PoolEntry>();
const creating = new Map<string, Promise<PoolEntry>>();

function assertMicrosandboxInstalled(): void {
  if (!isInstalled()) {
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
  return `better-review-v2-${hash(microsandboxIdentity(identity)).slice(0, 32)}`;
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

async function createPoolEntry(session: FlueReviewSession): Promise<PoolEntry> {
  assertMicrosandboxInstalled();
  const identity: WorktreeIdentity = {
    owner: session.owner,
    repo: session.repo,
    number: session.number,
    headSha: session.headSha,
    worktreePath: await realpath(session.worktreePath),
  };
  const name = microsandboxName(identity);
  const existing = entries.get(name);
  if (existing) return existing;

  const pending = creating.get(name);
  if (pending) return pending;

  const creation = (async () => {
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
        [OWNER_LABEL]: "1",
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
    entries.set(name, entry);
    return entry;
  })();

  creating.set(name, creation);
  try {
    return await creation;
  } finally {
    creating.delete(name);
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

function createSubmissionSandbox(entry: PoolEntry, conversationId: string): SubmissionSandbox {
  const { vm, identity } = entry;
  const fs = vm.fs();
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

  const killProcessGroups = async () => {
    const pidDirectory = `${baseScratch}/pids`;
    if (!(await fs.exists(pidDirectory))) return;
    const pidFiles = await fs.list(pidDirectory);
    await Promise.allSettled(
      pidFiles.map(async (entry) => {
        const pidPath = path.posix.isAbsolute(entry.path)
          ? entry.path
          : path.posix.join(pidDirectory, entry.path);
        const pid = (await fs.readToString(pidPath)).trim();
        if (!/^\d+$/.test(pid)) return;
        await vm.exec("kill", ["-KILL", "--", `-${pid}`]);
      }),
    );
  };

  const resetScratch = () => {
    lifecycle = lifecycle
      .catch(() => undefined)
      .then(async () => {
        await killExecutions();
        await killProcessGroups();
        if (await fs.exists(baseScratch)) {
          const output = await vm.exec("rm", ["-rf", "--", baseScratch]);
          if (output.code !== 0) throw new Error(output.stderr());
        }
        scratch = microsandboxSubmissionScratch(conversationId, randomUUID());
        const output = await vm.exec("mkdir", ["-p", "--", scratch]);
        if (output.code !== 0) throw new Error(output.stderr());
        const gitConfig = `${baseScratch}/gitconfig`;
        const configureGit = await vm.exec("git", [
          "config",
          "--file",
          gitConfig,
          "--add",
          "safe.directory",
          identity.worktreePath,
        ]);
        if (configureGit.code !== 0) throw new Error(configureGit.stderr());
        const ownership = await vm.exec("chown", ["-R", `${uid}:${uid}`, baseScratch]);
        if (ownership.code !== 0) throw new Error(ownership.stderr());
        const permissions = await vm.exec("chmod", ["700", baseScratch, scratch]);
        if (permissions.code !== 0) throw new Error(permissions.stderr());
      });
    return lifecycle;
  };

  const driver: SandboxDriver = {
    async exec(command, options = {}) {
      const timeoutMs = Math.min(
        options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        DEFAULT_COMMAND_TIMEOUT_MS,
      );
      const cwd = assertReadable(options.cwd ?? identity.worktreePath);
      await fs.mkdir(scratch).catch(() => undefined);
      const pidDirectory = `${baseScratch}/pids`;
      const mkdirOutput = await vm.exec("mkdir", ["-p", "--", pidDirectory]);
      if (mkdirOutput.code !== 0) throw new Error(mkdirOutput.stderr());
      const pidFile = `${pidDirectory}/${randomUUID()}`;
      const execution = await vm.execStreamWith("setsid", (builder) =>
        builder
          .args([
            "/bin/sh",
            "-c",
            'echo "$$" > "$1"; exec /bin/sh -lc "$2"',
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

      const abort = () => void execution.kill().catch(() => undefined);
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        const output = await execution.collect();
        return {
          stdout: output.stdout(),
          stderr: output.stderr(),
          exitCode: output.code,
        };
      } finally {
        options.signal?.removeEventListener("abort", abort);
        activeExecutions.delete(execution);
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

  const sandbox = sandboxFromDriver(driver, identity.worktreePath) as SubmissionSandbox;
  sandbox.beginSubmission = resetScratch;
  sandbox.endSubmission = resetScratch;
  return sandbox;
}

export const microsandboxFactory: SandboxFactory = {
  async createSandbox({ id }) {
    const session = await readFlueReviewSession(id);
    if (!session || session.runtimeVersion !== 2) {
      throw new Error(`Flue 2 review session not found: ${id}`);
    }
    return createSubmissionSandbox(await createPoolEntry(session), id);
  },
  tools: (sandbox) => [
    createReadTool(sandbox),
    createBashTool(sandbox),
    createGrepTool(sandbox),
    createGlobTool(sandbox),
  ],
};

export async function beginMicrosandboxSubmission(sandbox: FlueSandbox): Promise<void> {
  await (sandbox as SubmissionSandbox).beginSubmission();
}

export async function endMicrosandboxSubmission(sandbox: FlueSandbox): Promise<void> {
  await (sandbox as SubmissionSandbox).endSubmission();
}

async function removeHandle(handle: Awaited<ReturnType<typeof MicroVm.list>>[number]) {
  await handle.killWithTimeout(5_000).catch(() => undefined);
  await handle.remove();
}

export async function cleanupOrphanedMicrosandboxes(): Promise<void> {
  assertMicrosandboxInstalled();
  const handles = await MicroVm.listWith({ labels: { [OWNER_LABEL]: "1" } });
  await Promise.all(handles.map(removeHandle));
  entries.clear();
  creating.clear();
}

export async function removeMicrosandboxForWorktree(worktreePath: string): Promise<void> {
  const canonicalPath = await realpath(worktreePath).catch(() => path.resolve(worktreePath));
  const label = worktreeLabel(canonicalPath);
  const handles = await MicroVm.listWith({
    labels: { [OWNER_LABEL]: "1", [WORKTREE_LABEL]: label },
  });
  await Promise.all(handles.map(removeHandle));
  for (const [name, entry] of entries) {
    if (worktreeLabel(entry.identity.worktreePath) === label) entries.delete(name);
  }
}

export async function shutdownMicrosandboxes(): Promise<void> {
  await cleanupOrphanedMicrosandboxes();
}
