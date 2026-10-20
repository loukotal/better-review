import {
  FileDiff,
  type Virtualizer,
  parseDiffFromFile,
  type FileDiffMetadata,
  type AnnotationSide,
  type SelectedLineRange,
  type HunkData,
  type ExpansionDirections,
  type DiffLineAnnotation,
  type FileDiffOptions,
} from "@pierre/diffs";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import { createSignal, Show, createEffect, on, onCleanup, createMemo } from "solid-js";

import { renderAiAnnotation } from "../components/AiAnnotationInline";
import {
  createCachedCommentDraft,
  renderCachedCommentForm,
  type CachedCommentDraft,
} from "../components/CachedCommentForm";
import { renderCommentThread } from "../components/CommentView";
import {
  renderGithubCommentCard,
  createGithubCommentUiState,
} from "../components/GithubCommentCard";
import { SelectionBubble } from "../components/SelectionBubble";
import type { DiffCommentDraft } from "../DiffViewer";
import { CheckIcon } from "../icons/check-icon";
import { ChevronDownIcon } from "../icons/chevron-down-icon";
import { CircleIcon } from "../icons/circle-icon";
import { extractLines, extractTextSelection, type SelectedSource } from "../lib/ask-ai-selection";
import type { FindingCommentRequest } from "../lib/finding-comment";
import {
  githubCommentLocation,
  githubLocationInPatch,
  githubThreadForComment,
} from "../lib/github-comment-views";
import type { BrowserGithubOperation } from "../lib/github-outbox";
import type { GithubCommentView, GithubThreadView } from "../lib/github-outbox-projection";
import { githubPrScope } from "../lib/github-writes";
import { fetchFileContentCached } from "../lib/query";
import {
  lineSelectionAnchor,
  textSelectionAnchor,
  type SelectionBubbleAnchor,
} from "../lib/selection-bubble";
import type { Annotation } from "../utils/parseReviewTokens";
import {
  FocusableFileDiff,
  FocusableVirtualizedFileDiff,
  centerFocusRow,
  focusRenderedLine,
  focusRowSelector,
} from "./focus-line";
import {
  type DiffSettings,
  type PRComment,
  type AnnotationMetadata,
  FONT_FAMILY_MAP,
  THEME_SELECTION_COLORS,
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
  githubComments?: GithubCommentView[];
  githubThreads?: GithubThreadView[];
  githubOperations?: BrowserGithubOperation[];
  findingComment?: FindingCommentRequest | null;
  commentHeadSha?: string | null;
  onAskAi?: (selection: SelectedSource, anchor: SelectionBubbleAnchor) => void;
  askEditorOpen?: boolean;
  selectionScope?: string;
  selectionClearToken?: number;
  commitScope?: boolean;
  file: FileDiffMetadata;
  comments: PRComment[];
  aiAnnotations?: Annotation[];
  onAddComment: (draft: Omit<DiffCommentDraft, "filePath">) => Promise<unknown>;
  onReplyToComment: (commentId: number, body: string, draftKey?: string) => Promise<unknown>;
  onEditComment: (
    commentId: number,
    body: string,
    draftKey?: string,
    expectedBody?: string,
  ) => Promise<unknown>;
  onDeleteComment: (commentId: number) => Promise<unknown>;
  onResolveThread?: (threadId: string, resolved: boolean) => Promise<unknown>;
  onDismissAiAnnotation?: (annotationId: string) => void;
  onCreateFindingComment?: (annotation: Annotation) => void;
  onCommentDraftChange?: (hasDraft: boolean) => void;
  settings: DiffSettings;
  highlightedLine?: { line: number; side?: "LEFT" | "RIGHT" };
  /** Change this token to focus the same highlightedLine object again. */
  focusRequestId?: string | number;
  /** Target was not rendered on the requested side within the bounded retry window. */
  onFocusFailed?: (failure: {
    fileName: string;
    line: number;
    side: "LEFT" | "RIGHT";
    reason: "not-rendered";
  }) => void;
  repoOwner?: string | null;
  repoName?: string | null;
  isRead?: boolean;
  onToggleRead?: () => void;
  /** Session ID used to fetch full file contents from local repo context when available */
  sessionId?: string | null;
  /** Current diff variant ID for local/manual session expansion */
  variantId?: string | null;
  /** PR URL fallback for fetching full file contents (for expanding unchanged lines) */
  prUrl?: string | null;
  virtualizer: Virtualizer;
  workerPool: WorkerPoolManager;
  scrollContainer?: HTMLElement;
  activeSearchMatch?: { line: number; side: "LEFT" | "RIGHT"; query: string };
  readOnly?: boolean;
}

