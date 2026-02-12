import {
  FileDiff,
  type FileDiffMetadata,
  type AnnotationSide,
  type SelectedLineRange,
  type HunkData,
  type ExpansionDirections,
} from "@pierre/diffs";
import { createSignal, Show, createEffect, on, onCleanup, createMemo } from "solid-js";

import { renderAiAnnotation } from "../components/AiAnnotationInline";
import { renderCommentThread, renderPendingCommentForm } from "../components/CommentView";
import { CheckIcon } from "../icons/check-icon";
import { ChevronDownIcon } from "../icons/chevron-down-icon";
import { CircleIcon } from "../icons/circle-icon";
import { fetchFileContentCached } from "../lib/query";
import type { Annotation } from "../utils/parseReviewTokens";
import {
  type DiffSettings,
  type PRComment,
  type AnnotationMetadata,
  FONT_FAMILY_MAP,
  THEME_SELECTION_COLORS,
} from "./types";

/** Regex to split file content preserving newlines (matches @pierre/diffs internals) */
const SPLIT_WITH_NEWLINES = /(?<=\n)/;

// Large file thresholds
const LARGE_FILE_LINE_THRESHOLD = 2000;
// Patterns for generated/lock files that are rarely useful to review
const GENERATED_FILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /Podfile\.lock$/,
  /Gemfile\.lock$/,
  /composer\.lock$/,
  /\.min\.js$/,
  /\.min\.css$/,
];

interface FileDiffViewProps {
  file: FileDiffMetadata;
  comments: PRComment[];
  aiAnnotations?: Annotation[];
  onAddComment: (line: number, side: "LEFT" | "RIGHT", body: string) => Promise<unknown>;
  onReplyToComment: (commentId: number, body: string) => Promise<unknown>;
  onEditComment: (commentId: number, body: string) => Promise<unknown>;
  onDeleteComment: (commentId: number) => Promise<unknown>;
  onResolveThread?: (threadId: string, resolved: boolean) => Promise<unknown>;
  onDismissAiAnnotation?: (annotationId: string) => void;
  settings: DiffSettings;
  highlightedLine?: number;
  repoOwner?: string | null;
  repoName?: string | null;
  isRead?: boolean;
  onToggleRead?: () => void;
  /** PR URL needed for fetching full file contents (for expanding unchanged lines) */
  prUrl?: string | null;
}

// Group comments into threads by their root comment
function groupCommentsIntoThreads(comments: PRComment[]) {
  const threads = new Map<number, { root: PRComment; replies: PRComment[] }>();

  // First pass: identify root comments (no in_reply_to_id)
  for (const comment of comments) {
    if (!comment.in_reply_to_id) {
      threads.set(comment.id, { root: comment, replies: [] });
    }
  }

  // Second pass: group replies under their root
  for (const comment of comments) {
    if (comment.in_reply_to_id) {
      const thread = threads.get(comment.in_reply_to_id);
      if (thread) {
        thread.replies.push(comment);
      }
    }
  }

  // Sort replies by created_at
  Array.from(threads.values()).forEach((thread) => {
    thread.replies.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  });

  return threads;
}

