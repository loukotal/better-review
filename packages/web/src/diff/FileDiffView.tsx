import {
  FileDiff,
  type FileDiffMetadata,
  type AnnotationSide,
  type SelectedLineRange,
} from "@pierre/diffs";
import { createSignal, Show, createEffect, on, onCleanup, createMemo } from "solid-js";

import { renderCommentThread, renderPendingCommentForm } from "../components/CommentView";
import {
  type DiffSettings,
  type PRComment,
  type AnnotationMetadata,
  FONT_FAMILY_MAP,
} from "./types";

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
  onAddComment: (line: number, side: "LEFT" | "RIGHT", body: string) => Promise<unknown>;
  onReplyToComment: (commentId: number, body: string) => Promise<unknown>;
  onEditComment: (commentId: number, body: string) => Promise<unknown>;
  onDeleteComment: (commentId: number) => Promise<unknown>;
  settings: DiffSettings;
  highlightedLine?: number;
  repoOwner?: string | null;
  repoName?: string | null;
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path
        d="M4.5 5.5L8 9l3.5-3.5"
        stroke="currentColor"
        stroke-width="2"
        fill="none"
        stroke-linecap="square"
      />
    </svg>
  );
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
  const shouldAutoCollapse = createMemo(() => isLargeFile() || isGeneratedFile());

  const [collapsed, setCollapsed] = createSignal(shouldAutoCollapse());
  const [pendingComment, setPendingComment] = createSignal<{
    startLine: number;
    endLine: number;
    side: "LEFT" | "RIGHT";
  } | null>(null);

  // GitHub context for markdown link resolution
  const githubContext = () => {
    if (props.repoOwner && props.repoName) {
      return { owner: props.repoOwner, repo: props.repoName };
    }
    return null;
  };

  // Generate CSS for font injection into shadow DOM
  const getFontCSS = () => {
    const fontFamily = FONT_FAMILY_MAP[props.settings.fontFamily];
    return `:host { --diffs-font-family: ${fontFamily}; } .diffs-code { font-family: ${fontFamily} !important; }`;
  };

  const annotations = () => {
    const result: {
      side: AnnotationSide;
      lineNumber: number;
      metadata: AnnotationMetadata;
    }[] = [];
    const threads = groupCommentsIntoThreads(props.comments);

    // Add threads as annotations
    Array.from(threads.values()).forEach(({ root, replies }) => {
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
  };

  const rerender = () => {
    if (instance && _containerRef) {
      instance.render({
        fileDiff: props.file,
        lineAnnotations: annotations(),
        forceRender: true,
      });
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

  // Re-render when settings change
  createEffect(
    on(
      () => ({ ...props.settings }),
      () => {
        if (instance && _containerRef) {
          // Clean up and recreate with new settings
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

  const createInstance = (el: HTMLDivElement) => {
    instance = new FileDiff({
      diffStyle: props.settings.diffStyle,
      theme: props.settings.theme,
      lineDiffType: props.settings.lineDiffType,
      hunkSeparators: "line-info",
      disableFileHeader: true,
      enableLineSelection: true,
      unsafeCSS: getFontCSS(),
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
      fileDiff: props.file,
      containerWrapper: el,
      lineAnnotations: annotations(),
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

  return (
    <div>
      {/* File Header - sticky */}
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed())}
        class="w-full flex items-center gap-2 px-3 py-1.5 bg-bg-elevated hover:bg-bg-surface text-left group sticky top-0 z-10 border border-border rounded-t-sm"
        classList={{ "rounded-b-sm": collapsed() }}
      >
        {/* Collapse indicator */}
        <span
          class="text-text-faint group-hover:text-text-muted text-sm"
          classList={{ "rotate-[-90deg]": collapsed() }}
        >
          <ChevronIcon />
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
