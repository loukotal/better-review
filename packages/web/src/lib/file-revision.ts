import type { FileDiffMetadata } from "@pierre/diffs";

function hashRevision(value: string, seed: number): string {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Stable identity for exactly the patch a reviewer marked as read. */
export function getFileRevision(file: FileDiffMetadata): string {
  const contents = JSON.stringify({
    name: file.name,
    prevName: file.prevName,
    type: file.type,
    additions: file.additionLines,
    deletions: file.deletionLines,
    hunks: file.hunks.map((hunk) => [
      hunk.additionStart,
      hunk.additionCount,
      hunk.deletionStart,
      hunk.deletionCount,
    ]),
  });
  return `${hashRevision(contents, 0x811c9dc5)}${hashRevision(contents, 0x9e3779b9)}`;
}