type DiffAnnotationMetadata =
  | AnnotationMetadata
  | { type: "github-comment"; comment: GithubCommentView; thread?: GithubThreadView };

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
  let instance:
    | FocusableFileDiff<DiffAnnotationMetadata>
    | FocusableVirtualizedFileDiff<DiffAnnotationMetadata>
    | undefined;
  let nonVirtualized = false;
  let cancelFocus: (() => void) | undefined;
  const [aiCandidate, setAiCandidate] = createSignal<SelectedSource | null>(null);
  const [selectionError, setSelectionError] = createSignal<string | null>(null);
  const [bubbleAnchor, setBubbleAnchor] = createSignal<SelectionBubbleAnchor | null>(null);
  const hideCandidate = () => {
    setBubbleAnchor(null);
    setAiCandidate(null);
    setSelectionError(null);
  };
  const clearAiSelection = () => {
    hideCandidate();
    instance?.setSelectedLines(null);
    window.getSelection()?.removeAllRanges();
  };
  createEffect(() => {
    if (props.askEditorOpen) hideCandidate();
  });
  createEffect(on(() => props.selectionClearToken, clearAiSelection, { defer: true }));
  createEffect(
    on(
      () => props.selectionScope,
      () => {
        hideCandidate();
        setPendingComment(null);
      },
      { defer: true },
    ),
  );

  const captureText = () => {
    if (!props.onAskAi || props.askEditorOpen) return;
    const root = instance?.getFileContainer()?.shadowRoot;
    if (!root) return;
    try {
      const anchor = textSelectionAnchor(root);
      if (!anchor) return;
      setBubbleAnchor(anchor);
      assertSelectionRevision();
      const selection = extractTextSelection(root, currentFile());
      if (selection) {
        setAiCandidate(withSourceRevision(selection));
        setSelectionError(null);
      }
    } catch (error) {
      if (!bubbleAnchor())
        setBubbleAnchor(lineSelectionAnchor(root, () => (_containerRef ? [_containerRef] : [])));
      setAiCandidate(null);
      setSelectionError(error instanceof Error ? error.message : "Unable to read selection.");
    }
  };

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
    initialBody?: string;
    expectedHeadSha?: string;
    scope?: string;
  } | null>(null);
  const commentDrafts = new Map<string, CachedCommentDraft>();
  createEffect(
    on(
      () => props.findingComment,
      (request) => {
        if (
          !request ||
          request.filePath !== props.file.name ||
          request.scope !== props.selectionScope
        )
          return;
        setCollapsed(false);
        setPendingComment({
          startLine: request.line,
          endLine: request.line,
          side: "RIGHT",
          initialBody: request.body,
          expectedHeadSha: request.expectedHeadSha,
          scope: request.scope,
        });
        setTimeout(() => {
          if (props.findingComment?.id === request.id) rerender();
        }, 0);
      },
    ),
  );

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
      :host {
        --diffs-font-family: ${fontFamily};
        --diffs-header-font-family: "Geist", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .diffs-code { font-family: ${fontFamily} !important; }
      *::selection { background-color: ${selectionColor} !important; }
    `;
  };

  const threads = createMemo(() => groupCommentsIntoThreads(props.comments));
  const githubUiStates = new Map<string, ReturnType<typeof createGithubCommentUiState>>();
  // Pierre compares annotation metadata by reference. Keep identity per comment;
  // getters still expose current bodies, permissions and thread/sync metadata.
  const githubAnnotationMetadata = new Map<
    string,
    Extract<DiffAnnotationMetadata, { type: "github-comment" }>
  >();

  const lineAnnotations = createMemo(() => {
    const result: DiffLineAnnotation<DiffAnnotationMetadata>[] = [];
    for (const comment of props.githubComments ?? []) {
      if (comment.ref.kind !== "review-comment") continue;
      const location = githubCommentLocation(
        comment,
        props.githubOperations ?? [],
        props.githubComments,
      );
      if (
        !location ||
        location.path !== props.file.name ||
        !githubLocationInPatch(location, props.file) ||
        (location.expectedHeadSha && location.expectedHeadSha !== props.commentHeadSha) ||
        props.commitScope
      )
        continue;
      let metadata = githubAnnotationMetadata.get(comment.key);
      if (!metadata) {
        const key = comment.key;
        metadata = {
          type: "github-comment",
          get comment() {
            return props.githubComments?.find((item) => item.key === key) ?? comment;
          },
          get thread() {
            return githubThreadForComment(
              this.comment,
              props.githubThreads ?? [],
              props.githubOperations ?? [],
            );
          },
        };
        githubAnnotationMetadata.set(key, metadata);
      }
      result.push({
        side: location.side === "LEFT" ? "deletions" : "additions",
        lineNumber: location.line,
        metadata,
      });
    }
    const threadMap = threads();

    // Add threads as annotations
    if (props.githubComments === undefined)
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
          initialBody: pending.initialBody,
          expectedHeadSha: pending.expectedHeadSha,
          scope: pending.scope ?? props.selectionScope,
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
    const container = instance.getFileContainer();
    if (container && fileContentLoaded)
      container.dataset.expandedHead = expandedSourceRefs.headSha ?? "";
  };

  const rerender = () => {
    if (instance && _containerRef) {
      renderCurrent(true);
    }
  };

  // Re-render when comments change (length or content)
  const commentSignature = createMemo(() =>
    JSON.stringify(
      props.comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        path: comment.path,
        line: comment.line,
        originalLine: comment.original_line,
        side: comment.side,
        replyTo: comment.in_reply_to_id,
        threadId: comment.threadId,
        resolved: comment.isResolved,
        url: comment.html_url,
        login: comment.user.login,
        avatar: comment.user.avatar_url,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        canEdit: comment.canEdit,
      })),
    ),
  );
  createEffect(
    on(
      commentSignature,
      () => {
        setTimeout(rerender, 0);
      },
      { defer: true },
    ),
  );

  // Polls publish fresh objects even when no annotation changed. `on` alone
  // does not compare its return value; the memo suppresses no-op forced renders.
  const githubAnnotationSignature = createMemo(() =>
    JSON.stringify([
      props.githubComments?.map((comment) => [
        comment.key,
        comment.body,
        comment.deleted,
        comment.pending,
        comment.confirmed?.updatedAt,
      ]),
      props.githubThreads?.map((thread) => [thread.key, thread.resolved, thread.pending]),
    ]),
  );
  createEffect(on(githubAnnotationSignature, () => setTimeout(rerender, 0), { defer: true }));

  // Re-render when AI annotations change
  const aiAnnotationSignature = createMemo(() =>
    JSON.stringify(
      (props.aiAnnotations ?? []).map((annotation) => ({
        id: annotation.id,
        file: annotation.file,
        line: annotation.line,
        severity: annotation.severity,
        message: annotation.message,
        sessionId: annotation.origin?.sessionId,
        revision: annotation.origin?.revision,
      })),
    ),
  );
  createEffect(
    on(
      aiAnnotationSignature,
      () => {
        setTimeout(rerender, 0);
      },
      { defer: true },
    ),
  );

  // Re-render when settings change
  createEffect(
    on(
      () => ({ ...props.settings, readOnly: props.readOnly }),
      () => {
        if (instance && _containerRef) {
          // Clean up and recreate with new settings
          // Note: fileContentLoaded is preserved since oldLines/newLines are on the file object
          cancelFocus?.();
          createInstance(_containerRef);
        }
      },
      { defer: true },
    ),
  );

  const focusLine = (request: NonNullable<FileDiffViewProps["highlightedLine"]>) => {
    const target = { ...request };
    cancelFocus?.();
    instance?.setSelectedLines(null);
    setCollapsed(false);
    const side = target.side === "LEFT" ? "deletions" : "additions";
    cancelFocus = focusRenderedLine({
      findRow: () => {
        const container = instance?.getFileContainer();
        if (!container?.isConnected) return undefined;
        const indices = instance?.getLineIndex(target.line, side);
        if (!indices) return undefined;
        const row = container.shadowRoot?.querySelector<HTMLElement>(
          focusRowSelector(indices, side, target.line),
        );
        return row && row.getBoundingClientRect().height > 0 ? row : undefined;
      },
      renderAll: () => {
        // Only a targeted file opts out of virtualization. Keep its current hunks
        // and measure real rows, including annotations, instead of guessing offsets.
        nonVirtualized = true;
        if (_containerRef?.isConnected) createInstance(_containerRef);
      },
      center: (row) => {
        instance?.setSelectedLines({ start: target.line, end: target.line, side });
        if (props.scrollContainer) centerFocusRow(row, props.scrollContainer);
        else row.scrollIntoView({ behavior: "instant", block: "center" });
      },
      failed: () =>
        props.onFocusFailed?.({
          fileName: props.file.name,
          line: target.line,
          side: target.side === "LEFT" ? "LEFT" : "RIGHT",
          reason: "not-rendered",
        }),
    });
  };

  const highlightSearchMatch = () => {
    const match = props.activeSearchMatch;
    const query = match?.query.trim();
    const container = instance?.getFileContainer();
    const shadowRoot = container?.shadowRoot;
    if (!shadowRoot) return;

    for (const mark of shadowRoot.querySelectorAll("mark[data-diff-search-match]")) {
      mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
    }
    for (const line of shadowRoot.querySelectorAll<HTMLElement>("[data-diff-search-line]")) {
      line.removeAttribute("data-diff-search-line");
      line.style.removeProperty("outline");
      line.style.removeProperty("outline-offset");
      line.style.removeProperty("box-shadow");
    }
    if (!query || !match) return;

    const lowerQuery = query.toLocaleLowerCase();
    const codes = shadowRoot.querySelectorAll<HTMLElement>(
      `[data-line="${match.line}"], [data-alt-line="${match.line}"]`,
    );
    for (const code of codes) {
      if (!code.textContent?.toLocaleLowerCase().includes(lowerQuery)) continue;
      code.dataset.diffSearchLine = "";
      code.style.setProperty("outline", "2px solid #facc15");
      code.style.setProperty("outline-offset", "-2px");
      code.style.setProperty("box-shadow", "inset 0 0 0 9999px rgb(250 204 21 / 45%)");

      const textNodes: Text[] = [];
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) textNodes.push(node as Text);

      for (const textNode of textNodes) {
        const text = textNode.data;
        const lowerText = text.toLocaleLowerCase();
        let start = lowerText.indexOf(lowerQuery);
        if (start === -1) continue;

        const fragment = document.createDocumentFragment();
        let offset = 0;
        while (start !== -1) {
          fragment.append(text.slice(offset, start));
          const mark = document.createElement("mark");
          mark.dataset.diffSearchMatch = "";
          mark.textContent = text.slice(start, start + query.length);
          mark.style.cssText = "background:#facc15;color:#111;border-radius:1px;padding:0";
          fragment.append(mark);
          offset = start + query.length;
          start = lowerText.indexOf(lowerQuery, offset);
        }
        fragment.append(text.slice(offset));
        textNode.replaceWith(fragment);
      }
    }
  };

  createEffect(
    on(
      () => props.activeSearchMatch,
      () => highlightSearchMatch(),
      { defer: true },
    ),
  );

  // Highlight line when highlightedLine prop changes
  createEffect(
    on(
      () => [props.highlightedLine, props.focusRequestId] as const,
      ([target]) => {
        cancelFocus?.();
        if (target) focusLine(target);
      },
    ),
  );

  // Track dispose functions for rendered components
  const disposeList: (() => void)[] = [];

  // Track whether full file content has been loaded for expanding unchanged lines
  let fileContentLoaded = false;
  let expandedSourceRefs: { baseSha?: string; headSha?: string } = {};
  const assertSelectionRevision = () => {
    if (fileContentLoaded && props.commitScope)
      throw new Error(
        "Expanded source is not pinned to this commit. Reload the commit diff and select its patch lines instead.",
      );
  };
  const withSourceRevision = (selection: SelectedSource): SelectedSource =>
    !fileContentLoaded
      ? selection
      : {
          ...selection,
          revision:
            selection.side === "LEFT"
              ? `expanded comparison-base source: ${expandedSourceRefs.baseSha ?? "revision unavailable"} (not the PR merge-base)`
              : `expanded head source: ${expandedSourceRefs.headSha ?? "revision unavailable"}`,
        };
  let fileContentLoading = false;
  // Track loading state per hunk separator element so we can show spinners
  const loadingHunkSeparators = new Set<HTMLElement>();

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
    if (!props.sessionId && !props.prUrl) return false;

    fileContentLoading = true;
    try {
      const { oldContent, newContent, baseSha, headSha } = await fetchFileContentCached(
        { sessionId: props.sessionId, prUrl: props.prUrl, variantId: props.variantId },
        props.file.name,
        props.file.prevName ?? undefined,
      );
      expandedSourceRefs = { baseSha, headSha };
      hideCandidate();

      // Clone the FileDiffMetadata so the renderer sees a new reference and
      // invalidates its render cache (which was built without oldLines/newLines).
      const fullOldFile = {
        name: props.file.prevName ?? props.file.name,
        contents: oldContent ?? "",
        cacheKey: `${props.file.prevName ?? props.file.name}:${oldContent?.length ?? 0}:full-old`,
      };
      const fullNewFile = {
        name: props.file.name,
        contents: newContent ?? "",
        cacheKey: `${props.file.name}:${newContent?.length ?? 0}:full-new`,
      };

      // Rebuild the diff from the complete file contents instead of mutating the
      // patch-parsed diff in-place. The hunk metadata in props.file references the
      // partial patch line arrays, so swapping in full-file line arrays produces
      // duplicated/misaligned hunks when expanding.
      enrichedFile = parseDiffFromFile(fullOldFile, fullNewFile);

      // Preserve metadata used elsewhere in the app.
      enrichedFile = {
        ...enrichedFile,
        prevName: props.file.prevName,
        mode: props.file.mode,
        prevMode: props.file.prevMode,
        newObjectId: props.file.newObjectId,
        prevObjectId: props.file.prevObjectId,
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
   * Shows a loading spinner on the separator element while fetching.
   */
  const handleExpandClick = async (
    hunkIndex: number,
    direction: ExpansionDirections,
    separatorEl?: HTMLElement,
  ) => {
    const needsInstanceRefresh = !fileContentLoaded;
    // Show loading state on the separator
    if (separatorEl) {
      loadingHunkSeparators.add(separatorEl);
      separatorEl.classList.add("hunk-loading");
      // Replace content with spinner
      const originalContent = separatorEl.innerHTML;
      separatorEl.innerHTML =
        '<span class="hunk-spinner" style="display:inline-block;width:12px;height:12px;border:1.5px solid currentColor;border-top-color:transparent;border-radius:50%;animation:hunk-spin 0.6s linear infinite"></span><span style="margin-left:4px">Loading…</span>';
      separatorEl.style.pointerEvents = "none";

      // Ensure spinner animation is available
      if (!document.getElementById("hunk-spin-style")) {
        const style = document.createElement("style");
        style.id = "hunk-spin-style";
        style.textContent = "@keyframes hunk-spin { to { transform: rotate(360deg) } }";
        document.head.appendChild(style);
      }

      const loaded = await ensureFileContent();
      if (!loaded || !instance) {
        // Restore original content on failure
        separatorEl.innerHTML = originalContent;
        separatorEl.style.pointerEvents = "";
        separatorEl.classList.remove("hunk-loading");
        loadingHunkSeparators.delete(separatorEl);
        return;
      }

      loadingHunkSeparators.delete(separatorEl);
    } else {
      const loaded = await ensureFileContent();
      if (!loaded || !instance) return;
    }

    // VirtualizedFileDiff keeps its initial file reference for size calculations,
    // so recreate it once the patch has been replaced with complete file contents.
    if (needsInstanceRefresh && _containerRef) {
      createInstance(_containerRef);
    } else {
      instance.render({
        fileDiff: currentFile(),
        lineAnnotations: lineAnnotations(),
        forceRender: true,
      });
    }

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
    _fileDiffInstance: FileDiff<DiffAnnotationMetadata>,
  ): HTMLElement => {
    const container = document.createElement("div");
    container.className = "hunk-sep";
    container.style.cssText =
      "display:flex;align-items:center;justify-content:center;gap:6px;padding:2px 0;font-size:11px;opacity:0.4;cursor:pointer;user-select:none;transition:opacity 0.15s";
    container.onmouseenter = () => {
      container.style.opacity = "0.7";
    };
    container.onmouseleave = () => {
      container.style.opacity = "0.4";
    };

    // Only show expand controls if there are collapsed lines
    if (hunk.lines > 0) {
      // If the collapsed region is large enough for separate up/down controls
      const isChunked = hunk.expandable?.chunked ?? hunk.lines > 100;
      const canUp = hunk.expandable?.up ?? true;
      const canDown = hunk.expandable?.down ?? true;

      if (isChunked && canUp && canDown) {
        // Separate up/down buttons for large regions
        const upBtn = document.createElement("button");
        upBtn.className = "hunk-arrow";
        upBtn.style.cssText =
          "padding:0 2px;background:none;border:none;cursor:pointer;color:inherit;font-size:inherit";
        upBtn.textContent = "↑";
        upBtn.title = "Expand up";
        upBtn.onclick = (e) => {
          e.stopPropagation();
          handleExpandClick(hunk.hunkIndex, "up", container);
        };

        const label = document.createElement("span");
        label.textContent = `⋯ ${hunk.lines} lines`;

        const downBtn = document.createElement("button");
        downBtn.className = "hunk-arrow";
        downBtn.style.cssText =
          "padding:0 2px;background:none;border:none;cursor:pointer;color:inherit;font-size:inherit";
        downBtn.textContent = "↓";
        downBtn.title = "Expand down";
        downBtn.onclick = (e) => {
          e.stopPropagation();
          handleExpandClick(hunk.hunkIndex, "down", container);
        };

        container.appendChild(upBtn);
        container.appendChild(label);
        container.appendChild(downBtn);
      } else {
        // Single expand-all button
        const label = document.createElement("span");
        label.textContent = `⋯ ${hunk.lines} lines`;
        container.appendChild(label);
      }

      // Click on the whole separator expands in both directions
      container.onclick = () => {
        handleExpandClick(hunk.hunkIndex, "both", container);
      };
    }

    return container;
  };

  const createInstance = (el: HTMLDivElement) => {
    const expandedHunks = new Map(instance?.getExpandedHunks());
    instance?.cleanUp();
    for (const dispose of disposeList.splice(0)) dispose();
    el.innerHTML = "";
    const options: FileDiffOptions<DiffAnnotationMetadata> = {
      diffStyle: props.settings.diffStyle,
      theme: props.settings.theme,
      lineDiffType: props.settings.lineDiffType,
      hunkSeparators: props.readOnly ? undefined : renderHunkSeparator,
      disableFileHeader: true,
      enableLineSelection: !props.readOnly,
      unsafeCSS: getCustomCSS(),
      onLineSelectionEnd: (range: SelectedLineRange | null) => {
        if (props.readOnly) return;
        if (range && range.start && range.end) {
          if (props.onAskAi && !props.askEditorOpen) {
            const root = instance?.getFileContainer()?.shadowRoot;
            const side = range.side === "deletions" ? "deletions" : "additions";
            if (root)
              setBubbleAnchor(
                lineSelectionAnchor(root, () =>
                  [range.start, range.end].flatMap((line) => {
                    const indices = instance?.getLineIndex(line, side);
                    const row = indices
                      ? root.querySelector(focusRowSelector(indices, side, line))
                      : null;
                    return row ? [row] : [];
                  }),
                ),
              );
            try {
              assertSelectionRevision();
              if (range.endSide && range.endSide !== range.side)
                throw new Error("Select gutter lines on one diff side only.");
              setAiCandidate(
                withSourceRevision(
                  extractLines(
                    currentFile(),
                    range.side === "deletions" ? "LEFT" : "RIGHT",
                    range.start,
                    range.end,
                  ),
                ),
              );
              setSelectionError(null);
            } catch (error) {
              setAiCandidate(null);
              setSelectionError(
                error instanceof Error ? error.message : "Unable to read selection.",
              );
            }
          }
          // Clear any existing text selection so it doesn't block future interactions
          window.getSelection()?.removeAllRanges();

          const side = range.side === "deletions" ? "LEFT" : "RIGHT";
          const startLine = Math.min(range.start, range.end);
          const endLine = Math.max(range.start, range.end);
          setPendingComment({
            startLine,
            endLine,
            side,
            expectedHeadSha: props.commentHeadSha ?? undefined,
            scope: props.selectionScope,
          });
          // Re-render to show the pending comment form
          setTimeout(rerender, 0);
        }
      },
      renderAnnotation: (annotation: { metadata: DiffAnnotationMetadata }) => {
        const { metadata } = annotation;
        const div = document.createElement("div");

        if (metadata.type === "github-comment" && props.prUrl) {
          const key = metadata.comment.key;
          const uiState = githubUiStates.get(key) ?? createGithubCommentUiState();
          githubUiStates.set(key, uiState);
          const dispose = renderGithubCommentCard(div, {
            uiState,
            get comment() {
              return (
                props.githubComments?.find((comment) => comment.key === key) ?? metadata.comment
              );
            },
            scope: githubPrScope(props.prUrl),
            get operations() {
              return props.githubOperations ?? [];
            },
            get thread() {
              return metadata.thread;
            },
          });
          disposeList.push(dispose);
        } else if (metadata.type === "thread") {
          const { rootComment, replies } = metadata;
          div.className = "p-2.5 my-1 mx-2 bg-bg-elevated border border-border";

          // Render the CommentThread component into the div
          const dispose = renderCommentThread(div, {
            rootComment,
            replies,
            githubContext: githubContext(),
            onEdit: async (commentId, body, key, expectedBody) => {
              await props.onEditComment(commentId, body, key, expectedBody);
            },
            onDelete: async (commentId) => {
              await props.onDeleteComment(commentId);
            },
            onReply: async (body, key) => {
              await props.onReplyToComment(rootComment.id, body, key);
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
            onCreateComment: props.onCreateFindingComment,
          });
          disposeList.push(dispose);
        } else if (metadata.type === "pending") {
          div.className = "p-2.5 my-1 mx-2 bg-bg-surface border border-accent";

          // Render the PendingCommentForm component into the div
          const key = `${metadata.expectedHeadSha ?? "manual"}:${metadata.side}:${metadata.startLine}:${metadata.endLine}`;
          const draft =
            commentDrafts.get(key) ??
            createCachedCommentDraft(
              metadata.initialBody ?? "",
              `${props.prUrl}:${props.file.name}:${key}`,
              props.prUrl,
            );
          commentDrafts.set(key, draft);
          div.dataset.commentFile = props.file.name;
          div.dataset.commentLine = String(metadata.endLine);
          div.dataset.commentSide = metadata.side;
          const dispose = renderCachedCommentForm(div, {
            draft,
            startLine: metadata.startLine,
            endLine: metadata.endLine,
            disabled: () => !!metadata.scope && metadata.scope !== props.selectionScope,
            onSubmit: async (body, draftKey) => {
              await props.onAddComment({
                line: metadata.endLine,
                side: metadata.side,
                body,
                startLine: metadata.startLine,
                endLine: metadata.endLine,
                expectedHeadSha: metadata.expectedHeadSha,
                draftKey,
              });
              setPendingComment(null);
              commentDrafts.delete(key);
              window.getSelection()?.removeAllRanges();
              // Durable intent no longer inserts a fake remote comment to trigger this render.
              setTimeout(rerender, 0);
            },
            onCancel: () => {
              setPendingComment(null);
              commentDrafts.delete(key);
              setTimeout(rerender, 0);
            },
            onDraftChange: () =>
              props.onCommentDraftChange?.(
                [...commentDrafts.values()].some((draft) => !!draft.body.trim()),
              ),
          });
          disposeList.push(dispose);
        }

        return div;
      },
      onPostRender: () => highlightSearchMatch(),
    };
    instance = nonVirtualized
      ? new FocusableFileDiff(options, props.workerPool)
      : new FocusableVirtualizedFileDiff(options, props.virtualizer, undefined, props.workerPool);
    for (const [index, region] of expandedHunks) {
      instance.getExpandedHunks().set(index, region);
    }

    instance.render({
      fileDiff: currentFile(),
      containerWrapper: el,
      lineAnnotations: lineAnnotations(),
    });
    if (fileContentLoaded)
      instance.getFileContainer()!.dataset.expandedHead = expandedSourceRefs.headSha ?? "";
  };

  const renderDiff = (el: HTMLDivElement) => {
    _containerRef = el;
    createInstance(el);
  };

  onCleanup(() => {
    cancelFocus?.();
    instance?.cleanUp();
    // Queued comment/annotation rerenders may still fire after this view unmounts.
    instance = undefined;
    for (const dispose of disposeList.splice(0)) dispose();
  });

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
        if (isCollapsed) {
          cancelFocus?.();
          hideCandidate();
        }
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
        ref={(el) => {
          headerRef = el;
        }}
        type="button"
        onClick={() => setCollapsed(!collapsed())}
        style={{ top: "var(--diff-toolbar-height, 0px)" }}
        class="w-full flex items-center gap-2 px-3 py-1.5 bg-bg-elevated hover:bg-bg-surface text-left group sticky z-10 border border-border rounded-t-sm"
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
      <Show when={props.onAskAi && bubbleAnchor()}>
        {(anchor) => (
          <SelectionBubble
            anchor={anchor()}
            error={selectionError()}
            label={
              aiCandidate()
                ? `Lines ${aiCandidate()!.startLine}–${aiCandidate()!.endLine}`
                : undefined
            }
            onAsk={
              aiCandidate()
                ? () => {
                    const selection = aiCandidate();
                    if (selection) props.onAskAi?.(selection, anchor());
                    hideCandidate();
                  }
                : undefined
            }
            onDismiss={clearAiSelection}
            onHide={hideCandidate}
          />
        )}
      </Show>
      <Show when={!collapsed()}>
        <div
          onMouseUp={captureText}
          onKeyUp={captureText}
          class="border border-t-0 border-border rounded-b-sm overflow-hidden"
          ref={renderDiff}
        />
      </Show>
    </div>
  );
}
