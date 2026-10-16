import { realpath } from "node:fs/promises";

import {
  normalizeSourcePath,
  sourcePathCandidates,
  type ResolvedSource,
} from "@better-review/shared";

import { runCommand } from "./command";
import type { PrReviewSession } from "./pr-review-sessions";

interface SourceRepository {
  files(ref: string): Promise<string[]>;
  read(ref: string, path: string): Promise<string | null>;
  renames(from: string, to: string): Promise<Array<{ from: string; to: string }>>;
}

/** LRU bounded by estimated UTF-16/array overhead as well as entry count. */
export class SourceNavigationCache {
  private values = new Map<string, { value: unknown; bytes: number }>();
  private pending = new Map<string, Promise<unknown>>();
  private bytes = 0;

  constructor(
    private maxBytes = 32 * 1024 * 1024,
    private maxEntries = 256,
  ) {}

  async get<T>(key: string, load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const cached = this.values.get(key);
    if (cached) {
      this.values.delete(key);
      this.values.set(key, cached);
      return cached.value as T;
    }
    let pending = this.pending.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = load()
        .then((value) => {
          const length = typeof value === "string" ? value.length : JSON.stringify(value).length;
          const bytes =
            2 * (key.length + length) + 128 + (Array.isArray(value) ? value.length * 128 : 0);
          if (bytes <= this.maxBytes) {
            this.bytes -= this.values.get(key)?.bytes ?? 0;
            this.values.delete(key);
            this.values.set(key, { value, bytes });
            this.bytes += bytes;
            while (this.bytes > this.maxBytes || this.values.size > this.maxEntries) {
              const oldest = this.values.keys().next().value!;
              this.bytes -= this.values.get(oldest)!.bytes;
              this.values.delete(oldest);
            }
          }
          return value;
        })
        .finally(() => {
          if (this.pending.get(key) === pending) this.pending.delete(key);
        });
      // Bound the coalescing registry too; excess distinct reads simply aren't registered.
      if (this.pending.size < this.maxEntries) this.pending.set(key, pending);
    }
    if (!signal) return pending;
    // A caller owns its wait, not the shared process. Never abort another reader.
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      pending!.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }
}

const sourceCache = new SourceNavigationCache();
const immutableRef = (ref: string) => /^[a-f\d]{40,64}$/i.test(ref);
const unavailableCommit = new Error("Immutable source commit is unavailable");

