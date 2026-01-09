import type { FileDiffMetadata } from "@pierre/diffs";
import { useSearchParams, A } from "@solidjs/router";
import {
  type Component,
  createSignal,
  createEffect,
  createMemo,
  Show,
  onMount,
  on,
} from "solid-js";

import type { PrStatus, PrInfo } from "@better-review/shared";

import { ChatPanel } from "./ChatPanel";
import { ApproveButton } from "./components/ApproveButton";
import { CommitNavigator } from "./components/CommitNavigator";
import { PrCommentsPanel } from "./components/PrCommentsPanel";
import { PrStatusBar } from "./components/PrStatusBar";
import { ReviewModeToggle } from "./components/ReviewModeToggle";
import { PrProvider, usePrContext } from "./context/PrContext";
import { SettingsPanel } from "./diff/SettingsPanel";
import { FONT_FAMILY_MAP } from "./diff/types";
import { THEME_LABELS, type ReviewMode, type PrCommit } from "./diff/types";
import {
  DiffViewer,
  getFileElementId,
  type PRComment,
  type DiffSettings,
  DEFAULT_DIFF_SETTINGS,
} from "./DiffViewer";
import { FileTreePanel } from "./FileTreePanel";
import { useCurrentUser } from "./hooks/usePrData";
import { queryKeys, api, queryClient, type IssueComment } from "./lib/query";
import { trpc } from "./lib/trpc";
import type { Annotation } from "./utils/parseReviewTokens";

const SETTINGS_STORAGE_KEY = "diff-settings";
const REVIEW_ORDER_STORAGE_KEY = "review-order";
const ANNOTATIONS_STORAGE_KEY = "review-annotations";
const PANELS_STORAGE_KEY = "panel-visibility";

// Valid theme keys for validation
const VALID_THEMES = new Set(Object.keys(THEME_LABELS));

function loadSettings(): DiffSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Validate theme - if invalid, use default
      if (parsed.theme && !VALID_THEMES.has(parsed.theme)) {
        parsed.theme = DEFAULT_DIFF_SETTINGS.theme;
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

// Load review order from localStorage (keyed by PR URL)
function loadReviewOrder(prUrl: string): string[] | null {
  try {
    const stored = localStorage.getItem(REVIEW_ORDER_STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored);
      return data[prUrl] ?? null;
    }
  } catch {
    // Ignore
  }
  return null;
}

function saveReviewOrder(prUrl: string, order: string[]): void {
  try {
    const stored = localStorage.getItem(REVIEW_ORDER_STORAGE_KEY);
    const data = stored ? JSON.parse(stored) : {};
    data[prUrl] = order;
    localStorage.setItem(REVIEW_ORDER_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Ignore
  }
}

// Load annotations from localStorage (keyed by PR URL)
function loadAnnotations(prUrl: string): Annotation[] {
  try {
    const stored = localStorage.getItem(ANNOTATIONS_STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored);
      return data[prUrl] ?? [];
    }
  } catch {
    // Ignore
  }
  return [];
}

