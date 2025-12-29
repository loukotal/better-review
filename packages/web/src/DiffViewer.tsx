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
        <div class="mb-4 px-4 py-2 bg-bg-surface border border-border rounded-lg text-text-muted text-sm flex items-center gap-2">
          <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          Loading comments...
        </div>
      </Show>
      
      <div class="flex flex-col gap-4">
        <For each={files()}>
          {(file) => (
            <div id={getFileElementId(file.name)}>
              <FileDiffView
                file={file}
                comments={commentsForFile(file.name)}
                onAddComment={(line, side, body) => props.onAddComment(file.name, line, side, body)}
                settings={props.settings}
              />
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
