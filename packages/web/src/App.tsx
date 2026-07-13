import type { FileDiffMetadata } from "@pierre/diffs";
import { useSearchParams, A } from "@solidjs/router";
import {
  type Component,
  createSignal,
  createEffect,
  createMemo,
  Show,
  onMount,
  onCleanup,
  on,
} from "solid-js";

import type { PrStatus, PrInfo } from "@better-review/shared";

import { ChatPanel } from "./ChatPanel";
import { ApproveButton } from "./components/ApproveButton";
import { CommitNavigator } from "./components/CommitNavigator";
import { PrCommentsPanel } from "./components/PrCommentsPanel";
import { PrStatusBar } from "./components/PrStatusBar";
import { ReviewModeToggle } from "./components/ReviewModeToggle";
import { ThemeToggle } from "./components/ThemeToggle";
import { PrProvider, usePrContext } from "./context/PrContext";
import { Button, TextInput } from "./design-system";
import { SettingsPanel } from "./diff/SettingsPanel";
import { ACCENT_LABELS, ACCENT_THEME_VARS } from "./diff/types";
import { THEME_LABELS, type ReviewMode, type PrCommit } from "./diff/types";
import {
  DiffViewer,
  getFileElementId,
  type DiffCommentDraft,
  type PRComment,
  type DiffSettings,
  DEFAULT_DIFF_SETTINGS,
} from "./DiffViewer";
import { FileTreePanel } from "./FileTreePanel";
import { SpinnerIcon } from "./icons/spinner-icon";
import {
  queryKeys,
  api,
  queryClient,
  type IssueComment,
  getReadFiles,
  toggleFileRead as queryToggleFileRead,
  getReviewOrder,
  setReviewOrder as querySetReviewOrder,
  getAnnotations,
  addAnnotations as queryAddAnnotations,
  removeAnnotation as queryRemoveAnnotation,
} from "./lib/query";
import { uiTheme } from "./lib/theme";
import { trpc } from "./lib/trpc";
import type { Annotation } from "./utils/parseReviewTokens";

const SETTINGS_STORAGE_KEY = "diff-settings";
const PANELS_STORAGE_KEY = "panel-visibility";
const FOCUS_MODE_STORAGE_KEY = "focus-mode";

// Valid theme keys for validation
const VALID_THEMES = new Set(Object.keys(THEME_LABELS));
const VALID_ACCENTS = new Set(Object.keys(ACCENT_LABELS));
const ACCENT_CSS_VAR_MAP = {
  accent: "--color-accent",
  accentDim: "--color-accent-dim",
  accentBright: "--color-accent-bright",
  accentText: "--color-accent-text",
  borderFocus: "--color-border-focus",
  primary: "--color-primary",
  primaryHover: "--color-primary-hover",
  primaryText: "--color-primary-text",
} as const;

function loadSettings(): DiffSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Validate theme - if invalid, use default
      if (parsed.theme && !VALID_THEMES.has(parsed.theme)) {
        parsed.theme = DEFAULT_DIFF_SETTINGS.theme;
      }
      if (parsed.accentColor && !VALID_ACCENTS.has(parsed.accentColor)) {
        parsed.accentColor = DEFAULT_DIFF_SETTINGS.accentColor;
      }
      return { ...DEFAULT_DIFF_SETTINGS, ...parsed };
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_DIFF_SETTINGS;
}

function saveSettings(settings: DiffSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors
  }
}

interface PanelVisibility {
  chat: boolean;
  files: boolean;
}

function loadPanelVisibility(): PanelVisibility {
  try {
    const stored = localStorage.getItem(PANELS_STORAGE_KEY);
    if (stored) {
      return { chat: true, files: true, ...JSON.parse(stored) };
    }
  } catch {}
  return { chat: true, files: true };
}

function savePanelVisibility(visibility: PanelVisibility): void {
  try {
    localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify(visibility));
  } catch {}
}

interface QueuedPr {
  url: string;
  title: string;
  repository: { nameWithOwner: string };
}