function _saveAnnotations(prUrl: string, annotations: Annotation[]): void {
  try {
    const stored = localStorage.getItem(ANNOTATIONS_STORAGE_KEY);
    const data = stored ? JSON.parse(stored) : {};
    data[prUrl] = annotations;
    localStorage.setItem(ANNOTATIONS_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Ignore
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
  const [_annotations, setAnnotations] = createSignal<Annotation[]>([]);
  const [highlightedLine, setHighlightedLine] = createSignal<{
    file: string;
    line: number;
  } | null>(null);

  // Panel visibility
  const [panelVisibility, setPanelVisibility] =
    createSignal<PanelVisibility>(loadPanelVisibility());
  const togglePanel = (panel: keyof PanelVisibility) => {
    const newVisibility = {
      ...panelVisibility(),
      [panel]: !panelVisibility()[panel],
    };
    setPanelVisibility(newVisibility);
    savePanelVisibility(newVisibility);
  };

  // Current user (for showing edit/delete on own comments) - using TanStack Query
  const { user: currentUser } = useCurrentUser();

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
      saveReviewOrder(url, order);
    }
  };

  // Add annotation as GitHub comment
  const addAnnotationAsComment = async (annotation: Annotation) => {
    // Scroll to the file and line first
    scrollToFile(annotation.file, annotation.line);

    // Format the comment body with severity prefix
    const severityPrefix =
      annotation.severity === "critical"
        ? "[CRITICAL] "
        : annotation.severity === "warning"
          ? "[WARNING] "
          : "";
    const body = `${severityPrefix}${annotation.message}`;

    // Add the comment via the existing addComment function
    // Default to RIGHT side (additions) for now
    await addComment(annotation.file, annotation.line, "RIGHT", body);
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

  // Preload all commit diffs in background using TanStack Query
  const preloadCommitDiffs = async (prUrl: string, commitList: PrCommit[]) => {
    for (const commit of commitList) {
      await queryClient.prefetchQuery({
        queryKey: queryKeys.pr.commitDiff(prUrl, commit.sha),
        queryFn: () => api.fetchCommitDiff(prUrl, commit.sha),
      });
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
      // Trigger load after state is set
      setTimeout(() => {
        const form = document.querySelector("form");
        if (form) {
          form.requestSubmit();
        }
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
      const savedOrder = loadReviewOrder(url);
      if (savedOrder) {
        setReviewOrder(savedOrder);
      } else {
        setReviewOrder(null);
      }

      const savedAnnotations = loadAnnotations(url);
      setAnnotations(savedAnnotations);
    } else {
      setReviewOrder(null);
      setAnnotations([]);
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

  // Sync font-mono CSS variable with settings
  createEffect(() => {
    const fontFamily = FONT_FAMILY_MAP[settings().fontFamily];
    document.documentElement.style.setProperty("--font-mono", fontFamily);
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

      // Preload all commit diffs in background
      if (data.commits.length > 0) {
        preloadCommitDiffs(currentPrUrl, data.commits);
      }

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

  const addComment = async (
    filePath: string,
    line: number,
    side: "LEFT" | "RIGHT",
    body: string,
  ) => {
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

  return (
    <div class="h-screen bg-bg text-text flex flex-col">
      {/* Header Bar */}
      <header class="border-b border-border bg-bg-surface">
        {/* Main Header */}
        <div class="px-4 py-3">
          <div class="flex items-center justify-between mb-3">
            <A href="/" class="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <span class="text-accent text-base">●</span>
              <h1 class="text-base text-text">better-review</h1>
            </A>
            <div class="flex items-center gap-4">
              <div class="flex items-center gap-1 border-r border-border pr-4">
                <button
                  onClick={() => togglePanel("chat")}
                  class={`px-2 py-1 text-base border transition-colors ${
                    panelVisibility().chat
                      ? "border-accent/50 text-accent"
                      : "border-border text-text-faint hover:text-text"
                  }`}
                  title="Toggle chat panel"
                >
                  Chat
                </button>
                <button
                  onClick={() => togglePanel("files")}
                  class={`px-2 py-1 text-base border transition-colors ${
                    panelVisibility().files
                      ? "border-accent/50 text-accent"
                      : "border-border text-text-faint hover:text-text"
                  }`}
                  title="Toggle file tree panel"
                >
                  Files
                </button>
              </div>
              <A href="/" class="text-base text-text-faint hover:text-text transition-colors">
                Browse PRs
              </A>
              <SettingsPanel settings={settings()} onChange={setSettings} />
            </div>
          </div>

          <form onSubmit={loadPr} class="flex gap-2">
            <div class="flex-1">
              <input
                type="text"
                value={prUrl()}
                onInput={(e) => setPrUrl(e.currentTarget.value)}
                placeholder="github.com/owner/repo/pull/123"
                class="w-full px-3 py-2 bg-bg border border-border text-text text-base placeholder:text-text-faint hover:border-text-faint focus:border-accent"
              />
            </div>
            <button
              type="submit"
              disabled={loading() || !prUrl()}
              class="px-4 py-2 bg-accent text-black font-medium hover:bg-accent-bright active:bg-accent disabled:opacity-30 disabled:cursor-not-allowed text-base"
            >
              {loading() ? "..." : "Load"}
            </button>
            <Show when={nextPr()}>
              {(next) => (
                <A
                  href={`/review?prUrl=${encodeURIComponent(next().url)}`}
                  class="px-4 py-2 border border-border text-text-faint hover:text-text hover:border-text-faint transition-colors text-base flex items-center gap-1"
                  title={`Next: ${next().title}`}
                >
                  Next PR <span class="text-accent">→</span>
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
          />
        </Show>
      </header>

      {/* Main content */}
      <div class="flex-1 flex overflow-hidden">
        {/* Chat panel (left) */}
        <Show when={panelVisibility().chat}>
          <ChatPanel
            prUrl={loadedPrUrl()}
            prNumber={prInfo()?.number ? parseInt(prInfo()!.number, 10) : null}
            repoOwner={prInfo()?.owner ?? null}
            repoName={prInfo()?.repo ?? null}
            files={fileNames()}
            onScrollToFile={scrollToFile}
            onApplyReviewOrder={applyReviewOrder}
            onAddAnnotationAsComment={addAnnotationAsComment}
          />
        </Show>

        {/* Center content */}
        <Show
          when={diff()}
          fallback={
            <Show when={!loading()}>
              <div class="flex-1 flex items-center justify-center">
                <div class="text-center">
                  <div class="text-text-faint text-base">Enter a GitHub PR URL to start</div>
                </div>
              </div>
            </Show>
          }
        >
          {/* Diff viewer (center) */}
          <div class="flex-1 overflow-y-auto flex flex-col">
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
            <div class="flex-1 overflow-y-auto px-4 py-3">
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
                  comments={comments()}
                  loadingComments={loadingComments()}
                  onAddComment={addComment}
                  onReplyToComment={replyToComment}
                  onEditComment={editComment}
                  onDeleteComment={deleteComment}
                  currentUser={currentUser()}
                  settings={settings()}
                  onFilesLoaded={setFiles}
                  repoOwner={prInfo()?.owner}
                  repoName={prInfo()?.repo}
                  fileOrder={reviewOrder()}
                  highlightedLine={highlightedLine()}
                />
              </Show>
            </div>
          </div>

          {/* File tree panel (right) */}
          <Show when={panelVisibility().files}>
            <FileTreePanel
              files={orderedFiles()}
              onFileSelect={(file) => scrollToFile(file)}
              reviewOrder={reviewOrder()}
            />
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
