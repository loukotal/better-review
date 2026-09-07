import type { FileDiffMetadata } from "@pierre/diffs";

export interface SourceTarget {
  sessionId: string;
  path: string;
  line?: number;
}

export function navigateAnnotation(
  target: SourceTarget,
  files: FileDiffMetadata[],
  sameRevision: boolean,
  callbacks: {
    diff: (path: string, line?: number) => void;
    source: (target: SourceTarget) => void;
  },
) {
  const file = files.find((file) => file.name === target.path);
  const line = target.line;
  // Annotation lines refer to the reviewed (right) side, not deleted source.
  const visible =
    file &&
    (line === undefined ||
      (Number.isSafeInteger(line) &&
        line > 0 &&
        file.hunks.some(
          (hunk) => line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount,
        )));
  if (sameRevision && visible) {
    callbacks.diff(target.path, target.line);
  } else {
    callbacks.source(target);
  }
}