const AppContent: Component = () => {
  const { setPrUrl: setContextPrUrl } = usePrContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const [prUrl, setPrUrl] = createSignal("");
  const [loadedPrUrl, setLoadedPrUrl] = createSignal<string | null>(null);
  const [initialLoadTriggered, setInitialLoadTriggered] = createSignal(false);
  const [prQueue, setPrQueue] = createSignal<QueuedPr[]>([]);
  const [prInfo, setPrInfo] = createSignal<PrInfo | null>(null);
  const [prStatus, setPrStatus] = createSignal<PrStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [loadingComments, setLoadingComments] = createSignal(false);
  const [diff, setDiff] = createSignal<string | null>(null);
  const [files, setFiles] = createSignal<FileDiffMetadata[]>([]);
  const [comments, setComments] = createSignal<PRComment[]>([]);
  const [issueComments, setIssueComments] = createSignal<IssueComment[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [settings, setSettings] = createSignal<DiffSettings>(loadSettings());

  // Review state
  const [reviewOrder, setReviewOrder] = createSignal<string[] | null>(null);
  const [aiAnnotations, setAiAnnotations] = createSignal<Annotation[]>([]);
  const [reviewCommentsHidden, setReviewCommentsHidden] = createSignal(false);
  const [highlightedLine, setHighlightedLine] = createSignal<{
    file: string;
    line: number;
  } | null>(null);
  const [readFiles, setReadFiles] = createSignal<Set<string>>(new Set());

  // Panel visibility
  const [compactLayout, setCompactLayout] = createSignal(false);
  const [panelVisibility, setPanelVisibility] =
    createSignal<PanelVisibility>(loadPanelVisibility());
  const togglePanel = (panel: keyof PanelVisibility) => {
    const opening = !panelVisibility()[panel];
    const newVisibility =
      compactLayout() && opening
        ? { chat: panel === "chat", files: panel === "files" }
        : { ...panelVisibility(), [panel]: opening };
    setPanelVisibility(newVisibility);
    savePanelVisibility(newVisibility);
  };

  onMount(() => {
    const query = window.matchMedia("(max-width: 1024px)");
    const syncLayout = () => {
      const enteringCompactLayout = query.matches && !compactLayout();
      setCompactLayout(query.matches);

      if (enteringCompactLayout) {
        setPanelVisibility({ chat: false, files: false });
      }
    };

    syncLayout();
    query.addEventListener("change", syncLayout);
    onCleanup(() => query.removeEventListener("change", syncLayout));
  });
  // Focus mode - hides header and chat, maximizes diff area
  const [focusMode, setFocusMode] = createSignal(
    localStorage.getItem(FOCUS_MODE_STORAGE_KEY) === "true",
  );
  const toggleFocusMode = () => {
    const next = !focusMode();
    setFocusMode(next);
    localStorage.setItem(FOCUS_MODE_STORAGE_KEY, String(next));
  };

  // Commit mode state
  const [reviewMode, setReviewMode] = createSignal<ReviewMode>("full");
  const [commits, setCommits] = createSignal<PrCommit[]>([]);
  const [currentCommitIndex, setCurrentCommitIndex] = createSignal(0);
  const [commitDiff, setCommitDiff] = createSignal<string | null>(null);
  const [loadingCommits, setLoadingCommits] = createSignal(false);

  // Active diff based on review mode
  const activeDiff = createMemo(() => {
    return reviewMode() === "full" ? diff() : commitDiff();
  });

  // File names for the chat panel
  const fileNames = createMemo(() => files().map((f) => f.name));

  // Ordered files - respects reviewOrder when set
  const orderedFiles = createMemo(() => {
    const order = reviewOrder();
    const allFiles = files();
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

  // Find the next PR in the queue
  const nextPr = createMemo(() => {
    const queue = prQueue();
    const current = loadedPrUrl();
    if (!current || queue.length === 0) return null;

    const currentIndex = queue.findIndex((pr) => pr.url === current);
    if (currentIndex === -1) {
      // Current PR not in queue, return first in queue
      return queue[0];
    }
    // Return next PR, or null if at end
    return queue[currentIndex + 1] ?? null;
  });

  // Scroll to file (and optionally line)
  const scrollToFile = (fileName: string, line?: number) => {
    const elementId = getFileElementId(fileName);
    const element = document.getElementById(elementId);
    if (element) {
      element.scrollIntoView({ behavior: "instant", block: "start" });

      // If line is specified, highlight it
      if (line) {
        setHighlightedLine({ file: fileName, line });
        // Clear highlight after 3 seconds
        setTimeout(() => setHighlightedLine(null), 3000);
      }
    }
  };

  // Apply review order
  const applyReviewOrder = (order: string[]) => {
    setReviewOrder(order);
    const url = loadedPrUrl();
    if (url) {
      querySetReviewOrder(url, order);
    }
  };

  // Toggle file read status
  const toggleFileRead = (fileName: string) => {
    const url = loadedPrUrl();
    if (!url) return;
    const newReadFiles = queryToggleFileRead(url, fileName);
    setReadFiles(newReadFiles);
  };

  // Dismiss an AI annotation
  const dismissAiAnnotation = (annotationId: string) => {
    const url = loadedPrUrl();
    if (url) {
      const updated = queryRemoveAnnotation(url, annotationId);
      setAiAnnotations(updated);
    }
  };

  // Add new AI annotations (called when chat receives annotations)
  const addNewAiAnnotations = (annotations: Annotation[]) => {
    const url = loadedPrUrl();
    if (url && annotations.length > 0) {
      const updated = queryAddAnnotations(url, annotations);
      setAiAnnotations(updated);
    }
  };

  // Load commit diff using TanStack Query (auto-cached)
  const loadCommitDiff = async (sha: string) => {
    const url = loadedPrUrl();
    if (!url) return;

    setLoadingCommits(true);
    try {
      const diff = await queryClient.fetchQuery({
        queryKey: queryKeys.pr.commitDiff(url, sha),
        queryFn: () => api.fetchCommitDiff(url, sha),
      });
      setCommitDiff(diff);
    } catch (err) {
      console.error("Failed to load commit diff:", err);
    } finally {
      setLoadingCommits(false);
    }
  };

  // Navigate to next commit
  const goToNextCommit = async () => {
    const idx = currentCommitIndex();
    const c = commits();
    if (idx < c.length - 1) {
      setCurrentCommitIndex(idx + 1);
      await loadCommitDiff(c[idx + 1].sha);
    }
  };

  // Navigate to previous commit
  const goToPrevCommit = async () => {
    const idx = currentCommitIndex();
    const c = commits();
    if (idx > 0) {
      setCurrentCommitIndex(idx - 1);
      await loadCommitDiff(c[idx - 1].sha);
    }
  };

  // Select specific commit
  const selectCommit = async (index: number) => {
    const c = commits();
    if (index >= 0 && index < c.length) {
      setCurrentCommitIndex(index);
      await loadCommitDiff(c[index].sha);
    }
  };

  // Switch to commit mode
  const switchToCommitMode = async () => {
    setReviewMode("commit");
    const c = commits();
    if (c.length > 0 && !commitDiff()) {
      await loadCommitDiff(c[0].sha);
    }
  };

  // Switch to full mode
  const switchToFullMode = () => {
    setReviewMode("full");
  };

  // Handle mode change
  const handleModeChange = (mode: ReviewMode) => {
    if (mode === "commit") {
      switchToCommitMode();
    } else {
      switchToFullMode();
    }
  };

  // Keyboard shortcut for focus mode
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't trigger in input/textarea/contenteditable
      const tag = (e.target as HTMLElement)?.tagName;
      const isEditable = (e.target as HTMLElement)?.isContentEditable;
      if (tag === "INPUT" || tag === "TEXTAREA" || isEditable) return;
      if (e.key === "f" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        toggleFocusMode();
      }
      if (e.key === "Escape" && focusMode()) {
        e.preventDefault();
        toggleFocusMode();
      }
    };
    window.addEventListener("keydown", handler);
    // Cleanup on unmount would go here if needed
  });

  // Fetch PR queue on mount
  onMount(async () => {
    try {
      const data = await trpc.prs.list.query();
      if (data.prs) {
        setPrQueue(
          data.prs.map(
            (pr: { url: string; title: string; repository: { nameWithOwner: string } }) => ({
              url: pr.url,
              title: pr.title,
              repository: pr.repository,
            }),
          ),
        );
      }
    } catch {
      // Silently fail - queue is optional
    }
  });

  // Load PR from URL query param on mount
  onMount(() => {
    const urlPr = searchParams.prUrl;
    const prUrlValue = Array.isArray(urlPr) ? urlPr[0] : urlPr;
    if (prUrlValue && !initialLoadTriggered()) {
      setPrUrl(prUrlValue);
      setInitialLoadTriggered(true);
      // Call loadPr directly instead of relying on form DOM element
      setTimeout(() => {
        loadPr(new Event("submit"));
      }, 0);
    }
  });

  // Sync URL when PR is loaded
  createEffect(() => {
    const loaded = loadedPrUrl();
    if (loaded) {
      setSearchParams({ prUrl: loaded });
    }
  });

  // Load saved review state when PR changes
  createEffect(() => {
    const url = loadedPrUrl();
    if (url) {
      const savedOrder = getReviewOrder(url);
      if (savedOrder) {
        setReviewOrder(savedOrder);
      } else {
        setReviewOrder(null);
      }

      const savedAnnotations = getAnnotations(url);
      setAiAnnotations(savedAnnotations);

      const savedReadFiles = getReadFiles(url);
      setReadFiles(savedReadFiles);
    } else {
      setReviewOrder(null);
      setAiAnnotations([]);
      setReadFiles(new Set<string>());
    }
  });

  // Sync commit mode to URL params (using commit SHA for stable/shareable URLs)
  createEffect(
    on(
      () => [reviewMode(), currentCommitIndex(), commits()] as const,
      ([mode, idx, c]) => {
        if (loadedPrUrl()) {
          if (mode === "commit" && c[idx]) {
            setSearchParams({
              prUrl: loadedPrUrl()!,
              mode: "commit",
              commit: c[idx].sha.slice(0, 7),
            });
          } else {
            setSearchParams({
              prUrl: loadedPrUrl()!,
              mode: undefined,
              commit: undefined,
            });
          }
        }
      },
      { defer: true },
    ),
  );

  // Persist settings to localStorage when they change
  createEffect(() => {
    saveSettings(settings());
  });

  // Update document title when PR is loaded
  createEffect(() => {
    const status = prStatus();
    if (status?.title) {
      document.title = `${status.title} - better-review`;
    } else {
      document.title = "better-review";
    }
  });

  createEffect(() => {
    const accentVars = ACCENT_THEME_VARS[settings().accentColor][uiTheme()];
    for (const [key, cssVar] of Object.entries(ACCENT_CSS_VAR_MAP)) {
      document.documentElement.style.setProperty(
        cssVar,
        accentVars[key as keyof typeof accentVars],
      );
    }
  });

  const loadPr = async (e: Event) => {
    e.preventDefault();
    if (!prUrl() || loading()) return;

    // Cancel any in-flight queries for other PRs
    await queryClient.cancelQueries();

    const currentPrUrl = prUrl();
    setError(null);
    // Reset commit mode state
    setReviewMode("full");
    setCurrentCommitIndex(0);
    setCommitDiff(null);

    // Show cached data immediately if available
    const cachedDiff = queryClient.getQueryData<string>(queryKeys.pr.diff(currentPrUrl));
    const cachedInfo = queryClient.getQueryData<{
      owner: string;
      repo: string;
      number: string;
    } | null>(queryKeys.pr.info(currentPrUrl));
    const cachedCommits = queryClient.getQueryData<PrCommit[]>(queryKeys.pr.commits(currentPrUrl));
    const cachedComments = queryClient.getQueryData<PRComment[]>(
      queryKeys.pr.comments(currentPrUrl),
    );
    const cachedIssueComments = queryClient.getQueryData<IssueComment[]>(
      queryKeys.pr.issueComments(currentPrUrl),
    );
    const cachedStatus = queryClient.getQueryData<PrStatus>(queryKeys.pr.status(currentPrUrl));

    if (cachedDiff) {
      setDiff(cachedDiff);
      setLoadedPrUrl(currentPrUrl);
      setContextPrUrl(currentPrUrl);
    }
    if (cachedInfo) setPrInfo(cachedInfo);
    if (cachedCommits) setCommits(cachedCommits);
    if (cachedComments) setComments(cachedComments);
    if (cachedIssueComments) setIssueComments(cachedIssueComments);
    if (cachedStatus) setPrStatus(cachedStatus);

    // Only show loading if no cached data
    if (!cachedDiff) {
      setLoading(true);
      setLoadedPrUrl(null);
      setPrInfo(null);
      setPrStatus(null);
      setCommits([]);
    }

    try {
      // Use batch endpoint to fetch all data in one request
      // Respects cache - only fetches if data is stale or missing
      const data = await queryClient.fetchQuery({
        queryKey: queryKeys.pr.batch(currentPrUrl),
        queryFn: () => api.fetchPrBatch(currentPrUrl),
        staleTime: 5 * 60 * 1000, // 5 minutes - use cached if fresh
      });

      // Populate individual query caches for components that use them
      queryClient.setQueryData(queryKeys.pr.diff(currentPrUrl), data.diff);
      queryClient.setQueryData(queryKeys.pr.info(currentPrUrl), data.info);
      queryClient.setQueryData(queryKeys.pr.commits(currentPrUrl), data.commits);
      queryClient.setQueryData(queryKeys.pr.comments(currentPrUrl), data.comments);
      queryClient.setQueryData(queryKeys.pr.issueComments(currentPrUrl), data.issueComments);
      queryClient.setQueryData(queryKeys.pr.status(currentPrUrl), data.status);

      setDiff(data.diff);
      setLoadedPrUrl(currentPrUrl);
      setContextPrUrl(currentPrUrl);
      setCommits(data.commits);
      if (data.info) {
        setPrInfo(data.info);
      }

      // Restore commit mode from URL params (commit is a SHA prefix)
      const urlMode = searchParams.mode;
      const urlCommitSha = searchParams.commit as string | undefined;
      if (urlMode === "commit" && data.commits.length > 0) {
        let idx = urlCommitSha
          ? data.commits.findIndex((c: PrCommit) => c.sha.startsWith(urlCommitSha))
          : 0;
        if (idx === -1) idx = 0;
        setCurrentCommitIndex(idx);
        loadCommitDiff(data.commits[idx].sha).then(() => {
          setReviewMode("commit");
        });
      }

      setLoading(false);

      setComments(data.comments);
      setIssueComments(data.issueComments);
      setPrStatus(data.status);
      setLoadingStatus(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load PR");
    } finally {
      setLoading(false);
      setLoadingComments(false);
    }
  };

  // Helper to update comments in both local state and TanStack Query cache
  const updateCommentsCache = (url: string, newComments: PRComment[]) => {
    setComments(newComments);
    queryClient.setQueryData(queryKeys.pr.comments(url), newComments);
  };

  const addComment = async ({ filePath, line, side, body }: DiffCommentDraft) => {
    try {
      const data = await trpc.pr.addComment.mutate({
        prUrl: prUrl()!,
        filePath,
        line,
        side,
        body,
      });
      if (data.comment) {
        const url = loadedPrUrl();
        if (url) updateCommentsCache(url, [...comments(), data.comment]);
      }
      return data;
    } catch (err) {
      console.error("Failed to add comment:", err);
      return {
        error: err instanceof Error ? err.message : "Failed to add comment",
      };
    }
  };

  const replyToComment = async (commentId: number, body: string) => {
    try {
      const data = await trpc.pr.replyToComment.mutate({
        prUrl: prUrl()!,
        commentId,
        body,
      });
      if (data.comment) {
        const url = loadedPrUrl();
        if (url) updateCommentsCache(url, [...comments(), data.comment]);
      }
      return data;
    } catch (err) {
      console.error("Failed to reply to comment:", err);
      return { error: err instanceof Error ? err.message : "Failed to reply" };
    }
  };

  const editComment = async (commentId: number, body: string) => {
    try {
      const data = await trpc.pr.editComment.mutate({
        prUrl: loadedPrUrl()!,
        commentId,
        body,
      });
      if (data.comment) {
        const url = loadedPrUrl();
        if (url) {
          const newComments = comments().map((c) =>
            c.id === commentId ? { ...c, body: data.comment.body } : c,
          );
          updateCommentsCache(url, newComments);
        }
      }
      return data;
    } catch (err) {
      console.error("Failed to edit comment:", err);
      return {
        error: err instanceof Error ? err.message : "Failed to edit comment",
      };
    }
  };

  const deleteComment = async (commentId: number) => {
    try {
      await trpc.pr.deleteComment.mutate({
        prUrl: loadedPrUrl()!,
        commentId,
      });
      const url = loadedPrUrl();
      if (url) {
        updateCommentsCache(
          url,
          comments().filter((c) => c.id !== commentId),
        );
      }
      return { success: true };
    } catch (err) {
      console.error("Failed to delete comment:", err);
      return {
        error: err instanceof Error ? err.message : "Failed to delete comment",
      };
    }
  };

  const resolveThread = async (threadId: string, resolved: boolean) => {
    const url = loadedPrUrl();
    if (!url) return;
    try {
      if (resolved) {
        await trpc.pr.resolveThread.mutate({ prUrl: url, threadId });
      } else {
        await trpc.pr.unresolveThread.mutate({ prUrl: url, threadId });
      }
      // Update local state: mark all comments in this thread as resolved/unresolved
      const newComments = comments().map((c) =>
        c.threadId === threadId ? { ...c, isResolved: resolved } : c,
      );
      updateCommentsCache(url, newComments);
      return { success: true };
    } catch (err) {
      console.error("Failed to resolve/unresolve thread:", err);
      return {
        error: err instanceof Error ? err.message : "Failed to resolve thread",
      };
    }
  };

  // Helper to update issue comments in both local state and TanStack Query cache
  const updateIssueCommentsCache = (
    url: string,
    newComments: typeof issueComments extends () => infer T ? T : never,
  ) => {
    setIssueComments(newComments);
    queryClient.setQueryData(queryKeys.pr.issueComments(url), newComments);
  };

  const addIssueComment = async (body: string) => {
    const url = loadedPrUrl();
    if (!url) return;
    try {
      const data = await trpc.pr.addIssueComment.mutate({
        prUrl: url,
        body,
      });
      if (data.comment) {
        updateIssueCommentsCache(url, [...issueComments(), data.comment]);
      }
    } catch (err) {
      console.error("Failed to add issue comment:", err);
      throw err;
    }
  };

  const editIssueComment = async (commentId: number, body: string) => {
    const url = loadedPrUrl();
    if (!url) return;
    try {
      const data = await trpc.pr.editIssueComment.mutate({
        prUrl: url,
        commentId,
        body,
      });
      if (data.comment) {
        const newComments = issueComments().map((c) =>
          c.id === commentId
            ? {
                ...c,
                body: data.comment.body,
                updated_at: data.comment.updated_at,
              }
            : c,
        );
        updateIssueCommentsCache(url, newComments);
      }
    } catch (err) {
      console.error("Failed to edit issue comment:", err);
      throw err;
    }
  };

  const deleteIssueComment = async (commentId: number) => {
    const url = loadedPrUrl();
    if (!url) return;
    try {
      await trpc.pr.deleteIssueComment.mutate({
        prUrl: url,
        commentId,
      });
      updateIssueCommentsCache(
        url,
        issueComments().filter((c) => c.id !== commentId),
      );
    } catch (err) {
      console.error("Failed to delete issue comment:", err);
      throw err;
    }
  };

  return (
    <div class="h-screen bg-bg text-text flex flex-col">
      {/* Header Bar - hidden in focus mode */}
      <Show when={!focusMode()}>
        <header class="border-b border-border bg-bg-surface">
          <div class="px-4 py-2.5">
            <div class="flex items-center justify-between mb-2.5">
              <A href="/" class="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
                <span class="w-2 h-2 bg-accent" aria-hidden="true" />
                <h1 class="text-sm font-mono font-semibold tracking-tight text-text">
                  better-review
                </h1>
              </A>
              <div class="flex items-center gap-1 text-sm font-mono">
                <div class="flex items-center gap-0.5 border-r border-border pr-2 mr-1">
                  <Button
                    onClick={() => togglePanel("chat")}
                    variant="ghost"
                    size="sm"
                    class={panelVisibility().chat ? "bg-bg-elevated text-text" : "text-text-muted"}
                    aria-pressed={panelVisibility().chat}
                    aria-controls="chat-panel"
                    title="Toggle chat panel"
                  >
                    Chat
                  </Button>
                  <Button
                    onClick={() => togglePanel("files")}
                    variant="ghost"
                    size="sm"
                    class={panelVisibility().files ? "bg-bg-elevated text-text" : "text-text-muted"}
                    aria-pressed={panelVisibility().files}
                    aria-controls="file-tree-panel"
                    title="Toggle file tree panel"
                  >
                    Files
                  </Button>
                </div>
                <Button
                  onClick={toggleFocusMode}
                  variant="ghost"
                  size="sm"
                  title="Enter focus mode (F)"
                >
                  Focus
                </Button>
                <A
                  href="/"
                  class="max-xl:hidden px-2 py-1.5 text-text-muted hover:text-text transition-colors"
                >
                  Reviews
                </A>
                <A
                  href="/kanban"
                  class="max-xl:hidden px-2 py-1.5 text-text-muted hover:text-text transition-colors"
                >
                  Projects
                </A>
                <ThemeToggle />
                <SettingsPanel settings={settings()} onChange={setSettings} />
              </div>
            </div>

            <form onSubmit={loadPr} class="flex items-center gap-2 border-t border-border pt-2.5">
              <TextInput
                type="text"
                inputMode="url"
                size="sm"
                value={prUrl()}
                onInput={(e) => setPrUrl(e.currentTarget.value)}
                placeholder="github.com/owner/repo/pull/123"
                aria-label="Pull request URL"
                class="min-w-0 flex-1 font-mono"
              />
              <Show when={!loadedPrUrl() || prUrl().trim() !== loadedPrUrl()}>
                <Button
                  type="submit"
                  disabled={loading() || !prUrl().trim()}
                  variant="primary"
                  size="sm"
                >
                  {loading() ? "Opening…" : "Open"}
                </Button>
              </Show>
              <Show when={nextPr()}>
                {(next) => (
                  <A
                    href={`/review?prUrl=${encodeURIComponent(next().url)}`}
                    class="flex items-center gap-1 px-2 py-1.5 font-mono text-xs text-text-muted transition-colors hover:text-text"
                    title={`Next: ${next().title}`}
                  >
                    Next <span aria-hidden="true">→</span>
                  </A>
                )}
              </Show>
            </form>

            {error() && (
              <div class="mt-3 px-3 py-2 border border-error/50 bg-diff-remove-bg text-error text-base">
                {error()}
              </div>
            )}
          </div>

          {/* PR Status Bar */}
          <Show when={loadedPrUrl()}>
            <div class="px-4 py-2 border-t border-border bg-bg flex items-start justify-between gap-4 relative">
              <div class="flex-1 min-w-0">
                <PrStatusBar
                  status={prStatus()}
                  loading={loadingStatus()}
                  repoOwner={prInfo()?.owner}
                  repoName={prInfo()?.repo}
                />
              </div>
              <div class="flex items-center gap-2 flex-shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={aiAnnotations().length === 0 && comments().length === 0}
                  onClick={() => setReviewCommentsHidden((hidden) => !hidden)}
                  title={
                    reviewCommentsHidden()
                      ? "Show all annotations and GitHub comments"
                      : "Hide all annotations and GitHub comments"
                  }
                >
                  {reviewCommentsHidden() ? "Show comments" : "Hide comments"}
                </Button>
                <ReviewModeToggle
                  mode={reviewMode()}
                  onModeChange={handleModeChange}
                  commitCount={commits().length}
                  disabled={loading()}
                />
                <ApproveButton />
              </div>
            </div>
            {/* PR Comments (top-level conversation) */}
            <PrCommentsPanel
              comments={issueComments()}
              loading={loadingComments()}
              repoOwner={prInfo()?.owner}
              repoName={prInfo()?.repo}
              onAddComment={addIssueComment}
              onEditComment={editIssueComment}
              onDeleteComment={deleteIssueComment}
            />
          </Show>
        </header>
      </Show>

      {/* Focus mode exit bar */}
      <Show when={focusMode()}>
        <div class="flex items-center justify-between px-3 py-1.5 bg-bg-surface border-b border-accent/30">
          <div class="flex items-center gap-2">
            <span class="text-xs text-accent font-medium">Focus mode</span>
            <span class="text-xs text-text-faint">
              Diff takes priority. Press Esc or F to exit.
            </span>
          </div>
          <Button
            onClick={toggleFocusMode}
            variant="ghost"
            size="xs"
            class="text-accent hover:text-accent"
            title="Exit focus mode (F or Esc)"
          >
            Exit <span class="text-accent/60 ml-1 font-mono">F</span>
          </Button>
        </div>
      </Show>

      {/* Main content */}
      <div class="relative flex min-w-0 flex-1 overflow-hidden">
        {/* Chat panel (left) - hidden in focus mode */}
        <Show when={panelVisibility().chat && !focusMode()}>
          <ChatPanel
            prUrl={loadedPrUrl()}
            prNumber={prInfo()?.number ? parseInt(prInfo()!.number, 10) : null}
            repoOwner={prInfo()?.owner ?? null}
            repoName={prInfo()?.repo ?? null}
            files={fileNames()}
            reviewMode={reviewMode()}
            commitSha={
              reviewMode() === "commit" ? (commits()[currentCommitIndex()]?.sha ?? null) : null
            }
            theme={settings().theme}
            aiAnnotations={aiAnnotations()}
            onScrollToFile={scrollToFile}
            onApplyReviewOrder={applyReviewOrder}
            onAnnotationsReceived={addNewAiAnnotations}
          />
        </Show>

        {/* Center content */}
        <Show
          when={diff()}
          fallback={
            <div class="flex-1 flex items-center justify-center">
              <Show
                when={loading()}
                fallback={
                  <div class="w-full max-w-md px-6 text-center">
                    <h2 class="text-lg font-semibold tracking-tight text-text">
                      Open a pull request
                    </h2>
                    <p class="mt-2 text-sm leading-relaxed text-text-muted">
                      Paste a GitHub PR URL above to load its diff, comments, and review tools.
                    </p>
                    <p class="mt-4 font-mono text-xs text-text-faint">
                      github.com/owner/repo/pull/123
                    </p>
                  </div>
                }
              >
                <div class="flex items-center gap-3">
                  <SpinnerIcon class="animate-spin text-accent" size={20} />
                  <span class="text-text-faint text-base">Loading PR...</span>
                </div>
              </Show>
            </div>
          }
        >
          {/* Diff viewer (center) */}
          <div class="flex min-w-0 flex-1 flex-col overflow-y-auto">
            {/* Commit navigator (when in commit mode) */}
            <Show when={reviewMode() === "commit" && commits().length > 0}>
              <CommitNavigator
                commits={commits()}
                currentIndex={currentCommitIndex()}
                onSelectCommit={selectCommit}
                onPrev={goToPrevCommit}
                onNext={goToNextCommit}
                loading={loadingCommits()}
              />
            </Show>

            {/* Diff content */}
            <div class={`flex-1 overflow-y-auto pb-3 ${focusMode() ? "px-1" : "px-4"}`}>
              <Show
                when={activeDiff()}
                fallback={
                  <Show when={reviewMode() === "commit" && loadingCommits()}>
                    <div class="text-text-faint text-base">Loading commit diff...</div>
                  </Show>
                }
              >
                <DiffViewer
                  rawDiff={activeDiff()!}
                  comments={reviewCommentsHidden() ? [] : comments()}
                  aiAnnotations={reviewCommentsHidden() ? [] : aiAnnotations()}
                  loadingComments={!reviewCommentsHidden() && loadingComments()}
                  onAddComment={addComment}
                  onReplyToComment={replyToComment}
                  onEditComment={editComment}
                  onDeleteComment={deleteComment}
                  onResolveThread={resolveThread}
                  onDismissAiAnnotation={dismissAiAnnotation}
                  settings={settings()}
                  onFilesLoaded={setFiles}
                  repoOwner={prInfo()?.owner}
                  repoName={prInfo()?.repo}
                  fileOrder={reviewOrder()}
                  highlightedLine={highlightedLine()}
                  readFiles={readFiles()}
                  onToggleRead={toggleFileRead}
                  prUrl={loadedPrUrl()}
                />
              </Show>
            </div>
          </div>

          {/* File tree panel (right) */}
          <Show when={panelVisibility().files}>
            <div id="file-tree-panel" class="file-tree-shell flex shrink-0">
              <FileTreePanel
                files={orderedFiles()}
                onFileSelect={(file) => scrollToFile(file)}
                reviewOrder={reviewOrder()}
                readFiles={readFiles()}
                onToggleRead={toggleFileRead}
              />
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
};

const App: Component = () => {
  return (
    <PrProvider>
      <AppContent />
    </PrProvider>
  );
};

export default App;
