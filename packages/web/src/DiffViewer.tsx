import { parsePatchFiles, SVGSpriteSheet, Virtualizer, type FileDiffMetadata } from "@pierre/diffs";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import { FileDiffView } from "./diff/FileDiffView";
import type { DiffSettings, PRComment } from "./diff/types";
import { searchDiffFiles } from "./lib/diff-search";
import type { Annotation } from "./utils/parseReviewTokens";

// Re-export types for convenience
export type { DiffSettings, PRComment } from "./diff/types";
export { DEFAULT_DIFF_SETTINGS } from "./diff/types";

// Helper to create a consistent file ID for scroll targeting
export function getFileElementId(fileName: string): string {
  return `file-${encodeURIComponent(fileName)}`;
}

export interface DiffCommentDraft {
  filePath: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  startLine?: number;
  endLine?: number;
}

interface Props {
  rawDiff: string;
  comments: PRComment[];
  aiAnnotations?: Annotation[];
  loadingComments?: boolean;
  onAddComment: (draft: DiffCommentDraft) => Promise<unknown>;
  onReplyToComment: (commentId: number, body: string) => Promise<unknown>;
  onEditComment: (commentId: number, body: string) => Promise<unknown>;
  onDeleteComment: (commentId: number) => Promise<unknown>;
  onResolveThread?: (threadId: string, resolved: boolean) => Promise<unknown>;
  onDismissAiAnnotation?: (annotationId: string) => void;
  onCommentDraftChange?: (filePath: string, hasDraft: boolean) => void;
  settings: DiffSettings;
  onFilesLoaded?: (files: FileDiffMetadata[]) => void;
  fileOrder?: string[] | null;
  highlightedLine?: { file: string; line: number; side?: "LEFT" | "RIGHT" } | null;
  repoOwner?: string | null;
  repoName?: string | null;
  readFiles?: Set<string>;
  onToggleRead?: (fileName: string) => void;
  /** Session ID for fetching full file contents from local repo context when available */
  sessionId?: string | null;
  /** Current diff variant ID for local/manual session expansion */
  variantId?: string | null;
  /** PR URL fallback for fetching full file contents (expand unchanged lines) */
  prUrl?: string | null;
  /** Scroll container used by the line virtualizer. */
  scrollContainer?: HTMLElement;
  onSearchNavigate?: (fileName: string, line?: number, side?: "LEFT" | "RIGHT") => void;
}

