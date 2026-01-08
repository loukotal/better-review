// =============================================================================
// Diff Parsing and Filtering Utilities
// =============================================================================

// Hunk info extracted from diff headers
export interface HunkInfo {
  newStart: number; // Starting line in new file
  newCount: number; // Number of lines in new file
  oldStart: number; // Starting line in old file
  oldCount: number;
}

// Metadata for a file's diff
export interface FileDiffMeta {
  diff: string;
  hunks: HunkInfo[];
  totalAdded: number;
  totalRemoved: number;
}

// Parse line counts from a unified diff
export function getLineChanges(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

// Parse a diff string to extract hunk info and line counts
export function parseDiffMeta(diff: string): Omit<FileDiffMeta, "diff"> {
  const hunks: HunkInfo[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const line of diff.split("\n")) {
    // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      hunks.push({
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
      });
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      totalAdded++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      totalRemoved++;
    }
  }

  return { hunks, totalAdded, totalRemoved };
}

// Filter a unified diff to only include lines within the specified line range
// Line numbers refer to the NEW file (right side of diff)
// This filters at the LINE level, not just hunk level
export function filterDiffByLineRange(diff: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) {
    return diff;
  }

  const lines = diff.split("\n");
  const result: string[] = [];
  let inHeader = true;

  // Collect lines for current hunk being processed
  let currentHunkLines: Array<{
    line: string;
    newLineNum: number | null; // null for deleted lines
  }> = [];
  let hunkOldStart = 0;
  let hunkNewStart = 0;

  const flushHunk = () => {
    if (currentHunkLines.length === 0) return;

    // Filter lines to only those within range
    const filteredLines = currentHunkLines.filter(({ newLineNum }) => {
      // Always include deleted lines if they're near the range (context)
      if (newLineNum === null) return true;
      const afterStart = startLine === undefined || newLineNum >= startLine;
      const beforeEnd = endLine === undefined || newLineNum <= endLine;
      return afterStart && beforeEnd;
    });

    // Also filter out deleted lines that aren't adjacent to kept lines
    // by checking if any non-deleted lines were kept
    const hasKeptLines = filteredLines.some((l) => l.newLineNum !== null);
    if (!hasKeptLines) {
      currentHunkLines = [];
      return;
    }

    // Recalculate hunk header based on filtered lines
    let newOldCount = 0;
    let newNewCount = 0;
    let newOldStart = hunkOldStart;
    let newNewStart = hunkNewStart;
    let foundFirst = false;

    // Track current line numbers as we iterate
    let currentOldLine = hunkOldStart;
    let currentNewLine = hunkNewStart;

    const finalLines: string[] = [];
    for (const { line, newLineNum } of currentHunkLines) {
      const isInRange =
        newLineNum !== null &&
        (startLine === undefined || newLineNum >= startLine) &&
        (endLine === undefined || newLineNum <= endLine);

      // For deleted lines, check if adjacent new lines are in range
      const isDeletedNearRange =
        newLineNum === null &&
        (startLine === undefined || currentNewLine >= startLine - 1) &&
        (endLine === undefined || currentNewLine <= endLine + 1);

      if (isInRange || isDeletedNearRange) {
        if (!foundFirst) {
          newOldStart = currentOldLine;
          newNewStart = currentNewLine;
          foundFirst = true;
        }
        finalLines.push(line);
        if (line.startsWith("+")) {
          newNewCount++;
        } else if (line.startsWith("-")) {
          newOldCount++;
        } else {
          // Context line
          newOldCount++;
          newNewCount++;
        }
      }

      // Update current line trackers
      if (line.startsWith("+")) {
        currentNewLine++;
      } else if (line.startsWith("-")) {
        currentOldLine++;
      } else {
        currentOldLine++;
        currentNewLine++;
      }
    }

    if (finalLines.length > 0) {
      // Generate new hunk header
      const oldPart = newOldCount === 1 ? `${newOldStart}` : `${newOldStart},${newOldCount}`;
      const newPart = newNewCount === 1 ? `${newNewStart}` : `${newNewStart},${newNewCount}`;
      result.push(`@@ -${oldPart} +${newPart} @@`);
      result.push(...finalLines);
    }

    currentHunkLines = [];
  };

  for (const line of lines) {
    // Keep diff header lines (diff --git, index, ---, +++)
    if (inHeader) {
      if (line.startsWith("@@")) {
        inHeader = false;
      } else {
        result.push(line);
        continue;
      }
    }

    // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      // Flush previous hunk
      flushHunk();

      // Start new hunk tracking
      hunkOldStart = parseInt(hunkMatch[1], 10);
      hunkNewStart = parseInt(hunkMatch[3], 10);
      currentHunkLines = [];
    } else {
      // Track each line with its new file line number
      if (line.startsWith("-")) {
        // Deleted line - no new line number
        currentHunkLines.push({ line, newLineNum: null });
      } else if (line.startsWith("+")) {
        // Added line
        const newLineNum =
          currentHunkLines.filter((e) => !e.line.startsWith("-")).length + hunkNewStart;
        currentHunkLines.push({ line, newLineNum });
      } else {
        // Context line
        const newLineNum =
          currentHunkLines.filter((e) => !e.line.startsWith("-")).length + hunkNewStart;
        currentHunkLines.push({ line, newLineNum });
      }
    }
  }

  // Don't forget the last hunk
  flushHunk();

  return result.join("\n");
}

// Parse a full unified diff (from `gh pr diff`) into per-file diffs with metadata
export function parseFullDiff(fullDiff: string): Map<string, FileDiffMeta> {
  const fileDiffs = new Map<string, FileDiffMeta>();
  const lines = fullDiff.split("\n");
  let currentFile: string | null = null;
  let currentDiff: string[] = [];

  const saveCurrentFile = () => {
    if (currentFile && currentDiff.length > 0) {
      const diff = currentDiff.join("\n");
      const meta = parseDiffMeta(diff);
      fileDiffs.set(currentFile, { diff, ...meta });
    }
  };

  for (const line of lines) {
    // Check for diff header: "diff --git a/path/to/file b/path/to/file"
    if (line.startsWith("diff --git ")) {
      // Save previous file's diff
      saveCurrentFile();

      // Extract new file path
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (match) {
        currentFile = match[2]; // Use the "b" path (new file name)
        currentDiff = [line];
      }
    } else if (currentFile) {
      currentDiff.push(line);
    }
  }

  // Don't forget the last file
  saveCurrentFile();

  return fileDiffs;
}
