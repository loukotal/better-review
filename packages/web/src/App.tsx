import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { useSearchParams, useLocation, A } from "@solidjs/router";
import {
  type Component,
  createSignal,
  createEffect,
  createRenderEffect,
  createMemo,
  Show,
  For,
  onMount,
  onCleanup,
  on,
  batch,
} from "solid-js";

import type { PrInfo } from "@better-review/shared";
import type { ResolvedSource } from "@better-review/shared";

import { ChatPanel } from "./ChatPanel";
import { AnchoredSelectionEditor } from "./components/AnchoredSelectionEditor";
import { AppHeader } from "./components/AppHeader";
import { ApproveButton } from "./components/ApproveButton";
import { CommitNavigator } from "./components/CommitNavigator";
import { DiffStatsBadge } from "./components/DiffStatsBadge";
import { DiffViewToggle, type DiffViewMode } from "./components/DiffViewToggle";
import { GithubCommentCard } from "./components/GithubCommentCard";
import { InlineFindingComment } from "./components/InlineFindingComment";
import { InlineSourceView } from "./components/InlineSourceView";
import { PrChecks } from "./components/PrChecks";
import { PrCommentsPanel } from "./components/PrCommentsPanel";
import { PrMergePanel } from "./components/PrMergePanel";
import { PrOverview, type PrDiscussionLocation } from "./components/PrOverview";
import { PrReviewActions } from "./components/PrReviewActions";
import { PrStatusBar } from "./components/PrStatusBar";
import { ReadingDiffEmpty, ReadingDiffSummary } from "./components/ReadingDiffState";
import { ReviewModeToggle } from "./components/ReviewModeToggle";
import { ReviewSettings } from "./components/ReviewSettings";
import { PrProvider, usePrContext } from "./context/PrContext";
import { Button, TextInput } from "./design-system";
import { SettingsPanel } from "./diff/SettingsPanel";
import { type ReviewMode, type PrCommit } from "./diff/types";
import {
  DiffViewer,
  getFileElementId,
  type DiffCommentDraft,
  type DiffSettings,
} from "./DiffViewer";
import { FileTreePanel } from "./FileTreePanel";
import { SpinnerIcon } from "./icons/spinner-icon";
import { type SelectedSource, type SelectionChatController } from "./lib/ask-ai-selection";
import { createAutomaticReviewOrder } from "./lib/automatic-review-order";
import { applyDiffAccent, loadDiffSettings, saveDiffSettings } from "./lib/diff-settings";
import { describePrLoadError, type PrLoadError } from "./lib/errors";
import {
  projectGithubComments,
  subscribeGithubComments,
  githubCommentLocation,
  githubLocationInPatch,
  githubThreadForComment,
} from "./lib/github-comment-views";
import {
  currentGithubActor,
  githubPrScope,
  githubWrites,
  queueGithubWrite,
} from "./lib/github-writes";
import {
  resolvePrTab,
  prListReturnPath,
  prListBackSteps,
  advancePrLinkState,
  prQueryChanges,
  prPageHref,
  type PrTab,
} from "./lib/pr-navigation";
import { createPrReadState } from "./lib/pr-read-state";
import { preserveReviewPosition } from "./lib/preserve-review-position";
import {
  queryKeys,
  api,
  queryClient,
  fetchPrCore,
  prReadQueryAdapter,
  getReviewedFiles,
  toggleReviewedFile,
  getReviewOrder,
  setReviewOrder as querySetReviewOrder,
  dismissTranscriptAnnotation,
  reconcileTranscriptAnnotations,
  type ReadingDiffResult,
} from "./lib/query";
import { createReviewInteractions } from "./lib/review-interactions";
import type { SelectionBubbleAnchor } from "./lib/selection-bubble";
import { uiTheme } from "./lib/theme";
import { trpc } from "./lib/trpc";
import type { Annotation } from "./utils/parseReviewTokens";

const PANELS_STORAGE_KEY = "panel-visibility";
const FOCUS_MODE_STORAGE_KEY = "focus-mode";

interface PanelVisibility {
  chat: boolean;
  files: boolean;
}