export function DiffViewer(props: Props) {
  let viewerRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;
  const virtualizer = new Virtualizer();
  const [searchQuery, setSearchQuery] = createSignal("");
  const [selectedMatch, setSelectedMatch] = createSignal(-1);

  onMount(() => {
    virtualizer.setup(props.scrollContainer ?? document, viewerRef);
  });

  onCleanup(() => virtualizer.cleanUp());

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

  const commentsByFile = createMemo(() => {
    const map = new Map<string, PRComment[]>();
    for (const c of props.comments) {
      const list = map.get(c.path);
      if (list) list.push(c);
      else map.set(c.path, [c]);
    }
    return map;
  });

  const aiAnnotationsByFile = createMemo(() => {
    const map = new Map<string, Annotation[]>();
    const list = props.aiAnnotations ?? [];
    for (const a of list) {
      const existing = map.get(a.file);
      if (existing) existing.push(a);
      else map.set(a.file, [a]);
    }
    return map;
  });

  const searchMatches = createMemo(() => searchDiffFiles(files(), searchQuery()));

  createEffect(() => {
    searchQuery();
    setSelectedMatch(-1);
  });

  const firstVisibleSearchMatch = (matches: ReturnType<typeof searchMatches>) => {
    const scrollContainer = props.scrollContainer;
    if (!scrollContainer) return 0;

    const scrollBounds = scrollContainer.getBoundingClientRect();
    for (const file of files()) {
      const fileElement = document.getElementById(getFileElementId(file.name));
      if (!fileElement || fileElement.getBoundingClientRect().bottom <= scrollBounds.top) continue;

      const fileMatches = matches
        .map((match, index) => ({ match, index }))
        .filter(({ match }) => match.fileName === file.name);
      if (fileMatches.length === 0) continue;

      const diffContainer = fileElement.querySelector("diffs-container");
      const visibleLine = Array.from(
        diffContainer?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? [],
      ).find((line) => line.getBoundingClientRect().bottom > scrollBounds.top);
      const lineNumber = Number.parseInt(visibleLine?.dataset.line ?? "", 10);
      return (
        fileMatches.find(
          ({ match }) =>
            match.line === undefined || Number.isNaN(lineNumber) || match.line >= lineNumber,
        )?.index ?? fileMatches[0].index
      );
    }

    return 0;
  };

  const selectSearchMatch = (index: number) => {
    const matches = searchMatches();
    if (matches.length === 0) return;

    const nextIndex =
      selectedMatch() === -1
        ? firstVisibleSearchMatch(matches)
        : (index + matches.length) % matches.length;
    setSelectedMatch(nextIndex);
    const match = matches[nextIndex];
    props.onSearchNavigate?.(match.fileName, match.line, match.side);
  };

  const activeSearchResult = createMemo(() => searchMatches()[selectedMatch()]);

  const activeSearchMatch = createMemo(() => {
    const match = activeSearchResult();
    return match?.line === undefined
      ? undefined
      : { line: match.line, side: match.side!, query: searchQuery() };
  });

  onMount(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef?.focus();
        searchInputRef?.select();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  return (
    <div
      ref={(element) => {
        viewerRef = element;
      }}
      class="pt-3"
    >
      <div innerHTML={SVGSpriteSheet} style="display:none" />

      <div class="sticky top-0 z-20 -mt-3 mb-3 flex items-center gap-2 border-b border-border bg-bg-surface py-2">
        <input
          ref={(element) => {
            searchInputRef = element;
          }}
          type="search"
          value={searchQuery()}
          onInput={(event) => setSearchQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              selectSearchMatch(selectedMatch() + (event.shiftKey ? -1 : 1));
            }
          }}
          placeholder="Search diff..."
          aria-label="Search diff"
          class="w-52 px-2 py-1 bg-bg border border-border text-xs text-text placeholder:text-text-faint focus:border-accent font-mono"
        />
        <Show when={searchQuery().trim()}>
          <span class="text-xs text-text-faint">
            {searchMatches().length === 0
              ? "No matches"
              : selectedMatch() === -1
                ? `${searchMatches().length} matches`
                : `${selectedMatch() + 1} of ${searchMatches().length}`}
          </span>
          <Show when={searchMatches().length > 0}>
            <button
              type="button"
              onClick={() => selectSearchMatch(selectedMatch() - 1)}
              class="px-1.5 py-0.5 border border-border text-xs text-text-muted hover:text-text hover:bg-bg-elevated"
              aria-label="Previous search result"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => selectSearchMatch(selectedMatch() + 1)}
              class="px-1.5 py-0.5 border border-border text-xs text-text-muted hover:text-text hover:bg-bg-elevated"
              aria-label="Next search result"
            >
              Next
            </button>
          </Show>
        </Show>
      </div>

      <Show when={props.loadingComments}>
        <div class="mb-3 px-2.5 py-1.5 border border-accent/35 bg-accent/10">
          <div class="flex items-center gap-2 text-accent text-sm">
            <span class="inline-block animate-pulse">●</span>
            <span>Loading comments</span>
          </div>
        </div>
      </Show>

      {/* File count header */}
      <div class="mb-3 text-sm text-text-muted">
        {files().length} file{files().length !== 1 ? "s" : ""} changed
      </div>

      <div class="diff-viewer flex flex-col gap-3">
        <For each={files()}>
          {(file) => {
            const highlightLine = () => {
              const hl = props.highlightedLine;
              if (hl && hl.file === file.name) {
                return { line: hl.line, side: hl.side };
              }
              return undefined;
            };

            return (
              <div
                id={getFileElementId(file.name)}
                class="scroll-mt-12 transition-[outline,box-shadow]"
                classList={{
                  "outline-2 outline-offset-2 outline-yellow-400 shadow-[0_0_0_3px_rgb(250_204_21_/_20%)]":
                    activeSearchResult()?.fileName === file.name &&
                    activeSearchResult()?.line === undefined,
                }}
              >
                <FileDiffView
                  file={file}
                  comments={commentsByFile().get(file.name) ?? []}
                  aiAnnotations={aiAnnotationsByFile().get(file.name) ?? []}
                  onAddComment={(draft) =>
                    props.onAddComment({
                      ...draft,
                      filePath: file.name,
                    })
                  }
                  onReplyToComment={props.onReplyToComment}
                  onEditComment={props.onEditComment}
                  onDeleteComment={props.onDeleteComment}
                  onResolveThread={props.onResolveThread}
                  onDismissAiAnnotation={props.onDismissAiAnnotation}
                  onCommentDraftChange={(hasDraft) =>
                    props.onCommentDraftChange?.(file.name, hasDraft)
                  }
                  settings={props.settings}
                  highlightedLine={highlightLine()}
                  repoOwner={props.repoOwner}
                  repoName={props.repoName}
                  isRead={props.readFiles?.has(file.name)}
                  onToggleRead={
                    props.onToggleRead ? () => props.onToggleRead!(file.name) : undefined
                  }
                  sessionId={props.sessionId}
                  variantId={props.variantId}
                  prUrl={props.prUrl}
                  virtualizer={virtualizer}
                  scrollContainer={props.scrollContainer}
                  activeSearchMatch={
                    activeSearchMatch()?.line === undefined ? undefined : activeSearchMatch()
                  }
                />
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