/** Only reads Git objects at server-authorized immutable refs, never mutable checkout files. */
export function gitSourceRepository(
  worktreePath: string,
  options: { cache?: SourceNavigationCache; signal?: AbortSignal } = {},
) {
  const cache = options.cache ?? sourceCache;
  // Resolve aliases once and use the same identity for keys and Git operations.
  let canonicalPath: Promise<string> | undefined;
  const repositoryPath = () =>
    (canonicalPath ??= realpath(worktreePath).catch((error) => {
      canonicalPath = undefined;
      throw error;
    }));
  const cached = async <T>(parts: string[], load: () => Promise<T>) =>
    cache.get(JSON.stringify([await repositoryPath(), ...parts]), load, options.signal);
  const assertRef = (ref: string) => {
    if (!immutableRef(ref)) throw new Error("Source reads require an immutable commit SHA");
  };
  const git = async (args: string[]) => {
    // Source blobs in partial clones may hydrate on demand. Only the readiness
    // probe below disables lazy fetch, so missing commits join coordinated preparation.
    const result = await runCommand("git", ["-C", await repositoryPath(), ...args], {
      timeoutMs: 30_000,
    });
    if (result.timedOut)
      throw new Error("Source lookup timed out. Retry after the checkout finishes preparing.");
    if (result.exitCode !== 0)
      throw new Error(
        `Source repository read failed (${args[0]}): ${result.stderr.trim() || "Git failed"}. Retry after checkout preparation finishes.`,
      );
    return result.stdout;
  };
  const probeCommit = async (ref: string) => {
    if (!/^[a-f\d]{40,64}$/i.test(ref)) return false;
    const result = await runCommand(
      "git",
      ["--no-lazy-fetch", "-C", await repositoryPath(), "cat-file", "-t", ref],
      { timeoutMs: 30_000 },
    );
    if (result.timedOut)
      throw new Error(
        "Source repository readiness check timed out. Retry after checkout preparation finishes.",
      );
    if (result.exitCode === 0) return result.stdout.trim() === "commit";
    if (
      !/permission denied|corrupt|unable to|error:/i.test(result.stderr) &&
      /not a valid object name|could not get object info|bad object/i.test(result.stderr)
    )
      return false;
    throw new Error(
      `Source repository readiness check failed: ${result.stderr.trim()}. Retry after checkout preparation finishes.`,
    );
  };
  const hasCommit = async (ref: string) => {
    if (!immutableRef(ref)) return false;
    try {
      return await cached(["commit", ref], async () => {
        if (!(await probeCommit(ref))) throw unavailableCommit;
        return true;
      });
    } catch (error) {
      if (error === unavailableCommit) return false;
      throw error;
    }
  };
  return {
    hasCommit,
    comparisonRef: async (revision: Pick<PrReviewSession, "headSha" | "baseSha" | "commitSha">) => {
      for (const ref of [
        revision.headSha,
        revision.baseSha,
        ...(revision.commitSha ? [revision.commitSha] : []),
      ])
        assertRef(ref);
      return cached(
        ["comparison", revision.commitSha ?? "", revision.baseSha, revision.headSha],
        async () => {
          const ref = (
            await git(
              revision.commitSha
                ? ["rev-parse", "--verify", `${revision.commitSha}^`]
                : ["merge-base", revision.baseSha, revision.headSha],
            )
          ).trim();
          if (!/^[a-f\d]{40,64}$/i.test(ref))
            throw new Error(
              "Review comparison revision is unavailable. Retry after checkout preparation finishes.",
            );
          return ref;
        },
      );
    },
    files: async (ref: string) => {
      assertRef(ref);
      // Missing historical objects are a legitimate fallback. Repository/tree failures are not.
      if (!(await hasCommit(ref))) return [];
      const files = await cached(["tree", ref], async () => {
        const tree = await git(["ls-tree", "-rz", "--full-tree", ref]);
        return tree.split("\0").flatMap((entry) => {
          const match = entry.match(/^100(?:644|755) blob [a-f\d]+\t([\s\S]+)$/);
          return match && normalizeSourcePath(match[1]) ? [match[1]] : [];
        });
      });
      return [...files];
    },
    read: (ref: string, path: string) => {
      assertRef(ref);
      if (normalizeSourcePath(path) !== path)
        throw new Error("Unsafe repository-relative source path");
      return cached(["blob", ref, path], () => git(["show", `${ref}:${path}`]));
    },
    renames: async (from: string, to: string) => {
      assertRef(from);
      assertRef(to);
      if (!(await hasCommit(from)) || !(await hasCommit(to))) return [];
      const renames = await cached(["renames", from, to], async () => {
        const parts = (
          await git([
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-status",
            "-z",
            "--find-renames",
            from,
            to,
            "--",
          ])
        ).split("\0");
        const result: Array<{ from: string; to: string }> = [];
        for (let i = 0; i < parts.length;) {
          const status = parts[i++];
          if (/^[RC]\d+$/.test(status)) {
            const before = parts[i++],
              after = parts[i++];
            if (status.startsWith("R")) result.push({ from: before, to: after });
          } else i++;
        }
        return result;
      });
      return renames.map((rename) => ({ ...rename }));
    },
  };
}

