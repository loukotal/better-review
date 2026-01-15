import { parsePatchFiles, SVGSpriteSheet, type FileDiffMetadata } from "@pierre/diffs";
import { For, Show, createMemo } from "solid-js";

import { FileDiffView } from "./diff/FileDiffView";
import type { DiffSettings, PRComment } from "./diff/types";

// Re-export types for convenience
export type { DiffSettings, PRComment } from "./diff/types";
export { DEFAULT_DIFF_SETTINGS } from "./diff/types";

// Helper to create a consistent file ID for scroll targeting
export function getFileElementId(fileName: string): string {
  return `file-${encodeURIComponent(fileName)}`;
}

interface Props {
  rawDiff: string;
  comments: PRComment[];
  loadingComments?: boolean;
  onAddComment: (
    filePath: string,
    line: number,
    side: "LEFT" | "RIGHT",
    body: string,
  ) => Promise<unknown>;
  onReplyToComment: (commentId: number, body: string) => Promise<unknown>;
  onEditComment: (commentId: number, body: string) => Promise<unknown>;
  onDeleteComment: (commentId: number) => Promise<unknown>;
  settings: DiffSettings;
  onFilesLoaded?: (files: FileDiffMetadata[]) => void;
  fileOrder?: string[] | null;
  highlightedLine?: { file: string; line: number } | null;
  repoOwner?: string | null;
  repoName?: string | null;
}

export function DiffViewer(props: Props) {
  // Parse files from diff
  const parsedFiles = createMemo(() => {
    const patches = parsePatchFiles(props.rawDiff);
    // Flatten all files from all patches
    const allFiles = patches.flatMap((p) => p.files);
    // Notify parent about files when they change
    props.onFilesLoaded?.(allFiles);
    return allFiles;
  });

  // Order files according to fileOrder if provided
  const files = createMemo(() => {
    const order = props.fileOrder;
    const allFiles = parsedFiles();
    if (!order || order.length === 0) return allFiles;

    // Sort files by review order (files not in order go at the end)
    return [...allFiles].sort((a, b) => {
      const aIdx = order.indexOf(a.name);
      const bIdx = order.indexOf(b.name);
      if (aIdx === -1 && bIdx === -1) return 0;
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });
  });

  const commentsForFile = (fileName: string) => {
    return props.comments.filter((c) => c.path === fileName);
  };

  return (
    <div class="pt-3">
      <div innerHTML={SVGSpriteSheet} style="display:none" />

      <Show when={props.loadingComments}>
        <div class="mb-3 px-2 py-1.5 border-l-2 border-accent bg-bg-surface">
          <div class="flex items-center gap-2 text-accent text-sm">
            <span class="inline-block animate-pulse">●</span>
            <span>Loading comments...</span>
          </div>
        </div>
      </Show>

      {/* File count header */}
      <div class="mb-3 text-sm text-text-muted">
        {files().length} file{files().length !== 1 ? "s" : ""} changed
      </div>

      <div class="flex flex-col gap-3">
        <For each={files()}>
          {(file) => {
            const highlightLine = () => {
              const hl = props.highlightedLine;
              if (hl && hl.file === file.name) {
                return hl.line;
              }
              return undefined;
            };

            return (
              <div id={getFileElementId(file.name)}>
                <FileDiffView
                  file={file}
                  comments={commentsForFile(file.name)}
                  onAddComment={(line, side, body) =>
                    props.onAddComment(file.name, line, side, body)
                  }
                  onReplyToComment={props.onReplyToComment}
                  onEditComment={props.onEditComment}
                  onDeleteComment={props.onDeleteComment}
                  settings={props.settings}
                  highlightedLine={highlightLine()}
                  repoOwner={props.repoOwner}
                  repoName={props.repoName}
                />
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
