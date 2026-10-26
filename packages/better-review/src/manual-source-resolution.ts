import path from "node:path";

import type { ReviewSession, ReviewSessionDiffVariant } from "@better-review/shared";

export interface ManualSourceInput {
  session: Pick<ReviewSession, "repoRoot" | "cwd" | "payload">;
  prUrl: string | null;
  sessionScope: { mode: string; commitSha: string | null };
  filePath: string;
  prevPath?: string;
  variantId?: string;
}
export interface ManualSourceDependencies {
  git(args: string[]): Promise<{ stdout: string; exitCode: number }>;
  readFile(absolutePath: string): Promise<string>;
  prRefs(url: string): Promise<readonly [string, string]>;
  prInfo(url: string): Promise<{ owner: string; repo: string }>;
  remoteContent(input: {
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }): Promise<string | null>;
}
type ContentSource = NonNullable<ReviewSessionDiffVariant["contentSource"]>;
type LocalRead = { kind: "git"; ref: string } | { kind: "index" | "worktree" | "missing" };
export interface ManualSourceResult {
  oldContent: string | null;
  newContent: string | null;
  source:
    | "local-working-tree"
    | "local-unstaged"
    | "local-staged"
    | "local-git"
    | "local"
    | "github";
}
interface LocalPair {
  old: LocalRead;
  next: LocalRead;
  source: ManualSourceResult["source"];
}

function parseCommitRangeVariantId(variantId: string | undefined) {
  if (!variantId?.startsWith("commit-range:")) return null;
  const [, baseSha, headSha] = variantId.split(":");
  if (!baseSha || !headSha) return null;
  if (!/^[0-9a-fA-F]{7,40}$/.test(baseSha) || !/^[0-9a-fA-F]{7,40}$/.test(headSha)) return null;
  return { baseSha, headSha };
}
function contentSource({ session, variantId }: ManualSourceInput): ContentSource | undefined {
  const selected =
    session.payload.kind === "diff"
      ? session.payload.variants?.find((variant) => variant.id === variantId)
      : undefined;
  const range = parseCommitRangeVariantId(variantId);
  return selected?.contentSource ?? (range ? { kind: "git-refs", ...range } : undefined);
}
function variantPair(source: ContentSource): LocalPair | undefined {
  switch (source.kind) {
    case "working-tree":
      return {
        old: { kind: "git", ref: source.baseSha },
        next: { kind: "worktree" },
        source: "local-working-tree",
      };
    case "unstaged":
      return {
        old: { kind: "index" },
        next: { kind: "worktree" },
        source: "local-unstaged",
      };
    case "staged":
      return {
        old: source.headSha ? { kind: "git", ref: source.headSha } : { kind: "missing" },
        next: { kind: "index" },
        source: "local-staged",
      };
    case "commit":
    case "git-refs":
      return {
        old: { kind: "git", ref: source.baseSha },
        next: { kind: "git", ref: source.headSha },
        source: "local-git",
      };
  }
}
function isSafeRepoRelativePath(filePath: string): boolean {
  if (!filePath || filePath.includes("\0") || path.isAbsolute(filePath)) return false;
  const normalized = path.posix.normalize(filePath.replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return false;
  return true;
}
function resolveRepoFilePath(repoRoot: string, filePath: string): string | null {
  if (!isSafeRepoRelativePath(filePath)) return null;
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, filePath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}
async function readLocal(
  root: string,
  filePath: string,
  source: LocalRead,
  deps: ManualSourceDependencies,
): Promise<string | null> {
  if (source.kind === "missing") return null;
  if (source.kind === "worktree") {
    const resolved = resolveRepoFilePath(root, filePath);
    if (!resolved) return null;
    try {
      return await deps.readFile(resolved);
    } catch (error) {
      if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT")
        return null;
      throw error;
    }
  }
  if (!isSafeRepoRelativePath(filePath)) return null;
  const target = source.kind === "git" ? `${source.ref}:${filePath}` : `:${filePath}`;
  const { stdout, exitCode } = await deps.git(["-C", root, "show", target]);
  return exitCode === 0 ? stdout : null;
}
async function localPair(
  root: string,
  oldPath: string,
  newPath: string,
  pair: LocalPair,
  deps: ManualSourceDependencies,
): Promise<ManualSourceResult | undefined> {
  const [oldContent, newContent] = await Promise.all([
    readLocal(root, oldPath, pair.old, deps),
    readLocal(root, newPath, pair.next, deps),
  ]);
  // A partial local pair is authoritative as a pair. Never fill it from another source.
  if (oldContent !== null || newContent !== null)
    return { oldContent, newContent, source: pair.source };
}

/** Manual comparisons may use mutable worktree/index sources. Immutable PR navigation is separate. */
export async function resolveManualSource(
  input: ManualSourceInput,
  deps: ManualSourceDependencies,
): Promise<ManualSourceResult | undefined> {
  const { session, prUrl, sessionScope, filePath } = input;
  const root = session.repoRoot ?? session.cwd;
  const oldPath = input.prevPath ?? filePath;
  const source = contentSource(input);
  const pair = source && variantPair(source);
  if (root && pair) {
    const resolved = await localPair(root, oldPath, filePath, pair, deps);
    if (resolved) return resolved;
  }
  const refs =
    source?.kind === "commit" || source?.kind === "git-refs"
      ? ([source.baseSha, source.headSha] as const)
      : sessionScope.mode === "commit" && sessionScope.commitSha
        ? ([`${sessionScope.commitSha}^`, sessionScope.commitSha] as const)
        : prUrl
          ? await deps.prRefs(prUrl)
          : undefined;
  if (!refs) return;
  const [oldRef, newRef] = refs;
  if (root && oldRef && newRef) {
    const resolved = await localPair(
      root,
      oldPath,
      filePath,
      {
        old: { kind: "git", ref: oldRef },
        next: { kind: "git", ref: newRef },
        source: "local",
      },
      deps,
    );
    if (resolved) return resolved;
  }
  if (prUrl && oldRef && newRef) {
    const { owner, repo } = await deps.prInfo(prUrl);
    const [oldContent, newContent] = await Promise.all([
      deps.remoteContent({ owner, repo, path: oldPath, ref: oldRef }).catch(() => null),
      deps.remoteContent({ owner, repo, path: filePath, ref: newRef }).catch(() => null),
    ]);
    return { oldContent, newContent, source: "github" };
  }
}
