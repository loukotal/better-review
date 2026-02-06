import {
  FileDiff,
  type FileDiffMetadata,
  type AnnotationSide,
  type SelectedLineRange,
} from "@pierre/diffs";
import { createSignal, Show, createEffect, on, onCleanup, createMemo } from "solid-js";

import { renderAiAnnotation } from "../components/AiAnnotationInline";
import { renderCommentThread, renderPendingCommentForm } from "../components/CommentView";
import { usePrContext } from "../context/PrContext";
import { CheckIcon } from "../icons/check-icon";
import { ChevronDownIcon } from "../icons/chevron-down-icon";
import { CircleIcon } from "../icons/circle-icon";
import { trpc } from "../lib/trpc";
import type { Annotation } from "../utils/parseReviewTokens";
import {
  type DiffSettings,
  type PRComment,
  type AnnotationMetadata,
  FONT_FAMILY_MAP,
  THEME_SELECTION_COLORS,
} from "./types";

// Large file thresholds
const LARGE_FILE_LINE_THRESHOLD = 2000;
const CONTEXT_EXPANSION_LINE_COUNT = 100;

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
  onDismissAiAnnotation?: (annotationId: string) => void;
  settings: DiffSettings;
  highlightedLine?: number;
  repoOwner?: string | null;
  repoName?: string | null;
  isRead?: boolean;
  onToggleRead?: () => void;
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
  const { prUrl } = usePrContext();

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

  const [contextEnabled, setContextEnabled] = createSignal(false);
  const [loadingContext, setLoadingContext] = createSignal(false);
  const [contextError, setContextError] = createSignal<string | null>(null);
  const [fullFiles, setFullFiles] = createSignal<{
    oldFile: { name: string; contents: string; cacheKey?: string };
    newFile: { name: string; contents: string; cacheKey?: string };
  } | null>(null);

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

    const ff = fullFiles();
    if (contextEnabled() && ff) {
      instance.setOptions({
        ...instance.options,
        expandUnchanged: false,
        expansionLineCount: CONTEXT_EXPANSION_LINE_COUNT,
      });
      instance.render({
        oldFile: ff.oldFile,
        newFile: ff.newFile,
        lineAnnotations: lineAnnotations(),
        forceRender,
      });
      return;
    }

    instance.setOptions({ ...instance.options, expandUnchanged: false });
    instance.render({
      fileDiff: props.file,
      lineAnnotations: lineAnnotations(),
      forceRender,
    });
  };

  const rerender = () => {
    if (instance && _containerRef) {
      renderCurrent(true);
    }
  };

  const loadContextIfNeeded = async () => {
    const url = prUrl();
    if (!url) {
      setContextError("No PR loaded");
      return false;
    }

    if (fullFiles()) return true;

    try {
      setLoadingContext(true);
      const res = await trpc.pr.fileContents.query({
        url,
        path: props.file.name,
        prevPath: props.file.prevName ?? undefined,
      });

      if ((res.base.found && res.base.isBinary) || (res.head.found && res.head.isBinary)) {
        setContextError("Binary file");
        return false;
      }

      const oldContents = res.base.found ? (res.base.text ?? "") : "";
      const newContents = res.head.found ? (res.head.text ?? "") : "";

      setFullFiles({
        oldFile: { name: res.base.path, contents: oldContents, cacheKey: res.base.sha },
        newFile: { name: res.head.path, contents: newContents, cacheKey: res.head.sha },
      });

      return true;
    } catch (err) {
      setContextError(err instanceof Error ? err.message : "Failed to load file contents");
      return false;
    } finally {
      setLoadingContext(false);
    }
  };

  const ensureContextAndExpand = async (hunkIndex: number, direction: "up" | "down" | "both") => {
    setContextError(null);

    if (collapsed()) {
      setCollapsed(false);
    }

    setContextEnabled(true);

    const ok = await loadContextIfNeeded();
    if (!ok) {
      setContextEnabled(false);
      return;
    }

    // Ensure the component is in "context-enabled" render mode before expanding.
    renderCurrent(true);
    instance?.expandHunk?.(hunkIndex, direction);
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
      expansionLineCount: CONTEXT_EXPANSION_LINE_COUNT,
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

    const ff = fullFiles();
    if (contextEnabled() && ff) {
      instance.setOptions({
        ...instance.options,
        expandUnchanged: false,
        expansionLineCount: CONTEXT_EXPANSION_LINE_COUNT,
      });
      instance.render({
        oldFile: ff.oldFile,
        newFile: ff.newFile,
        containerWrapper: el,
        lineAnnotations: lineAnnotations(),
      });
    } else {
      instance.setOptions({ ...instance.options, expandUnchanged: false });
      instance.render({
        fileDiff: props.file,
        containerWrapper: el,
        lineAnnotations: lineAnnotations(),
      });
    }

    // If user clicks the "unmodified lines" expand controls before we have context,
    // intercept, lazily fetch base/head file contents, then expand.
    const container = instance.getFileContainer?.() as HTMLElement | undefined;
    const shadowRoot = container?.shadowRoot;
    if (shadowRoot) {
      const onShadowClick = (evt: MouseEvent) => {
        const target = evt.target as Element | null;
        if (!target) return;

        const expandButton = target.closest?.("[data-expand-button]") as HTMLElement | null;
        const unmodifiedLabel = target.closest?.("[data-unmodified-lines]") as HTMLElement | null;

        const clickedExpand = expandButton ?? unmodifiedLabel;
        if (!clickedExpand) return;

        const sep = clickedExpand.closest?.("[data-expand-index]") as HTMLElement | null;
        const idxRaw = sep?.getAttribute("data-expand-index");
        if (!idxRaw) return;
        const hunkIndex = Number.parseInt(idxRaw, 10);
        if (!Number.isFinite(hunkIndex)) return;

        const direction =
          unmodifiedLabel !== null || expandButton?.hasAttribute("data-expand-both")
            ? "both"
            : expandButton?.hasAttribute("data-expand-up")
              ? "up"
              : "down";

        // If context is already loaded, let the component handle it normally.
        if (fullFiles()) return;

        evt.preventDefault();
        evt.stopPropagation();
        void ensureContextAndExpand(hunkIndex, direction);
      };

      shadowRoot.addEventListener("click", onShadowClick, true);
      disposeList.push(() => shadowRoot.removeEventListener("click", onShadowClick, true));
    }
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

  const handleToggleContext = async (e: MouseEvent) => {
    e.stopPropagation();
    setContextError(null);

    if (collapsed()) {
      setCollapsed(false);
    }

    if (contextEnabled()) {
      setContextEnabled(false);
      setTimeout(rerender, 0);
      return;
    }

    setContextEnabled(true);

    const ok = await loadContextIfNeeded();
    if (!ok) {
      setContextEnabled(false);
      return;
    }

    setTimeout(rerender, 0);
  };

  return (
    <div>
      {/* File Header - sticky */}
      <button
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

        {/* Enable expandable context (loads base/head file contents) */}
        <span
          onClick={handleToggleContext}
          class="text-xs px-2 py-0.5 rounded border border-border bg-bg hover:bg-bg-surface text-text-muted transition-colors"
          classList={{
            "opacity-50 pointer-events-none": !prUrl(),
            "bg-bg-surface text-text": contextEnabled(),
          }}
          title={
            contextError()
              ? `Context unavailable: ${contextError()}`
              : contextEnabled()
                ? `Context enabled. Use the expand controls in the diff to load ~${CONTEXT_EXPANSION_LINE_COUNT} unchanged lines up/down. Click to disable.`
                : `Enable expandable context (loads base/head file contents, then you can expand hunks by ~${CONTEXT_EXPANSION_LINE_COUNT} lines)`
          }
        >
          <Show when={loadingContext()} fallback={contextEnabled() ? "context" : "more"}>
            loading
          </Show>
        </span>

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
