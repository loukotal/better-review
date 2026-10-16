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

/** Only reads Git objects at server-authorized immutable refs, never mutable checkout files. */
export function gitSourceRepository(worktreePath: string) {
  const git = async (args: string[]) => {
    // Source blobs in partial clones may hydrate on demand. Only the readiness
    // probe below disables lazy fetch, so missing commits join coordinated preparation.
    const result = await runCommand("git", ["-C", worktreePath, ...args], {
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
  const hasCommit = async (ref: string) => {
    if (!/^[a-f\d]{40,64}$/i.test(ref)) return false;
    const result = await runCommand(
      "git",
      ["--no-lazy-fetch", "-C", worktreePath, "cat-file", "-t", ref],
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
  return {
    hasCommit,
    comparisonRef: async (revision: Pick<PrReviewSession, "headSha" | "baseSha" | "commitSha">) => {
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
    files: async (ref: string) => {
      // Missing historical objects are a legitimate fallback. Repository/tree failures are not.
      if (!(await hasCommit(ref))) return [];
      const tree = await git(["ls-tree", "-rz", "--full-tree", ref]);
      return tree.split("\0").flatMap((entry) => {
        const match = entry.match(/^100(?:644|755) blob [a-f\d]+\t([\s\S]+)$/);
        return match && normalizeSourcePath(match[1]) ? [match[1]] : [];
      });
    },
    read: (ref: string, path: string) => git(["show", `${ref}:${path}`]),
    renames: async (from: string, to: string) => {
      if (!(await hasCommit(from)) || !(await hasCommit(to))) return [];
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
  },
  repo: SourceRepository,
): Promise<ResolvedSource> {
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
    return {
      status: "found",
      path: candidates[0],
      ref,
      side,
      content,
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