export async function resolveSourceNavigation(
  input: {
    path: string;
    ref?: string;
    side?: "LEFT" | "RIGHT";
    line?: number;
    currentRef: string;
    allowedRefs: string[];
    previousRef?: string;
    range?: { startLine: number; endLine: number };
    signal?: AbortSignal;
  },
  repo: SourceRepository,
): Promise<ResolvedSource> {
  input.signal?.throwIfAborted();
  if (
    input.range &&
    (!Number.isSafeInteger(input.range.startLine) ||
      !Number.isSafeInteger(input.range.endLine) ||
      input.range.startLine < 1 ||
      input.range.endLine < input.range.startLine ||
      input.range.endLine - input.range.startLine >= 2000)
  )
    throw new Error("Source range must contain between 1 and 2000 lines");
  const path = normalizeSourcePath(input.path);
  if (!path) throw new Error("Unsafe repository-relative source path");
  const allowed = new Set(input.allowedRefs.filter((ref) => /^[a-f\d]{40,64}$/i.test(ref)));
  if (!allowed.has(input.currentRef))
    throw new Error("Current immutable review revision is unavailable");
  const requested = input.ref && allowed.has(input.ref) ? input.ref : undefined;
  const attempts = [
    ...new Set([
      ...(requested ? [requested] : []),
      input.currentRef,
      ...(input.previousRef && allowed.has(input.previousRef) ? [input.previousRef] : []),
    ]),
  ];
  for (const ref of attempts) {
    const files = await repo.files(ref);
    let candidates = sourcePathCandidates(path, files, false);
    let renamed = false;
    if (!candidates.length && ref === input.currentRef) {
      const previousRefs =
        requested && requested !== ref
          ? [requested]
          : [...allowed].filter((previous) => previous !== ref);
      const renames = (
        await Promise.all(previousRefs.map((previous) => repo.renames(previous, ref)))
      ).flat();
      const oldPaths = sourcePathCandidates(
        path,
        renames.map((rename) => rename.from),
      );
      candidates = [
        ...new Set(
          renames
            .filter((rename) => oldPaths.includes(rename.from) && files.includes(rename.to))
            .map((rename) => rename.to),
        ),
      ];
      renamed = candidates.length > 0;
    }
    // Record how candidates were obtained before a choice narrows their count.
    // Even multiple basename-only matches are relocated-path approximations.
    let basenameOnly = false;
    if (!candidates.length) {
      candidates = sourcePathCandidates(path, files);
      basenameOnly = candidates.length > 0;
    }
    const fallback = !input.ref || ref !== input.ref;
    const side = fallback
      ? ref === input.previousRef
        ? "LEFT"
        : "RIGHT"
      : (input.side ?? "RIGHT");
    if (candidates.length > 1)
      return {
        status: "ambiguous",
        candidates,
        ref,
        side,
        approximate: fallback || renamed || basenameOnly,
        notice: `Multiple source files match “${path}” at ${ref}. Choose the repository-relative path.${fallback ? " The original source is unavailable; this is a revision fallback and line correspondence remains approximate." : ""}${basenameOnly ? " The requested path is unavailable; these are basename-only matches and line correspondence remains approximate." : ""}`,
      };
    if (!candidates.length) continue;
    const content = await repo.read(ref, candidates[0]);
    input.signal?.throwIfAborted();
    if (content === null) continue;
    const count = Math.max(1, content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0));
    const wanted = input.line ?? 1;
    const line = Math.max(1, Math.min(wanted, count));
    const notices: string[] = [];
    if (fallback)
      notices.push(
        `Requested source revision/path ${input.ref ?? "is unknown"} is unavailable. Showing ${ref === input.previousRef ? "previous/deleted source at" : "current immutable reviewed revision"} ${ref}; line correspondence is approximate, not a comment target.`,
      );
    if (renamed) notices.push(`Renamed path: ${path} → ${candidates[0]}.`);
    else if (basenameOnly)
      notices.push(
        `Requested path ${path} is unavailable. Matched the unique repository basename at ${candidates[0]}; line correspondence is approximate.`,
      );
    if (line !== wanted)
      notices.push(
        `Requested line ${wanted} is outside this ${count}-line file. Showing nearest line ${line} (approximate).`,
      );
    const range = input.range;
    const startLine = range ? Math.min(range.startLine, count) : 1;
    const endLine = range ? Math.min(range.endLine, count) : count;
    return {
      status: "found",
      path: candidates[0],
      ref,
      side,
      content: range
        ? content
            .split("\n")
            .slice(startLine - 1, endLine)
            .join("\n") + (endLine < count || content.endsWith("\n") ? "\n" : "")
        : content,
      ...(range ? { totalLines: count, contentStartLine: startLine, contentEndLine: endLine } : {}),
      line,
      approximate: fallback || line !== wanted || renamed || basenameOnly,
      notice: notices.join(" ") || null,
    };
  }
  return {
    status: "missing",
    notice: `No source matching “${path}” was found at the requested or current reviewed revision. Use a full repository-relative path or pull the latest review revision.`,
  };
}