function loadPanelVisibility(): PanelVisibility {
  try {
    const stored = localStorage.getItem(PANELS_STORAGE_KEY);
    if (stored) {
      return { chat: false, files: true, ...JSON.parse(stored) };
    }
  } catch {}
  return { chat: false, files: true };
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
  const location = useLocation();
  const updatePrParams = (params: Record<string, string | undefined>, replace = false) => {
    if (!prQueryChanges(location.search, params)) return;
    setSearchParams(params, {
      replace,
      state: replace ? location.state : advancePrLinkState(location.state),
    });
  };
  const activeTab = createMemo(() => resolvePrTab(searchParams));
  const changesActive = () => activeTab() === "changes";
  const [changesVisited, setChangesVisited] = createSignal(false);
  const [prUrl, setPrUrl] = createSignal("");
  const prReads = createPrReadState({ query: prReadQueryAdapter, requestedUrl: prUrl });
  const [prRead, setPrRead] = createSignal(prReads.getState());
  onCleanup(prReads.subscribe(() => setPrRead(prReads.getState())));
  onCleanup(() => prReads.dispose());
  const detail = createMemo(() => prRead().detail);
  const detailView = createMemo(() => prRead().displayDetail);
  const detailStaleNotice = createMemo(() => prRead().staleNotice);
  const displayMetadata = () => {
    const section = detailView()?.metadata;
    return section?.status === "available" ? section.data : undefined;
  };
  const detailError = createMemo(() => prRead().detailError);
  const mergeDetail = createMemo(() => prRead().mergeDetail);
  const refreshingDetail = createMemo(() => prRead().refreshingDetail);
  const [discussionSourceNotice, setDiscussionSourceNotice] = createSignal<string>();
  const commentsUnavailable = createMemo(() => prRead().commentsUnavailable);
  const issueCommentsUnavailable = createMemo(() => prRead().issueCommentsUnavailable);
  const reviewThreads = createMemo(() => prRead().reviewThreads);
  let changesRoot: HTMLDivElement | undefined;
  let reviewFocus:
    | {
        element: HTMLElement;
        selection?: [number | null, number | null, "forward" | "backward" | "none" | null];
      }
    | undefined;
  const rememberReviewFocus = () => {
    const element = document.activeElement;
    if (
      !(element instanceof HTMLElement) ||
      (!changesRoot?.contains(element) && !element.closest('[aria-label="Ask about selection"]'))
    )
      return;
    reviewFocus = {
      element,
      selection:
        element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
          ? [element.selectionStart, element.selectionEnd, element.selectionDirection]
          : undefined,
    };
  };
  const detailMetadata = () => {
    const section = detail()?.metadata;
    return section?.status === "available" ? section.data : undefined;
  };
  const detailHead = () => detailMetadata()?.head.sha;
  const overviewApprovalOperations = () =>
    outboxOperations().filter(
      (item) =>
        item.command.action.kind === "approve" &&
        item.command.expectedActor.id === currentGithubActor()?.id &&
        item.command.action.expectedHeadSha === detailHead() &&
        item.status !== "cancelled",
    );
  const overviewApprovalState = () =>
    overviewApprovalOperations().some((item) => item.status !== "synced")
      ? ("pending" as const)
      : prStatus()?.viewerApproval?.commitSha === detailHead() &&
          prStatus()?.viewerApproval?.login === currentGithubActor()?.login &&
          !!detailHead()
        ? ("synced" as const)
        : undefined;
  const selectTab = (tab: PrTab) => {
    updatePrParams({ tab });
  };
  // Run before JSX hides/inerts Changes, including browser history transitions.
  createRenderEffect(
    on(
      changesActive,
      (active, previous) => {
        if (previous && !active) rememberReviewFocus();
        if (!active) return;
        const saved = reviewFocus;
        const focusAtTransition = document.activeElement;
        requestAnimationFrame(() => {
          if (!changesActive() || !saved?.element.isConnected || saved.element.closest("[inert]"))
            return;
          if (
            document.activeElement !== focusAtTransition ||
            (focusAtTransition !== document.body &&
              focusAtTransition !== document.documentElement &&
              focusAtTransition !== saved.element &&
              !(
                focusAtTransition instanceof Element &&
                focusAtTransition.closest('[aria-label="Pull request tabs"]')
              ))
          )
            return;
          saved.element.focus({ preventScroll: true });
          if (
            saved.selection &&
            (saved.element instanceof HTMLTextAreaElement ||
              saved.element instanceof HTMLInputElement)
          ) {
            const [start, end, direction] = saved.selection;
            if (start !== null && end !== null)
              saved.element.setSelectionRange(start, end, direction ?? undefined);
          }
        });
      },
      { defer: true },
    ),
  );
  const [switchingPr, setSwitchingPr] = createSignal(false);
  const [conversationOpen, setConversationOpen] = createSignal(false);
  const [loadedPrUrl, setLoadedPrUrl] = createSignal<string | null>(null);
  const [initialLoadTriggered, setInitialLoadTriggered] = createSignal(false);
  const [prQueue, setPrQueue] = createSignal<QueuedPr[]>([]);
  const [prInfo, setPrInfo] = createSignal<PrInfo | null>(null);
  const prStatus = createMemo(() => prRead().status);
  const loadingStatus = createMemo(() => prRead().loadingStatus);
  const [loading, setLoading] = createSignal(false);
  const loadingComments = createMemo(() => prRead().loadingComments);
  const [diff, setDiff] = createSignal<string | null>(null);
  const [diffViewMode, setDiffViewMode] = createSignal<DiffViewMode>("original");
  const [readingDiffs, setReadingDiffs] = createSignal(new Map<string, ReadingDiffResult>());
  const [readingDiffLoadingKeys, setReadingDiffLoadingKeys] = createSignal(new Set<string>());
  const [readingDiffErrors, setReadingDiffErrors] = createSignal(new Map<string, string>());
  const [files, setFiles] = createSignal<FileDiffMetadata[]>([]);
  const comments = createMemo(() => prRead().comments);
  const [outboxVersion, setOutboxVersion] = createSignal(0);
  const unsubscribeOutbox = githubWrites.subscribe(() => setOutboxVersion((value) => value + 1));
  onCleanup(unsubscribeOutbox);
  onCleanup(subscribeGithubComments(() => setOutboxVersion((value) => value + 1)));
  const outboxOperations = createMemo(() => {
    outboxVersion();
    const url = loadedPrUrl();
    return url ? githubWrites.getState(githubPrScope(url)).operations : [];
  });
  const issueComments = createMemo(() => prRead().issueComments);
  const githubView = createMemo(() => {
    outboxVersion();
    const url = loadedPrUrl();
    return url ? projectGithubComments(url) : undefined;
  });
  const [error, setError] = createSignal<PrLoadError | null>(null);
  const [settings, setSettings] = createSignal<DiffSettings>(loadDiffSettings());

  // Review state
  const [reviewOrder, setReviewOrder] = createSignal<string[] | null>(null);
  const automaticOrderController = createAutomaticReviewOrder({
    apply: (order) => applyReviewOrder(order),
    context: () => automaticOrderContext(),
  });
  const [automaticOrderState, setAutomaticOrderState] = createSignal(
    automaticOrderController.getState(),
  );
  onCleanup(
    automaticOrderController.subscribe(() =>
      setAutomaticOrderState(automaticOrderController.getState()),
    ),
  );
  onCleanup(() => automaticOrderController.dispose());
  const automaticOrder = createMemo(() => automaticOrderState().enabled);
  const initialOrderPending = createMemo(() => automaticOrderState().initialPending);
  const [aiAnnotations, setAiAnnotations] = createSignal<Annotation[]>([]);
  const [reviewCommentsHidden, setReviewCommentsHidden] = createSignal(false);
  const [highlightedLine, setHighlightedLine] = createSignal<{
    file: string;
    line: number;
    side?: "LEFT" | "RIGHT";
  } | null>(null);
  const [readFiles, setReadFiles] = createSignal<Set<string>>(new Set());
  const [selectionController, setSelectionController] =
    createSignal<SelectionChatController | null>(null);
  const [diffRevision, setDiffRevision] = createSignal<{
    headSha?: string | null;
    comparisonBaseSha?: string | null;
  }>({});
  const ownApprovalOperations = createMemo(() =>
    outboxOperations().filter(
      (item) =>
        item.command.action.kind === "approve" &&
        item.command.expectedActor.id === currentGithubActor()?.id &&
        item.command.action.expectedHeadSha === diffRevision().headSha &&
        item.status !== "cancelled",
    ),
  );
  let diffScrollRef: HTMLDivElement | undefined;

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
    const query = window.matchMedia("(max-width: 1279px)");
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
  createEffect(() => {
    if (searchParams.showChat === "1") {
      setPanelVisibility((previous) => ({
        ...previous,
        chat: true,
        ...(compactLayout() ? { files: false } : {}),
      }));
    }
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
  const unplacedGithubComments = createMemo(
    () =>
      githubView()?.comments.filter((comment) => {
        if (comment.ref.kind !== "review-comment") return false;
        if (reviewMode() === "commit" || diffViewMode() === "reading") return true;
        const location = githubCommentLocation(comment, outboxOperations(), githubView()?.comments);
        const file = files().find((file) => file.name === location?.path);
        return (
          !location ||
          !file ||
          !githubLocationInPatch(location, file) ||
          (!!location.expectedHeadSha && location.expectedHeadSha !== diffRevision().headSha)
        );
      }) ?? [],
  );

  // Active diff based on review mode
  const activeDiff = createMemo(() => {
    return reviewMode() === "full" ? diff() : commitDiff();
  });

  const currentCommitSha = createMemo(() =>
    reviewMode() === "commit" ? (commits()[currentCommitIndex()]?.sha ?? null) : null,
  );
  // Session hydration needs paths before DiffViewer mounts. Reuse the same parsed files there.
  const parsedDiffFiles = createMemo(() => {
    const raw = activeDiff();
    return raw ? parsePatchFiles(raw).flatMap((patch) => patch.files) : [];
  });
  createEffect(() => {
    const parsed = parsedDiffFiles();
    setFiles(parsed);
    const url = loadedPrUrl();
    setReadFiles(url ? getReviewedFiles(url, parsed) : new Set<string>());
  });
  let selectionScopeVersion = 0;
  const selectionScope = createMemo(() => {
    const values = [
      prUrl(),
      loadedPrUrl(),
      reviewMode(),
      currentCommitSha(),
      activeDiff(),
      diffRevision(),
      loadingCommits(),
      switchingPr(),
    ];
    return `${++selectionScopeVersion}:${values[0]}`;
  });
  const interactions = createReviewInteractions(
    () => ({
      prUrl: prUrl(),
      loadedPrUrl: loadedPrUrl(),
      scope: selectionScope(),
      headSha: diffRevision().headSha,
      comparisonBaseSha: diffRevision().comparisonBaseSha,
      commitSha: currentCommitSha(),
      commitScope: reviewMode() === "commit",
      loading: !changesActive() || loading() || loadingCommits() || switchingPr(),
      files: files(),
    }),
    {
      resolve: (target, range, signal) =>
        trpc.prReview.navigateSource.query(
          {
            sessionId: target.sessionId,
            path: target.lookup?.path ?? target.path,
            ref: target.lookup?.ref ?? target.ref,
            side: target.lookup?.side ?? target.side,
            line: target.line,
            range,
          },
          { signal },
        ),
      focus: (source) => focusResolvedSource(source),
    },
  );
  const {
    question: askSelection,
    findingComment,
    inlineFinding,
    notice: findingNotice,
    selectionClearToken,
    dismissSelection,
  } = interactions;
  const sourceTarget = interactions.source.target;
  onCleanup(interactions.source.close);
  createEffect(on(selectionScope, interactions.source.close, { defer: true }));
  const askAboutSource = (
    selection: SelectedSource,
    anchor: SelectionBubbleAnchor,
    revision?: string,
  ) => {
    interactions.selectSource(selection, anchor, revision);
  };

  const readingDiffScopeKey = createMemo(() => {
    const url = loadedPrUrl();
    if (!url) return null;
    const sha = currentCommitSha();
    return sha ? `${url}#${sha}` : `${url}#full`;
  });

  const currentReadingDiff = createMemo(() => {
    const key = readingDiffScopeKey();
    return key ? (readingDiffs().get(key) ?? null) : null;
  });

  const readingDiffLoading = createMemo(() => {
    const key = readingDiffScopeKey();
    return key ? readingDiffLoadingKeys().has(key) : false;
  });

  const readingDiffError = createMemo(() => {
    const key = readingDiffScopeKey();
    return key ? (readingDiffErrors().get(key) ?? null) : null;
  });

  const readingDiffScopeLabel = createMemo(() =>
    reviewMode() === "commit" ? "selected commit" : "full pull request",
  );

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
  const scrollToFile = (fileName: string, line?: number, side?: "LEFT" | "RIGHT") => {
    const elementId = getFileElementId(fileName);
    const element = document.getElementById(elementId);
    if (element) {
      element.scrollIntoView({ behavior: "instant", block: "start" });

      // If line is specified, highlight it
      if (line) {
        setHighlightedLine({ file: fileName, line, side });
        // Clear highlight after 3 seconds
        setTimeout(() => setHighlightedLine(null), 3000);
      }
    }
  };

  const focusResolvedSource = (source: Extract<ResolvedSource, { status: "found" }>) => {
    const container = document
      .getElementById(getFileElementId(source.path))
      ?.querySelector<HTMLElement>("diffs-container");
    const file = files().find((file) => file.name === source.path);
    const visible = file?.hunks.some(
      (hunk) =>
        source.line >= hunk.additionStart && source.line < hunk.additionStart + hunk.additionCount,
    );
    const expanded =
      container?.dataset.expandedHead === source.ref &&
      container.shadowRoot?.querySelector(
        `[data-additions] [data-line="${source.line}"], [data-unified] [data-line="${source.line}"]`,
      );
    if (!container || (!visible && !expanded)) return false;
    scrollToFile(source.path, source.line, "RIGHT");
    return true;
  };
  createEffect(() => {
    const target = sourceTarget();
    if (!target) return;
    const scope = selectionScope();
    requestAnimationFrame(
      () =>
        scope === selectionScope() &&
        sourceTarget() === target &&
        diffScrollRef?.querySelector("[data-inline-source]")?.scrollIntoView({ block: "start" }),
    );
  });

  // Apply review order
  const applyReviewOrder = (order: string[]) => {
    preserveReviewPosition(diffScrollRef, () => setReviewOrder(order));
    const url = loadedPrUrl();
    if (url) {
      querySetReviewOrder(url, order);
    }
  };

  const automaticOrderContext = () => ({
    requestedUrl: prUrl(),
    loadedUrl: loadedPrUrl(),
    mode: reviewMode(),
    revision: reviewMode() === "commit" ? currentCommitSha() : (diffRevision().headSha ?? null),
    paths: fileNames(),
    loading: loading(),
    loadingCommits: loadingCommits(),
    switchingPr: switchingPr(),
  });
  createEffect(() => automaticOrderController.updateContext(automaticOrderContext()));

  // Toggle file read status
  const toggleFileRead = (fileName: string) => {
    const url = loadedPrUrl();
    const file = files().find((entry) => entry.name === fileName);
    if (!url || !file) return;
    toggleReviewedFile(url, file);
    setReadFiles(getReviewedFiles(url, files()));
  };

  // Dismiss an AI annotation
  const dismissAiAnnotation = (annotationId: string) => {
    const url = loadedPrUrl();
    if (url) {
      const annotation = aiAnnotations().find((annotation) => annotation.id === annotationId);
      if (annotation) dismissTranscriptAnnotation(url, annotation);
      setAiAnnotations(reconcileTranscriptAnnotations(url, aiAnnotations()));
    }
  };

  // The active transcript is authoritative, including an empty revision-filtered result.
  const addNewAiAnnotations = (annotations: Annotation[]) => {
    const url = loadedPrUrl();
    if (url) {
      setAiAnnotations(reconcileTranscriptAnnotations(url, annotations));
    }
  };

  // Load commit diff using TanStack Query (auto-cached)
  let commitDiffRequest = 0;
  const loadCommitDiff = async (sha: string) => {
    const url = loadedPrUrl();
    if (!url) return;
    const request = ++commitDiffRequest;

    setLoadingCommits(true);
    setCommitDiff(null);
    try {
      const diff = await queryClient.fetchQuery({
        queryKey: queryKeys.pr.commitDiff(url, sha),
        queryFn: () => api.fetchCommitDiff(url, sha),
      });
      if (
        request === commitDiffRequest &&
        prUrl() === url &&
        loadedPrUrl() === url &&
        currentCommitSha() === sha
      )
        setCommitDiff(diff);
    } catch (err) {
      console.error("Failed to load commit diff:", err);
    } finally {
      if (request === commitDiffRequest) setLoadingCommits(false);
    }
  };

  // Navigate to next commit
  const goToNextCommit = () => {
    const idx = currentCommitIndex();
    const c = commits();
    if (idx < c.length - 1) {
      selectCommit(idx + 1);
    }
  };

  // Navigate to previous commit
  const goToPrevCommit = () => {
    const idx = currentCommitIndex();
    if (idx > 0) {
      selectCommit(idx - 1);
    }
  };

  // Select specific commit
  const selectCommit = (index: number) => {
    const c = commits();
    if (index >= 0 && index < c.length) {
      updatePrParams({ mode: "commit", commit: c[index].sha.slice(0, 7) });
    }
  };

  // Handle mode change
  const handleModeChange = (mode: ReviewMode) => {
    if (mode === "commit") {
      selectCommit(Math.min(currentCommitIndex(), commits().length - 1));
    } else {
      updatePrParams({ mode: undefined, commit: undefined });
    }
  };

  const generateReadingDiff = async (force = false) => {
    const url = loadedPrUrl();
    const key = readingDiffScopeKey();
    if (!url || !key || !activeDiff() || readingDiffLoadingKeys().has(key)) return;

    setReadingDiffLoadingKeys((current) => new Set(current).add(key));
    setReadingDiffErrors((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });

    try {
      const result = await api.generateReadingDiff(url, currentCommitSha() ?? undefined, force);
      setReadingDiffs((current) => new Map(current).set(key, result));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to generate reading diff";
      setReadingDiffErrors((current) => new Map(current).set(key, message));
    } finally {
      setReadingDiffLoadingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  // Keyboard shortcut for focus mode
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if (!changesActive()) return;
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
    onCleanup(() => window.removeEventListener("keydown", handler));
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

  // Same-route PR navigation must load the new PR rather than retain its predecessor's status.
  let routeLoadRequest = 0;
  onCleanup(() => routeLoadRequest++);
  createEffect(
    on(
      () => searchParams.prUrl,
      (urlPr) => {
        const request = ++routeLoadRequest;
        const prUrlValue = Array.isArray(urlPr) ? urlPr[0] : urlPr;
        if (prUrlValue && (!initialLoadTriggered() || prUrlValue !== prUrl())) {
          setPrUrl(prUrlValue);
          setInitialLoadTriggered(true);
          // Call loadPr directly instead of relying on form DOM element
          setTimeout(() => {
            if (request === routeLoadRequest && prUrl() === prUrlValue)
              void loadPr(new Event("submit"), true);
          }, 0);
        }
      },
    ),
  );

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

      // Legacy PR-wide caches have no trustworthy active-session provenance.
      // ChatPanel republishes the active transcript rather than merging these records.
      setAiAnnotations([]);
    } else {
      setReviewOrder(null);
      setAiAnnotations([]);
    }
  });

  // URL is authoritative on entry and Back/Forward; hydration never writes history.
  createEffect(
    on(
      () =>
        [
          searchParams.mode,
          searchParams.commit,
          commits(),
          loadedPrUrl(),
          loading(),
          changesVisited(),
        ] as const,
      ([mode, commit, available, loaded, pending, visited]) => {
        if (!visited || pending || !loaded || loaded !== prUrl()) return;
        if (mode !== "commit" || !available.length) {
          setReviewMode("full");
          return;
        }
        const prefix = typeof commit === "string" ? commit : undefined;
        let index = prefix ? available.findIndex((entry) => entry.sha.startsWith(prefix)) : 0;
        if (index < 0) index = 0;
        const sha = available[index]!.sha;
        const changed = reviewMode() !== "commit" || currentCommitSha() !== sha;
        setCurrentCommitIndex(index);
        setReviewMode("commit");
        if (changed || (!commitDiff() && !loadingCommits())) void loadCommitDiff(sha);
      },
    ),
  );

  // Persist settings to localStorage when they change
  createEffect(() => {
    saveDiffSettings(settings());
  });

  // Update document title when PR is loaded
  createEffect(() => {
    const title = detailMetadata()?.title ?? prStatus()?.title;
    if (title) {
      document.title = `${title} - better-review`;
    } else {
      document.title = "better-review";
    }
  });

  createEffect(() => {
    applyDiffAccent(settings().accentColor, uiTheme());
  });

  let prLoadGeneration = 0;
  onCleanup(() => prLoadGeneration++);
  const loadPr = async (e: Event, fromRoute = false) => {
    e.preventDefault();
    if (!prUrl()) return;
    let scope: ReturnType<typeof githubPrScope>;
    try {
      const input = prUrl().trim();
      scope = githubPrScope(input.startsWith("github.com/") ? `https://${input}` : input);
    } catch {
      setError({
        title: "Invalid pull request URL",
        message: "Use https://github.com/owner/repo/pull/123.",
      });
      return;
    }
    const currentPrUrl = scope.url;
    setPrUrl(currentPrUrl);
    reviewFocus = undefined;
    ++prLoadGeneration;
    batch(() => {
      setChangesVisited(false);
      automaticOrderController.cancelInitialLoad();
      setLoading(false);
      setError(null);
      setDiscussionSourceNotice(undefined);
      prReads.select(currentPrUrl);
      setDiff(null);
      setDiffRevision({});
      setReviewMode("full");
      setDiffViewMode("original");
      setReadingDiffs(new Map());
      setReadingDiffLoadingKeys(new Set<string>());
      setReadingDiffErrors(new Map());
      setCurrentCommitIndex(0);
      setCommitDiff(null);
      ++commitDiffRequest;
      setLoadingCommits(false);
      setCommits([]);
      setPrInfo({ owner: scope.owner, repo: scope.repo, number: String(scope.number) });
      setLoadedPrUrl(currentPrUrl);
      setContextPrUrl(currentPrUrl);
      setSwitchingPr(false);
    });
    updatePrParams({ prUrl: currentPrUrl }, fromRoute);
  };

  const loadChanges = async () => {
    const currentPrUrl = loadedPrUrl();
    if (!currentPrUrl || changesVisited() || currentPrUrl !== prUrl()) return;
    const generation = prLoadGeneration;
    const isCurrentPr = () => generation === prLoadGeneration && prUrl() === currentPrUrl;
    batch(() => {
      setLoading(true);
      setChangesVisited(true);
      automaticOrderController.beginInitialLoad(currentPrUrl);
    });
    try {
      // Respects cache - only fetches if data is stale or missing
      const data = await fetchPrCore(currentPrUrl);
      if (!isCurrentPr()) return;

      setDiff(data.diff);
      setDiffRevision({ headSha: data.headSha, comparisonBaseSha: data.comparisonBaseSha });
      setLoadedPrUrl(currentPrUrl);
      setSwitchingPr(false);
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
        setReviewMode("commit");
        void loadCommitDiff(data.commits[idx].sha);
      }
    } catch (err) {
      if (isCurrentPr()) {
        setError(describePrLoadError(err));
        automaticOrderController.cancelInitialLoad();
      }
    } finally {
      if (generation === prLoadGeneration) setLoading(false);
    }
  };

  createEffect(() => {
    if (changesActive() && loadedPrUrl() === prUrl() && !changesVisited()) void loadChanges();
  });

  const refreshDetail = () => prReads.refreshDetail();
  const refreshAfterMerge = () => prReads.refreshAfterMerge();

  const navigateOverviewSource = (location: PrDiscussionLocation) => {
    selectTab("changes");
    const generation = prLoadGeneration;
    const deadline = Date.now() + 15_000;
    const wait = () => {
      if (generation !== prLoadGeneration || !changesActive()) return;
      if (error() || Date.now() > deadline) {
        setDiscussionSourceNotice(
          "Source navigation unavailable. The original comment location is preserved in Overview.",
        );
        return;
      }
      if (loading() || !diff() || initialOrderPending()) {
        setTimeout(wait, 50);
        return;
      }
      const file = files().find((file) => file.name === location.path);
      if (
        !location.historical &&
        location.sourceRef === diffRevision().headSha &&
        reviewMode() === "full" &&
        file &&
        githubLocationInPatch(location, file)
      ) {
        setDiscussionSourceNotice(undefined);
        scrollToFile(location.path, location.line, location.side);
        return;
      }
      if (!location.sourceRef) {
        setDiscussionSourceNotice(
          `${location.path}:${location.line} (${location.side}): GitHub did not provide a trustworthy source revision. Open the original comment on GitHub; this location was not remapped to current HEAD.`,
        );
        return;
      }
      if (location.side === "LEFT") {
        setDiscussionSourceNotice(
          `${location.path}:${location.line} (LEFT): the comment records comparison head ${location.sourceRef}, not the immutable deleted-side source revision. Open its original GitHub location; this coordinate was not mapped onto HEAD.`,
        );
        return;
      }
      const sessionId = selectionController()?.currentSessionId();
      if (!sessionId) {
        setTimeout(wait, 50);
        return;
      }
      void interactions.openSource({
        sessionId,
        path: location.path,
        line: location.line,
        side: location.side,
        ref: location.sourceRef,
      });
    };
    setTimeout(wait, 0);
  };

  const writeScope = () => {
    const url = loadedPrUrl();
    if (!url || url !== prUrl())
      throw new Error("Wait for the selected PR to load. Your draft is preserved.");
    return url;
  };

  const addComment = async (draft: DiffCommentDraft) => {
    const url = writeScope();
    const expectedHeadSha = draft.expectedHeadSha;
    if (!expectedHeadSha)
      throw new Error(
        "This comment has no verified viewed head. Reload its source; your draft is preserved.",
      );
    await queueGithubWrite(
      url,
      {
        kind: "inline-comment",
        expectedHeadSha,
        body: draft.body,
        anchor: {
          path: draft.filePath,
          side: draft.side,
          line: draft.endLine ?? draft.line,
          ...(draft.startLine !== undefined && draft.startLine !== (draft.endLine ?? draft.line)
            ? { startLine: draft.startLine, startSide: draft.side }
            : {}),
        },
      },
      draft.draftKey,
    );
  };

  const replyToComment = async (commentId: number, body: string, draftKey?: string) => {
    await queueGithubWrite(
      writeScope(),
      {
        kind: "reply",
        target: { source: "remote", kind: "review-comment", id: commentId },
        body,
      },
      draftKey,
    );
  };
  const editComment = async (
    commentId: number,
    body: string,
    draftKey?: string,
    expectedBody?: string,
  ) => {
    const target = comments().find((c) => c.id === commentId);
    if (!target) throw new Error("Comment not loaded. Your draft is preserved.");
    await queueGithubWrite(
      writeScope(),
      {
        kind: "edit-comment",
        target: { source: "remote", kind: "review-comment", id: commentId },
        expectedBody: expectedBody ?? target.body,
        body,
      },
      draftKey,
    );
  };
  const deleteComment = async (commentId: number) => {
    const target = comments().find((c) => c.id === commentId);
    if (!target) throw new Error("Comment not loaded.");
    await queueGithubWrite(writeScope(), {
      kind: "delete-comment",
      target: { source: "remote", kind: "review-comment", id: commentId },
      expectedBody: target.body,
    });
  };
  const resolveThread = async (threadId: string, resolved: boolean) => {
    await queueGithubWrite(writeScope(), {
      kind: resolved ? "resolve-thread" : "unresolve-thread",
      target: { source: "remote", kind: "thread", nodeId: threadId },
    });
  };
  const addIssueComment = async (body: string, draftKey?: string) => {
    await queueGithubWrite(writeScope(), { kind: "issue-comment", body }, draftKey);
  };
  const editIssueComment = async (
    commentId: number,
    body: string,
    draftKey?: string,
    expectedBody?: string,
  ) => {
    const target = issueComments().find((c) => c.id === commentId);
    if (!target) throw new Error("Comment not loaded. Your draft is preserved.");
    await queueGithubWrite(
      writeScope(),
      {
        kind: "edit-comment",
        target: { source: "remote", kind: "issue-comment", id: commentId },
        expectedBody: expectedBody ?? target.body,
        body,
      },
      draftKey,
    );
  };
  const deleteIssueComment = async (commentId: number) => {
    const target = issueComments().find((c) => c.id === commentId);
    if (!target) throw new Error("Comment not loaded.");
    await queueGithubWrite(writeScope(), {
      kind: "delete-comment",
      target: { source: "remote", kind: "issue-comment", id: commentId },
      expectedBody: target.body,
    });
  };

  return (
    <div class="h-screen bg-bg text-text flex flex-col">
      {/* Header Bar - hidden in focus mode */}
      <Show when={!focusMode() || !changesActive()}>
        <AppHeader
          backHref={
            loadedPrUrl() || searchParams.prUrl
              ? prListReturnPath(searchParams.returnTo)
              : undefined
          }
          backSteps={prListBackSteps(location.state, prListReturnPath(searchParams.returnTo))}
          hideNavigation={!!loadedPrUrl()}
          onOpenPr={() => setSwitchingPr(!switchingPr())}
          prSwitcherOpen={switchingPr()}
          settings={
            <ReviewSettings
              automaticOrder={automaticOrder()}
              onAutomaticOrderChange={automaticOrderController.setEnabled}
            />
          }
          actions={
            <>
              <Show when={changesActive()}>
                {" "}
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
              </Show>
            </>
          }
        >
          <Show when={!loadedPrUrl() || switchingPr() || error()}>
            <div class="px-4 pb-3">
              <Show when={!loadedPrUrl() || switchingPr()}>
                <form
                  id="pr-switcher"
                  onSubmit={loadPr}
                  class="mt-2 flex items-center gap-2 border-t border-border pt-2"
                >
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
                      {loading() ? "Opening…" : error() ? "Try again" : "Open"}
                    </Button>
                  </Show>
                  <Show when={loadedPrUrl()}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setPrUrl(loadedPrUrl()!);
                        setSwitchingPr(false);
                      }}
                    >
                      Cancel
                    </Button>
                  </Show>
                </form>
              </Show>

              <Show when={error()}>
                {(loadError) => (
                  <div
                    role="alert"
                    aria-live="polite"
                    class="mt-3 flex max-w-3xl items-start gap-2.5 border border-error/50 bg-diff-remove-bg px-3 py-2.5"
                  >
                    <span
                      aria-hidden="true"
                      class="mt-0.5 flex size-4 shrink-0 items-center justify-center border border-error/60 font-mono text-xs font-semibold text-diff-remove-text"
                    >
                      !
                    </span>
                    <div class="min-w-0">
                      <p class="m-0 text-sm font-medium text-diff-remove-text">
                        {loadError().title}
                      </p>
                      <p class="m-0 mt-0.5 text-sm leading-5 text-text">{loadError().message}</p>
                    </div>
                  </div>
                )}
              </Show>
            </div>
          </Show>
          {/* PR Status Bar */}
          <Show when={loadedPrUrl() && changesActive()}>
            <div class="px-4 py-3 border-t border-border bg-bg flex flex-wrap items-center justify-between gap-x-6 gap-y-3 relative">
              <div class="flex-1 min-w-64">
                <PrStatusBar
                  onOpenChecks={() => selectTab("checks")}
                  status={prStatus()}
                  loading={loadingStatus()}
                  repoOwner={prInfo()?.owner}
                  repoName={prInfo()?.repo}
                />
              </div>
              <DiffStatsBadge files={files()} />
              <div class="flex flex-wrap items-center gap-2">
                <ReviewModeToggle
                  mode={reviewMode()}
                  onModeChange={handleModeChange}
                  commitCount={commits().length}
                  disabled={loading()}
                />
                <DiffViewToggle
                  mode={diffViewMode()}
                  onModeChange={setDiffViewMode}
                  disabled={loading() || loadingCommits()}
                />

                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={conversationOpen()}
                  aria-controls="pr-conversation"
                  onClick={() => setConversationOpen(!conversationOpen())}
                >
                  Conversation
                  {githubView()?.comments.filter(
                    (comment) => comment.ref.kind === "issue-comment" && !comment.deleted,
                  ).length
                    ? ` (${githubView()!.comments.filter((comment) => comment.ref.kind === "issue-comment" && !comment.deleted).length})`
                    : ""}
                </Button>
                <Show when={nextPr()}>
                  {(next) => (
                    <A
                      href={prPageHref(next().url, {
                        returnTo: prListReturnPath(searchParams.returnTo),
                      })}
                      state={advancePrLinkState(location.state)}
                      class="px-2 py-1 text-xs text-text-muted hover:text-text"
                      title={`Next: ${next().title}`}
                    >
                      Next PR →
                    </A>
                  )}
                </Show>
                <SettingsPanel settings={settings()} onChange={setSettings}>
                  <Button
                    fullWidth
                    variant="ghost"
                    size="sm"
                    aria-pressed={!reviewCommentsHidden()}
                    disabled={
                      aiAnnotations().length === 0 &&
                      !githubView()?.comments.some(
                        (comment) => comment.ref.kind === "review-comment",
                      )
                    }
                    onClick={() => setReviewCommentsHidden((hidden) => !hidden)}
                  >
                    Inline comments
                  </Button>
                </SettingsPanel>
                <ApproveButton
                  approvalOperations={ownApprovalOperations()}
                  expectedHeadSha={diffRevision().headSha}
                  canSubmit={loadedPrUrl() === prUrl()}
                  approvalState={
                    ownApprovalOperations().some((item) => item.status !== "synced")
                      ? "pending"
                      : prStatus()?.viewerApproval?.commitSha === diffRevision().headSha &&
                          prStatus()?.viewerApproval?.login === currentGithubActor()?.login &&
                          !!diffRevision().headSha
                        ? "synced"
                        : undefined
                  }
                />
              </div>
            </div>
            {/* PR Comments (top-level conversation) */}
            <div id="pr-conversation" hidden={!conversationOpen()}>
              <PrCommentsPanel
                embedded
                prUrl={loadedPrUrl()}
                githubView={githubView()}
                comments={issueComments()}
                loading={loadingComments()}
                repoOwner={prInfo()?.owner}
                repoName={prInfo()?.repo}
                onAddComment={addIssueComment}
                onEditComment={editIssueComment}
                onDeleteComment={deleteIssueComment}
              />
            </div>
          </Show>
        </AppHeader>
      </Show>

      <Show when={loadedPrUrl()}>
        <nav
          aria-label="Pull request tabs"
          class="flex shrink-0 flex-wrap gap-2 border-b border-border px-4 py-2"
          onPointerDown={rememberReviewFocus}
        >
          <For each={["overview", "changes", "checks"] as const}>
            {(tab) => (
              <Button
                size="sm"
                variant={activeTab() === tab ? "primary" : "ghost"}
                aria-current={activeTab() === tab ? "page" : undefined}
                onClick={() => selectTab(tab)}
              >
                {tab[0].toUpperCase() + tab.slice(1)}
              </Button>
            )}
          </For>
          <Show when={activeTab() !== "checks"}>
            <Button
              size="sm"
              variant="ghost"
              class="ml-auto"
              onClick={() => void refreshDetail().catch(() => {})}
              disabled={refreshingDetail()}
              aria-busy={refreshingDetail()}
            >
              Refresh details
            </Button>
          </Show>
        </nav>
      </Show>

      {/* Focus mode exit bar */}
      <Show when={focusMode() && changesActive()}>
        <div class="flex items-center justify-between px-3 py-1.5 bg-bg-surface border-b border-accent/30">
          <div class="flex items-center gap-2">
            <span class="text-xs text-accent font-medium">Focus mode</span>
            <span class="text-xs text-text-faint">
              Diff takes priority. Press Esc or F to exit.
            </span>
          </div>
          <div class="flex items-center gap-1">
            <ReviewSettings />
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
        </div>
      </Show>

      {/* Main content */}
      <Show when={askSelection()} keyed>
        {(draft) => (
          <AnchoredSelectionEditor
            draft={draft}
            controller={selectionController()}
            scope={selectionScope()}
            sourceDialogOpen={false}
            inactive={!changesActive()}
            isCurrent={() =>
              changesActive() &&
              askSelection() === draft &&
              draft.selection.scope === selectionScope()
            }
            onDismiss={dismissSelection}
          />
        )}
      </Show>
      <Show when={loadedPrUrl() && !changesActive()}>
        <main class="min-h-0 flex-1 overflow-y-auto p-5">
          <div class="mx-auto max-w-5xl space-y-6">
            <Show when={detailError() && activeTab() !== "checks"}>
              <p role="alert">{detailError()}</p>
            </Show>
            <Show when={detailStaleNotice() && !detailError() && activeTab() === "overview"}>
              <p role="status" class="text-sm text-text-muted">
                Showing previous results for unavailable sections: {detailStaleNotice()}
              </p>
            </Show>
            <Show when={activeTab() === "checks" && displayMetadata()}>
              {(metadata) => (
                <header class="space-y-1">
                  <p class="text-xs text-text-muted">
                    {prInfo()?.owner}/{prInfo()?.repo} · #{metadata().number}
                  </p>
                  <h1 class="break-words text-lg font-semibold tracking-tight">
                    {metadata().title}
                  </h1>
                </header>
              )}
            </Show>
            <Show
              when={activeTab() === "overview"}
              fallback={
                <PrChecks
                  checks={detailView()?.checks}
                  refreshing={refreshingDetail()}
                  loadError={detailError() ?? detailStaleNotice()}
                  onRefresh={() => void refreshDetail().catch(() => {})}
                />
              }
            >
              <PrOverview
                detail={detailView()}
                url={loadedPrUrl()!}
                githubView={githubView()}
                operations={outboxOperations()}
                onSource={navigateOverviewSource}
                discussionsState={
                  loadingComments()
                    ? "loading"
                    : commentsUnavailable()
                      ? "unavailable"
                      : "available"
                }
                threadEvidence={reviewThreads()}
              />
              <PrCommentsPanel
                embedded
                prUrl={loadedPrUrl()}
                githubView={githubView()}
                comments={issueComments()}
                loading={loadingComments()}
                unavailable={issueCommentsUnavailable()}
                repoOwner={prInfo()?.owner}
                repoName={prInfo()?.repo}
                onAddComment={addIssueComment}
                onEditComment={editIssueComment}
                onDeleteComment={deleteIssueComment}
              />
              <div class="flex flex-wrap items-start gap-3">
                <ApproveButton
                  expectedHeadSha={detailHead()}
                  canSubmit={!detailError() && detailMetadata()?.state === "OPEN"}
                  approvalOperations={overviewApprovalOperations()}
                  approvalState={overviewApprovalState()}
                />
                <PrReviewActions
                  url={loadedPrUrl()!}
                  headSha={detailHead()}
                  canSubmit={!detailError() && detailMetadata()?.state === "OPEN"}
                />
              </div>
              <Show when={mergeDetail()}>
                {(value) => (
                  <PrMergePanel
                    detail={value()}
                    pendingComments={
                      outboxOperations().filter(
                        (item) => item.status !== "synced" && item.status !== "cancelled",
                      ).length
                    }
                    onChanged={refreshAfterMerge}
                  />
                )}
              </Show>
            </Show>
          </div>
        </main>
      </Show>
      <Show when={changesVisited() ? loadedPrUrl() : null} keyed>
        <div
          ref={(element) => {
            changesRoot = element;
          }}
          class="relative flex min-w-0 flex-1 overflow-hidden"
          style={{ display: changesActive() ? undefined : "none" }}
          inert={!changesActive()}
          aria-hidden={!changesActive()}
        >
          {/* Chat panel (left) - hidden in focus mode */}
          <Show when={diff() !== null}>
            <ChatPanel
              hidden={!changesActive() || !panelVisibility().chat || focusMode()}
              selectionScope={selectionScope()}
              interactions={interactions}
              onSelectionController={setSelectionController}
              prUrl={loadedPrUrl()}
              initialSessionId={
                typeof searchParams.sessionId === "string" ? searchParams.sessionId : undefined
              }
              prNumber={prInfo()?.number ? parseInt(prInfo()!.number, 10) : null}
              repoOwner={prInfo()?.owner ?? null}
              repoName={prInfo()?.repo ?? null}
              files={fileNames()}
              reviewMode={reviewMode()}
              displayedHeadSha={diffRevision().headSha ?? null}
              commitSha={
                reviewMode() === "commit" ? (commits()[currentCommitIndex()]?.sha ?? null) : null
              }
              theme={settings().theme}
              aiAnnotations={aiAnnotations()}
              onApplyReviewOrder={applyReviewOrder}
              onReviewOrderObservation={automaticOrderController.observe}
              initialReviewOrderReady={!automaticOrder() || (!loading() && !loadingCommits())}
              onAnnotationsReceived={addNewAiAnnotations}
            />
          </Show>

          {/* Center content */}
          <Show
            when={diff() && !initialOrderPending()}
            fallback={
              <div class="flex-1 flex items-center justify-center">
                <Show
                  when={loading() || initialOrderPending()}
                  fallback={
                    <div class="w-full max-w-md px-6 text-center">
                      <h2 class="text-lg font-semibold tracking-tight text-text">
                        Open a pull request
                      </h2>
                      <p class="mt-2 text-sm leading-relaxed text-text-muted">
                        Paste a GitHub PR URL above to start reviewing.
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
              <div
                ref={(element) => {
                  diffScrollRef = element;
                }}
                class={`flex-1 overflow-y-auto pb-3 ${focusMode() ? "px-1" : "px-2"}`}
              >
                <Show when={discussionSourceNotice()}>
                  <p role="alert" class="mb-3 border border-warning/40 p-3 text-sm">
                    {discussionSourceNotice()}
                  </p>
                </Show>
                <Show when={sourceTarget()} keyed>
                  {(target) => (
                    <InlineSourceView
                      target={target}
                      navigation={interactions.source}
                      onClose={interactions.source.close}
                      onChoose={(target) => void interactions.openSource(target)}
                      onResolved={focusResolvedSource}
                      onAskAi={askAboutSource}
                      askEditorOpen={!!askSelection()}
                    />
                  )}
                </Show>
                <Show
                  when={activeDiff()}
                  fallback={
                    <Show when={reviewMode() === "commit" && loadingCommits()}>
                      <div class="text-text-faint text-base">Loading commit diff...</div>
                    </Show>
                  }
                >
                  <Show when={diffViewMode() === "reading" && !currentReadingDiff()}>
                    <ReadingDiffEmpty
                      loading={readingDiffLoading()}
                      error={readingDiffError()}
                      scopeLabel={readingDiffScopeLabel()}
                      onGenerate={() => generateReadingDiff(false)}
                    />
                  </Show>
                  <Show when={diffViewMode() === "reading" && currentReadingDiff()}>
                    <ReadingDiffSummary
                      result={currentReadingDiff()!}
                      regenerating={readingDiffLoading()}
                      error={readingDiffError()}
                      onRegenerate={() => generateReadingDiff(true)}
                      onNavigateEvidence={scrollToFile}
                    />
                  </Show>
                  <Show when={findingNotice()}>
                    <div
                      data-finding-comment-notice
                      role="alert"
                      class="mb-3 rounded border border-warning/40 bg-bg-elevated p-3 text-sm"
                    >
                      {findingNotice()}{" "}
                      <Button type="button" size="xs" onClick={interactions.dismissNotice}>
                        Dismiss
                      </Button>
                    </div>
                  </Show>
                  <Show when={inlineFinding()} keyed>
                    {(entry) => (
                      <InlineFindingComment
                        entry={entry}
                        isCurrent={() => interactions.currentComment(entry.request)}
                        onCancel={() => interactions.finishComment(entry)}
                        onSubmit={async (body, draftKey) => {
                          interactions.assertCurrentComment(entry.request);
                          await addComment({
                            filePath: entry.request.filePath,
                            line: entry.request.line,
                            side: "RIGHT",
                            body,
                            expectedHeadSha: entry.request.expectedHeadSha,
                            draftKey,
                          });
                          interactions.finishComment(entry);
                        }}
                      />
                    )}
                  </Show>
                  <Show when={!reviewCommentsHidden() && unplacedGithubComments().length}>
                    <section
                      aria-label="Review comments outside displayed patch"
                      class="mb-3 space-y-2"
                    >
                      <h3 class="text-sm text-text-muted">
                        Review comments outside the displayed patch
                      </h3>
                      <For each={unplacedGithubComments().map((comment) => comment.key)}>
                        {(key) => (
                          <GithubCommentCard
                            comment={unplacedGithubComments().find(
                              (comment) => comment.key === key,
                            )!}
                            scope={githubPrScope(loadedPrUrl()!)}
                            operations={outboxOperations()}
                            thread={githubThreadForComment(
                              unplacedGithubComments().find((comment) => comment.key === key)!,
                              githubView()?.threads ?? [],
                              outboxOperations(),
                            )}
                          />
                        )}
                      </For>
                    </section>
                  </Show>
                  <DiffViewer
                    findingComment={findingComment()}
                    commentHeadSha={diffRevision().headSha}
                    githubOperations={outboxOperations()}
                    githubComments={
                      reviewCommentsHidden() || diffViewMode() === "reading"
                        ? []
                        : githubView()?.comments
                    }
                    githubThreads={githubView()?.threads}
                    askEditorOpen={!!askSelection()}
                    commitScope={reviewMode() === "commit"}
                    onAskAi={askAboutSource}
                    selectionScope={selectionScope()}
                    selectionClearToken={selectionClearToken()}
                    rawDiff={activeDiff()!}
                    parsedFiles={files()}
                    comments={reviewCommentsHidden() ? [] : comments()}
                    aiAnnotations={reviewCommentsHidden() ? [] : aiAnnotations()}
                    onCreateFindingComment={(annotation) =>
                      interactions.prepareComment(
                        annotation,
                        annotation.origin?.sessionId ?? "",
                        annotation.origin?.revision,
                      )
                    }
                    loadingComments={!reviewCommentsHidden() && loadingComments()}
                    onAddComment={addComment}
                    onReplyToComment={replyToComment}
                    onEditComment={editComment}
                    onDeleteComment={deleteComment}
                    onResolveThread={resolveThread}
                    onDismissAiAnnotation={dismissAiAnnotation}
                    settings={settings()}
                    repoOwner={prInfo()?.owner}
                    repoName={prInfo()?.repo}
                    fileOrder={reviewOrder()}
                    highlightedLine={highlightedLine()}
                    readFiles={readFiles()}
                    onToggleRead={toggleFileRead}
                    prUrl={loadedPrUrl()}
                    scrollContainer={diffScrollRef}
                    onSearchNavigate={scrollToFile}
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
      </Show>
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
