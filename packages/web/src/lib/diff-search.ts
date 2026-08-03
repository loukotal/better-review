import type { FileDiffMetadata } from "@pierre/diffs";

export interface DiffSearchMatch {
  fileName: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
  preview: string;
}

function getLineNumber(
  file: FileDiffMetadata,
  side: "LEFT" | "RIGHT",
  lineIndex: number,
): number | null {
  for (const hunk of file.hunks) {
    const start = side === "RIGHT" ? hunk.additionLineIndex : hunk.deletionLineIndex;
    const count = side === "RIGHT" ? hunk.additionCount : hunk.deletionCount;
    if (lineIndex < start || lineIndex >= start + count) continue;

    const lineStart = side === "RIGHT" ? hunk.additionStart : hunk.deletionStart;
    return lineStart + lineIndex - start;
  }

  return null;
}

/** Search parsed patch lines so results remain available when diff rows are virtualized. */
export function searchDiffFiles(files: FileDiffMetadata[], query: string): DiffSearchMatch[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];

  const matches: DiffSearchMatch[] = [];
  const sides: Array<{ side: DiffSearchMatch["side"]; key: "additionLines" | "deletionLines" }> = [
    { side: "RIGHT", key: "additionLines" },
    { side: "LEFT", key: "deletionLines" },
  ];

  for (const file of files) {
    if (file.name.toLocaleLowerCase().includes(normalizedQuery)) {
      matches.push({ fileName: file.name, preview: file.name });
    }

    for (const { side, key } of sides) {
      for (const [lineIndex, line] of file[key].entries()) {
        if (!line.toLocaleLowerCase().includes(normalizedQuery)) continue;

        const lineNumber = getLineNumber(file, side, lineIndex);
        if (lineNumber === null) continue;
        matches.push({ fileName: file.name, line: lineNumber, side, preview: line.trim() });
      }
    }
  }

  return matches;
}
