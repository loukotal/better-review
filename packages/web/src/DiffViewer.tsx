import { For, Show } from "solid-js";
import { parsePatchFiles, SVGSpriteSheet, type FileDiffMetadata } from "@pierre/diffs";

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
  onAddComment: (filePath: string, line: number, side: "LEFT" | "RIGHT", body: string) => Promise<unknown>;
  onReplyToComment: (commentId: number, body: string) => Promise<unknown>;
  settings: DiffSettings;
  onFilesLoaded?: (files: FileDiffMetadata[]) => void;
}

export function DiffViewer(props: Props) {
  const files = () => {
    const patches = parsePatchFiles(props.rawDiff);
    // Flatten all files from all patches
    const allFiles = patches.flatMap((p) => p.files);
    // Notify parent about files when they change
    props.onFilesLoaded?.(allFiles);
    return allFiles;
  };

  const commentsForFile = (fileName: string) => {
    return props.comments.filter((c) => c.path === fileName);
  };

  return (
    <div>
      <div innerHTML={SVGSpriteSheet} style="display:none" />
      
      <Show when={props.loadingComments}>
        <div class="mb-3 px-2 py-1.5 border-l-2 border-accent bg-bg-surface">
          <div class="flex items-center gap-2 text-accent text-[11px]">
            <span class="inline-block animate-pulse">●</span>
            <span>Loading comments...</span>
          </div>
        </div>
      </Show>
      
      {/* File count header */}
      <div class="mb-3 text-[11px] text-text-muted">
        {files().length} file{files().length !== 1 ? 's' : ''} changed
      </div>
      
      <div class="flex flex-col gap-3">
        <For each={files()}>
          {(file) => (
            <div id={getFileElementId(file.name)}>
              <FileDiffView
                file={file}
                comments={commentsForFile(file.name)}
                onAddComment={(line, side, body) => props.onAddComment(file.name, line, side, body)}
                onReplyToComment={props.onReplyToComment}
                settings={props.settings}
              />
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
