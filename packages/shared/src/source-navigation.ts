export function normalizeSourcePath(value: string): string | null {
  const path = value.trim().replace(/^`|`$/g, "").replace(/^\.\//, "");
  if (
    !path ||
    /[\\:?#]/.test(path) ||
    [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    return null;
  return path;
}

/** Exact repository-relative path wins; otherwise require a unique suffix, never first-match. */
export function sourcePathCandidates(
  reference: string,
  files: string[],
  basenameFallback = true,
): string[] {
  const path = normalizeSourcePath(reference);
  if (!path) return [];
  if (files.includes(path)) return [path];
  const suffix = files.filter((file) => file.endsWith(`/${path}`)).sort();
  if (suffix.length || !basenameFallback) return suffix;
  const basename = path.split("/").pop()!;
  return files.filter((file) => file === basename || file.endsWith(`/${basename}`)).sort();
}

export type ResolvedSource =
  | {
      status: "found";
      path: string;
      ref: string;
      side: "LEFT" | "RIGHT";
      content: string;
      /** Present only for opt-in line ranges. `line` remains an absolute source coordinate. */
      totalLines?: number;
      contentStartLine?: number;
      contentEndLine?: number;
      line: number;
      approximate: boolean;
      notice: string | null;
    }
  | {
      status: "ambiguous";
      candidates: string[];
      ref: string;
      side: "LEFT" | "RIGHT";
      approximate: boolean;
      notice: string;
    }
  | { status: "missing"; notice: string };