export function FileDiffView(props: FileDiffViewProps) {
  let _containerRef: HTMLDivElement | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let instance: any;

  // Detect large or generated files
  const totalLines = createMemo(
    () =>
      props.file.hunks?.reduce(
        (acc, h) => acc + (h.additionLines ?? 0) + (h.deletionLines ?? 0),
        0,
      ) ?? 0,
  );
  const isLargeFile = createMemo(() => totalLines() > LARGE_FILE_LINE_THRESHOLD);
  const isGeneratedFile = createMemo(() =>
    GENERATED_FILE_PATTERNS.some((p) => p.test(props.file.name)),
  );
  const shouldAutoCollapse = createMemo(() => isLargeFile() || isGeneratedFile() || props.isRead);

  const [collapsed, setCollapsed] = createSignal(shouldAutoCollapse());
  const [pendingComment, setPendingComment] = createSignal<{
    startLine: number;
    endLine: number;
    side: "LEFT" | "RIGHT";
  } | null>(null);

  // Collapse file when marked as read, expand when marked as unread
  createEffect(
    on(
      () => props.isRead,
      (isRead, prevIsRead) => {
        if (isRead && !prevIsRead) {
          // Collapse when transitioning from unread to read
          setCollapsed(true);
        } else if (!isRead && prevIsRead) {
          // Expand when transitioning from read to unread
          setCollapsed(false);
        }
      },
    ),
  );

  // GitHub context for markdown link resolution
  const githubContext = () => {
    if (props.repoOwner && props.repoName) {
      return { owner: props.repoOwner, repo: props.repoName };
    }
    return null;
  };

  // Generate CSS for font and selection color injection into shadow DOM
  const getCustomCSS = () => {
    const fontFamily = FONT_FAMILY_MAP[props.settings.fontFamily];
    const selectionColor = THEME_SELECTION_COLORS[props.settings.theme];
    return `
      :host { --diffs-font-family: ${fontFamily}; }
      .diffs-code { font-family: ${fontFamily} !important; }
      *::selection { background-color: ${selectionColor} !important; }
    `;
  };

  const threads = createMemo(() => groupCommentsIntoThreads(props.comments));

  const lineAnnotations = createMemo(() => {
    const result: { side: AnnotationSide; lineNumber: number; metadata: AnnotationMetadata }[] = [];
    const threadMap = threads();

    // Add threads as annotations
    Array.from(threadMap.values()).forEach(({ root, replies }) => {
      // Use line if available, otherwise fall back to original_line for outdated comments
      const lineNumber = root.line ?? root.original_line;
      // Skip comments without any line information
      if (lineNumber === null) return;

      result.push({
        side: (root.side === "LEFT" ? "deletions" : "additions") as AnnotationSide,
        lineNumber,
        metadata: { type: "thread", rootComment: root, replies },
      });
    });

    // Add AI annotations
    if (props.aiAnnotations) {
      for (const annotation of props.aiAnnotations) {
        result.push({
          // AI annotations are always on the additions side (new code)
          side: "additions" as AnnotationSide,
          lineNumber: annotation.line,
          metadata: { type: "ai-annotation", annotation },
        });
      }
    }

    // Add pending new comment form
    const pending = pendingComment();
    if (pending) {
      result.push({
        side: (pending.side === "LEFT" ? "deletions" : "additions") as AnnotationSide,
        lineNumber: pending.endLine, // Attach annotation to the last line of selection
        metadata: {
          type: "pending",
          startLine: pending.startLine,
          endLine: pending.endLine,
          side: pending.side,
        },
      });
    }

    return result;
  });

  const renderCurrent = (forceRender: boolean) => {
    if (!instance) return;

    instance.render({
      fileDiff: currentFile(),
      lineAnnotations: lineAnnotations(),
      forceRender,
    });
  };

  const rerender = () => {
    if (instance && _containerRef) {
      renderCurrent(true);
    }
  };

  // Re-render when comments change (length or content)
  createEffect(
    on(
      () => props.comments.map((c) => `${c.id}:${c.body}`).join("|"),
      () => {
        setTimeout(rerender, 0);
      },
      { defer: true },
    ),
  );

  // Re-render when AI annotations change
  createEffect(
    on(
      () => props.aiAnnotations?.map((a) => a.id).join("|") ?? "",
      () => {
        setTimeout(rerender, 0);
      },
      { defer: true },
    ),
  );

  // Re-render when settings change
  createEffect(
    on(
      () => ({ ...props.settings }),
      () => {
        if (instance && _containerRef) {
          // Clean up and recreate with new settings
          // Note: fileContentLoaded is preserved since oldLines/newLines are on the file object
          instance.cleanUp();
          _containerRef.innerHTML = "";
          createInstance(_containerRef);
        }
      },
      { defer: true },
    ),
  );

  // Highlight line when highlightedLine prop changes
  createEffect(
    on(
      () => props.highlightedLine,
      (line) => {
        if (!instance || !line) return;

        // Try to highlight on additions side first (most common for annotations)
        instance.setSelectedLines({
          start: line,
          end: line,
          side: "additions" as const,
        });

        // Try to scroll the line into view within the shadow DOM
        setTimeout(() => {
          const container = instance.getFileContainer?.() as HTMLElement | undefined;
          const shadowRoot = container?.shadowRoot;
          if (shadowRoot) {
            // Try multiple selectors to find the line element
            // The diff component may use different attributes depending on view mode
            const selectors = [
              `[data-line="${line}"]`,
              `[data-alt-line="${line}"]`,
              `[data-new-line="${line}"]`,
              `.line-new-${line}`,
              `tr[data-line="${line}"]`,
            ];

            let lineEl: Element | null = null;
            for (const selector of selectors) {
              lineEl = shadowRoot.querySelector(selector);
              if (lineEl) break;
            }

            if (lineEl) {
              lineEl.scrollIntoView({ behavior: "smooth", block: "center" });
            } else {
              // Fallback: try to highlight on deletions side if additions didn't work
              instance.setSelectedLines({
                start: line,
                end: line,
                side: "deletions" as const,
              });
            }
          }
        }, 100);
      },
      { defer: true },
    ),
  );

  // Track dispose functions for rendered components
  const disposeList: (() => void)[] = [];

  // Track whether full file content has been loaded for expanding unchanged lines
  let fileContentLoaded = false;
  let fileContentLoading = false;

  // Store the enriched file diff (with oldLines/newLines populated)
  let enrichedFile: FileDiffMetadata | null = null;

  /**
   * Fetch full file contents and populate oldLines/newLines on a cloned FileDiffMetadata.
   * A new object reference is needed to invalidate the @pierre/diffs render cache,
   * which skips re-highlighting when it sees the same diff reference.
   */
  const ensureFileContent = async (): Promise<boolean> => {
    if (fileContentLoaded) return true;
    if (fileContentLoading) return false;
    if (!props.prUrl) return false;

    fileContentLoading = true;
    try {
      const { oldContent, newContent } = await fetchFileContentCached(
        props.prUrl,
        props.file.name,
        props.file.prevName ?? undefined,
      );

      // Clone the FileDiffMetadata so the renderer sees a new reference and
      // invalidates its render cache (which was built without oldLines/newLines).
      enrichedFile = {
        ...props.file,
        oldLines: oldContent ? oldContent.split(SPLIT_WITH_NEWLINES) : [],
        newLines: newContent ? newContent.split(SPLIT_WITH_NEWLINES) : [],
      };
      fileContentLoaded = true;
      return true;
    } catch (e) {
      console.error(`Failed to fetch file content for ${props.file.name}:`, e);
      return false;
    } finally {
      fileContentLoading = false;
    }
  };

  /** Get the current file diff — enriched with full content if loaded, otherwise the original. */
  const currentFile = () => enrichedFile ?? props.file;

  /**
   * Handle expand click from a custom hunk separator.
   * Lazily loads file content on first expand, then delegates to the FileDiff instance.
   */
  const handleExpandClick = async (hunkIndex: number, direction: ExpansionDirections) => {
    const loaded = await ensureFileContent();
    if (!loaded || !instance) return;

    // Step 1: Re-render with the enriched file diff (which has oldLines/newLines).
    // The enriched file is a new object reference, so the renderer's internal cache
    // is invalidated, forcing it to re-highlight in "full file" mode. This also
    // updates instance.fileDiff to the enriched reference.
    instance.render({
      fileDiff: currentFile(),
      lineAnnotations: lineAnnotations(),
      forceRender: true,
    });

    // Step 2: Expand the requested hunk. This updates the expandedHunks map in the
    // renderer, then calls rerender() which uses the now-stored enriched fileDiff.
    instance.expandHunk(hunkIndex, direction);
  };

  /**
   * Custom hunk separator renderer.
   * Always shows expand buttons (even before file content is loaded).
   * On click, lazily loads file content then expands.
   */
  const renderHunkSeparator = (
    hunk: HunkData,
    fileDiffInstance: FileDiff<AnnotationMetadata>,
  ): HTMLElement => {
    const container = document.createElement("div");
    container.className =
      "flex items-center justify-center gap-2 py-1 px-3 text-xs text-text-faint bg-bg-surface border-y border-border cursor-pointer hover:bg-bg-elevated hover:text-text-muted transition-colors select-none";

    // Only show expand controls if there are collapsed lines
    if (hunk.lines > 0) {
      // If the collapsed region is large enough for separate up/down controls
      const isChunked = hunk.expandable?.chunked ?? hunk.lines > 100;
      const canUp = hunk.expandable?.up ?? true;
      const canDown = hunk.expandable?.down ?? true;

      if (isChunked && canUp && canDown) {
        // Separate up/down buttons for large regions
        const upBtn = document.createElement("button");
        upBtn.className = "hover:text-accent transition-colors px-1";
        upBtn.textContent = "↑";
        upBtn.title = "Expand up";
        upBtn.onclick = (e) => {
          e.stopPropagation();
          handleExpandClick(hunk.hunkIndex, "up");
        };

        const label = document.createElement("span");
        label.textContent = `${hunk.lines} unchanged lines`;

        const downBtn = document.createElement("button");
        downBtn.className = "hover:text-accent transition-colors px-1";
        downBtn.textContent = "↓";
        downBtn.title = "Expand down";
        downBtn.onclick = (e) => {
          e.stopPropagation();
          handleExpandClick(hunk.hunkIndex, "down");
        };

        container.appendChild(upBtn);
        container.appendChild(label);
        container.appendChild(downBtn);
      } else {
        // Single expand-all button
        const label = document.createElement("span");
        label.textContent = `${hunk.lines} unchanged lines`;
        container.appendChild(label);
      }

      // Click on the whole separator expands in both directions
      container.onclick = () => {
        handleExpandClick(hunk.hunkIndex, "both");
      };
    }

    return container;
  };

  const createInstance = (el: HTMLDivElement) => {
    instance = new FileDiff({
      diffStyle: props.settings.diffStyle,
      theme: props.settings.theme,
      lineDiffType: props.settings.lineDiffType,
      hunkSeparators: renderHunkSeparator,
      disableFileHeader: true,
      enableLineSelection: true,
      unsafeCSS: getCustomCSS(),
      onLineSelectionEnd: (range: SelectedLineRange | null) => {
        if (range && range.start && range.end) {
          // Clear any existing text selection so it doesn't block future interactions
          window.getSelection()?.removeAllRanges();

          const side = range.side === "deletions" ? "LEFT" : "RIGHT";
          const startLine = Math.min(range.start, range.end);
          const endLine = Math.max(range.start, range.end);
          setPendingComment({ startLine, endLine, side });
          // Re-render to show the pending comment form
          setTimeout(rerender, 0);
        }
      },
      renderAnnotation: (annotation: { metadata: AnnotationMetadata }) => {
        const { metadata } = annotation;
        const div = document.createElement("div");

        if (metadata.type === "thread") {
          const { rootComment, replies } = metadata;
          div.className = "p-2.5 my-1 mx-2 bg-bg-elevated border border-border";

          // Render the CommentThread component into the div
          const dispose = renderCommentThread(div, {
            rootComment,
            replies,
            githubContext: githubContext(),
            onEdit: async (commentId, body) => {
              await props.onEditComment(commentId, body);
            },
            onDelete: async (commentId) => {
              await props.onDeleteComment(commentId);
            },
            onReply: async (body) => {
              await props.onReplyToComment(rootComment.id, body);
            },
            isResolved: rootComment.isResolved,
            onResolve: rootComment.threadId
              ? async (resolved) => {
                  await props.onResolveThread?.(rootComment.threadId!, resolved);
                }
              : undefined,
          });
          disposeList.push(dispose);
        } else if (metadata.type === "ai-annotation") {
          div.className = "my-1 mx-2";

          // Render the AI annotation component into the div
          const dispose = renderAiAnnotation(div, {
            annotation: metadata.annotation,
            onDismiss: props.onDismissAiAnnotation,
          });
          disposeList.push(dispose);
        } else if (metadata.type === "pending") {
          div.className = "p-2.5 my-1 mx-2 bg-bg-surface border border-accent";

          // Render the PendingCommentForm component into the div
          const dispose = renderPendingCommentForm(div, {
            startLine: metadata.startLine,
            endLine: metadata.endLine,
            onSubmit: async (body) => {
              await props.onAddComment(metadata.endLine, metadata.side, body);
              setPendingComment(null);
              window.getSelection()?.removeAllRanges();
            },
            onCancel: () => {
              setPendingComment(null);
              setTimeout(rerender, 0);
            },
          });
          disposeList.push(dispose);
        }

        return div;
      },
    });

    instance.render({
      fileDiff: currentFile(),
      containerWrapper: el,
      lineAnnotations: lineAnnotations(),
    });
  };

  const renderDiff = (el: HTMLDivElement) => {
    _containerRef = el;
    createInstance(el);
  };

  onCleanup(() => instance?.cleanUp());

  const fileType = () => {
    switch (props.file.type) {
      case "new":
        return { label: "+", class: "text-success" };
      case "deleted":
        return { label: "−", class: "text-error" };
      case "rename-pure":
      case "rename-changed":
        return { label: "→", class: "text-accent" };
      default:
        return { label: "~", class: "text-accent" };
    }
  };

  const handleToggleRead = (e: MouseEvent) => {
    e.stopPropagation();
    props.onToggleRead?.();
  };

  let headerRef: HTMLButtonElement | undefined;

  // Scroll collapsed file header into view when it would be off-screen
  createEffect(
    on(
      () => collapsed(),
      (isCollapsed, wasCollapsed) => {
        if (isCollapsed && !wasCollapsed && headerRef) {
          // After collapsing, ensure the header is visible
          requestAnimationFrame(() => {
            if (!headerRef) return;
            const rect = headerRef.getBoundingClientRect();
            if (rect.top < 0 || rect.bottom > window.innerHeight) {
              headerRef.scrollIntoView({ behavior: "instant", block: "nearest" });
            }
          });
        }
      },
    ),
  );

  return (
    <div>
      {/* File Header - sticky */}
      <button
        ref={headerRef}
        type="button"
        onClick={() => setCollapsed(!collapsed())}
        class="w-full flex items-center gap-2 px-3 py-1.5 bg-bg-elevated hover:bg-bg-surface text-left group sticky top-0 z-10 border border-border rounded-t-sm"
        classList={{ "rounded-b-sm": collapsed(), "opacity-60": props.isRead }}
      >
        {/* Collapse indicator */}
        <span
          class="text-text-faint group-hover:text-text-muted text-sm"
          classList={{ "-rotate-90": collapsed() }}
        >
          <ChevronDownIcon size={12} />
        </span>

        {/* Status indicator */}
        <span class={`text-sm w-3 ${fileType().class}`}>{fileType().label}</span>

        {/* File path - preserve exact casing */}
        <span class="text-sm text-text-muted group-hover:text-text flex-1 truncate">
          {props.file.name}
          {props.file.prevName && <span class="text-text-faint ml-2">← {props.file.prevName}</span>}
        </span>

        {/* Large/generated file indicator */}
        <Show when={shouldAutoCollapse()}>
          <span class="text-sm text-text-faint">
            {isGeneratedFile() ? "generated" : `${totalLines()} lines`}
          </span>
        </Show>

        {/* Comment count */}
        <Show when={props.comments.length > 0}>
          <span class="text-sm text-accent">{props.comments.length}</span>
        </Show>

        {/* Mark as read button */}
        <Show when={props.onToggleRead}>
          <span
            onClick={handleToggleRead}
            class="w-6 h-6 flex items-center justify-center rounded hover:bg-bg transition-colors"
            classList={{
              "text-success": props.isRead,
              "text-text-faint hover:text-text-muted": !props.isRead,
            }}
            title={props.isRead ? "Mark as unread" : "Mark as read"}
          >
            <Show when={props.isRead} fallback={<CircleIcon />}>
              <CheckIcon />
            </Show>
          </span>
        </Show>
      </button>

      {/* Diff content */}
      <Show when={!collapsed()}>
        <div
          class="border border-t-0 border-border rounded-b-sm overflow-hidden"
          ref={renderDiff}
        />
      </Show>
    </div>
  );
}
