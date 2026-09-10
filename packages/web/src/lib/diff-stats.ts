import type { FileDiffMetadata } from "@pierre/diffs";

export interface DiffLineStats {
  additions: number;
  deletions: number;
}

/** Count added/removed lines for a single file by summing its hunks. */
export function getFileDiffStats(file: FileDiffMetadata): DiffLineStats {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    additions += hunk.additionLines ?? 0;
    deletions += hunk.deletionLines ?? 0;
  }
  return { additions, deletions };
}

/** Count added/removed lines across a set of files. */
export function getTotalDiffStats(files: FileDiffMetadata[]): DiffLineStats {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    const stats = getFileDiffStats(file);
    additions += stats.additions;
    deletions += stats.deletions;
  }
  return { additions, deletions };
}

/** True when a diff has no added or removed lines (e.g. binary files). */
export function hasDiffChanges(stats: DiffLineStats): boolean {
  return stats.additions > 0 || stats.deletions > 0;
}
