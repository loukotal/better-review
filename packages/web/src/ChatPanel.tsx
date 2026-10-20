import { marked, type Tokens } from "marked";
import remend from "remend";
import {
  createSignal,
  createEffect,
  For,
  Show,
  Switch,
  Match,
  createMemo,
  onMount,
  onCleanup,
  batch,
  on,
  untrack,
} from "solid-js";

import { type StoredSession } from "@better-review/shared";

import { AnnotationBlock } from "./components/AnnotationBlock";
import { FileLink } from "./components/FileLink";
import { ModelSelector } from "./components/ModelSelector";
import { ReviewActions } from "./components/ReviewActions";
import { ReviewOrderPanel } from "./components/ReviewOrderPanel";
import { ReviewSessionToolbar } from "./components/ReviewSessionToolbar";
import { SelectionQuestionMessage } from "./components/SelectionQuestionMessage";
import { Button, Checkbox, IconButton, PanelHeader, Textarea, MessageForm } from "./design-system";
import type { DiffTheme } from "./diff/types";
import { useStreamingChat, type ToolCall } from "./hooks/useStreamingChat";
import { SpinnerIcon } from "./icons/spinner-icon";
import { type SourceSelection, type SelectionChatController } from "./lib/ask-ai-selection";
import {
  availableReviewOrder,
  type AvailableReviewOrder,
  type InitialReviewOrder,
  type SavedReviewOrderScope,
} from "./lib/automatic-review-order";
import { parseChatFileReference } from "./lib/chat-file-reference";
import {
  groupTranscript,
  reviewRequestLabel,
  currentActivity,
  thinkingTail,
} from "./lib/chat-transcript";
import {
  applySafeMarkdownRenderer,
  escapeHtmlText,
  normalizeMalformedInlineCode,
  renderMermaidCodeBlock,
  renderSemanticTextCodeBlock,
} from "./lib/markdown";
import { createReviewClient } from "./lib/review-client";
import { createQuestionDelivery, type ReviewInteractions } from "./lib/review-interactions";
import {
  ADVERSARIAL_REVIEW_PROMPT,
  buildReviewPrompt,
  STRUCTURED_REVIEW_PROMPT,
} from "./lib/review-prompts";
import type { SelectionSourceContext } from "./lib/selection-question-message";
import { highlightCode, clearHighlightCache } from "./lib/shiki";
import { trpc } from "./lib/trpc";
import { parseReviewTokens, type Annotation, type MessageSegment } from "./utils/parseReviewTokens";

// Configure marked for safe, minimal output
marked.setOptions({
  gfm: true,
  breaks: true,
});

interface ChatPanelProps {
  hidden?: boolean;
  selectionScope?: string;
  interactions?: ReviewInteractions;
  onSelectionController?: (controller: SelectionChatController | null) => void;
  prUrl: string | null;
  initialSessionId?: string;
  prNumber: number | null;
  repoOwner: string | null;
  repoName: string | null;
  files: string[];
  theme: DiffTheme;
  aiAnnotations?: Annotation[];
  onScrollToFile?: (
    file: string,
    line?: number,
    sessionId?: string,
    sameRevision?: boolean,
    ref?: string,
  ) => void;
  onApplyReviewOrder?: (files: string[]) => void;
  onAvailableReviewOrder?: (order: AvailableReviewOrder | null) => void;
  onInitialReviewOrder?: (result: InitialReviewOrder) => void;
  /** Wait for App to verify the displayed PR revision, including cached opens. */
  initialReviewOrderReady?: boolean;
  onAnnotationsReceived?: (annotations: Annotation[]) => void;
  onCreateFindingComment?: (annotation: Annotation, sessionId: string, ref?: string | null) => void;
  onSelectionSourceNavigate?: (selection: SelectionSourceContext, sessionId: string) => void;
  reviewMode?: "full" | "commit";
  commitSha?: string | null;
  /** Revision of the diff actually displayed by App, independent of the saved conversation. */
  displayedHeadSha?: string | null;
}

const CHAT_WIDTH_KEY = "chat-panel-width";
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 600;
const STE100_STORAGE_KEY = "better-review:use-ste100";

function loadSavedWidth(): number {
  try {
    const saved = localStorage.getItem(CHAT_WIDTH_KEY);
    if (saved) {
      const width = parseInt(saved, 10);
      if (width >= MIN_WIDTH && width <= MAX_WIDTH) {
        return width;
      }
    }
  } catch {
    // Ignore
  }
  return DEFAULT_WIDTH;
}

function loadSte100Preference(): boolean {
  try {
    return localStorage.getItem(STE100_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function ChatPanel(props: ChatPanelProps) {
  const [input, setInput] = createSignal("");
  const [linkNotice, setLinkNotice] = createSignal<string | null>(null);
  const [sendingSelection, setSendingSelection] = createSignal(false);
  const selectionDelivery = createQuestionDelivery(() => ({
    scope: props.selectionScope ?? "",
    ready: !!props.prUrl && !disposed,
  }));
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const [assistantSettingsOpen, setAssistantSettingsOpen] = createSignal(false);
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [savedOrderScope, setSavedOrderScope] = createSignal<SavedReviewOrderScope | null>(null);
  const hydrateOrderScope = (data: {
    session: { id: string };
    sessionScope?: {
      mode: "full" | "commit";
      commitSha: string | null;
      afterSubmissionId?: string | null;
    };
  }) => {
    setSavedOrderScope(
      data.sessionScope ? { sessionId: data.session.id, ...data.sessionScope } : null,
    );
  };
  const [sessionError, setSessionError] = createSignal<string | null>(null);
  const [initializing, setInitializing] = createSignal(false);
  const [scopeSessionKey, setScopeSessionKey] = createSignal<string | null>(null);
  const [switchingCommitSession, setSwitchingCommitSession] = createSignal(false);
  const [creatingNewSession, setCreatingNewSession] = createSignal(false);
  const [pullingLatest, setPullingLatest] = createSignal(false);
  const [pullNotice, setPullNotice] = createSignal<string | null>(null);
  const [useSte100, setUseSte100] = createSignal(loadSte100Preference());

  // Session management state
  const [sessions, setSessions] = createSignal<StoredSession[]>([]);
  const [currentHeadSha, setCurrentHeadSha] = createSignal<string | null>(null);
  const [navigationRevision, setNavigationRevision] = createSignal<string | null>(null);

  // Resize state
  const [width, setWidth] = createSignal(loadSavedWidth());
  const [isResizing, setIsResizing] = createSignal(false);

  // Use the streaming chat hook
  const chat = useStreamingChat({
    getSessionId: () => sessionId(),
    onError: (err) => console.error("[ChatPanel] Stream error:", err),
  });

  const reviewActionsDisabled = () =>
    sendingSelection() ||
    initializing() ||
    creatingNewSession() ||
    pullingLatest() ||
    chat.compacting() ||
    chat.isStreaming();
  createEffect(on(sessionId, () => setPullNotice(null)));

  let _messagesContainer: HTMLDivElement | undefined;

  // Auto-scroll to bottom when messages or streaming content changes
  createEffect(() => {
    // Track all relevant signals that should trigger scroll
    chat.messages();
    chat.streamingContent();
    chat.streamingReasoning();
    chat.isStreaming();
    chat.activeTools();

    // Defer scroll to next frame to ensure DOM has updated
    requestAnimationFrame(() => {
      if (_messagesContainer) {
        _messagesContainer.scrollTop = _messagesContainer.scrollHeight;
      }
    });
  });

  // Extract and notify annotations when messages change
  createEffect(
    on(
      () =>
        [
          sessionId(),
          props.reviewMode,
          props.commitSha,
          props.displayedHeadSha,
          chat.messages(),
        ] as const,
      () => {
        if (!props.onAnnotationsReceived) return;

        // Extract annotations from all assistant messages
        const allAnnotations: Annotation[] = [];
        for (const msg of chat.messages()) {
          if (
            msg.role === "user" &&
            msg.content.startsWith("Pulled the latest full PR into this review session.")
          ) {
            allAnnotations.length = 0;
          }
          if (
            msg.role === "assistant" &&
            !!msg.revision &&
            msg.revision ===
              (props.reviewMode === "commit" ? props.commitSha : props.displayedHeadSha)
          ) {
            const parsed = parseReviewTokens(msg.content);
            const sid = sessionId();
            if (sid)
              allAnnotations.push(
                ...parsed.annotations.map((annotation) => ({
                  ...annotation,
                  origin: { sessionId: sid, revision: msg.revision },
                })),
              );
          }
        }

        props.onAnnotationsReceived(allAnnotations);
      },
      { defer: false },
    ),
  );

  // Clear highlight cache when theme changes
  createEffect(
    on(
      () => props.theme,
      () => {
        clearHighlightCache();
      },
      { defer: true },
    ),
  );

  let sessionInitializationVersion = 0;

  // Parent props are recreated when cached PR data is refreshed; compare the values so an
  // unchanged PR does not initialize its session again.
  const sessionTarget = createMemo(() =>
    props.initialReviewOrderReady !== false &&
    props.prUrl &&
    props.prNumber &&
    props.repoOwner &&
    props.repoName
      ? [
          props.prUrl,
          props.prNumber,
          props.repoOwner,
          props.repoName,
          props.initialSessionId ?? "",
          props.reviewMode ?? "full",
          props.commitSha ?? "",
        ].join("\n")
      : null,
  );
  const [resolvedSessionTarget, setResolvedSessionTarget] = createSignal<string | null>(null);

  createEffect(() => {
    const revision = props.reviewMode === "commit" ? props.commitSha : props.displayedHeadSha;
    const sid = sessionId();
    const order =
      !initializing() &&
      !pullingLatest() &&
      resolvedSessionTarget() === sessionTarget() &&
      !creatingNewSession() &&
      !switchingCommitSession() &&
      props.prUrl &&
      sid &&
      revision
        ? availableReviewOrder(
            chat.snapshot(),
            {
              prUrl: props.prUrl,
              sessionId: sid,
              revision,
              mode: props.reviewMode ?? "full",
            },
            savedOrderScope(),
          )
        : null;
    const snapshotLoaded = !!sid && chat.snapshot()?.sessionId === sid;
    if (
      !initializing() &&
      props.initialReviewOrderReady !== false &&
      props.prUrl &&
      (sessionError() ||
        (resolvedSessionTarget() === sessionTarget() && (snapshotLoaded || chat.error())))
    ) {
      // Publish initial hydration before the live-order callback can reorder mounted files.
      const result: InitialReviewOrder = {
        prUrl: props.prUrl,
        mode: props.reviewMode ?? "full",
        revision: revision ?? null,
        order,
        snapshotLoaded,
      };
      untrack(() => props.onInitialReviewOrder?.(result));
    }
    props.onAvailableReviewOrder?.(order);
  });

  // Initialize session when PR changes
  createEffect(
    on(sessionTarget, (target) => {
      if (target) {
        initSession();
        return;
      }

      sessionInitializationVersion++;
      setPullingLatest(false);
      setSessionId(null);
      setSessions([]);
      setCurrentHeadSha(null);
      chat.clearMessages();
      setSessionError(null);
      setScopeSessionKey(null);
    }),
  );

  createEffect(() => {
    const prUrl = props.prUrl;
    const mode = props.reviewMode ?? "full";
    const commitSha = props.commitSha ?? null;
    const sid = sessionId();

    if (!prUrl || !sid || mode !== "commit" || !commitSha) return;
    if (initializing() || switchingCommitSession() || chat.isStreaming()) return;

    const wantedKey = `commit:${commitSha}`;
    if (scopeSessionKey() === wantedKey) return;

    setSwitchingCommitSession(true);
    void handleNewSession()
      .then((created) => {
        if (created) setScopeSessionKey(wantedKey);
      })
      .finally(() => {
        setSwitchingCommitSession(false);
      });
  });

  async function initSession() {
    if (!props.prUrl || !props.prNumber || !props.repoOwner || !props.repoName) {
      return;
    }

    const requestVersion = ++sessionInitializationVersion;
    const requestPrUrl = props.prUrl;
    const requestTarget = sessionTarget();
    setPullingLatest(false);
    setResolvedSessionTarget(null);
    setInitializing(true);
    setSessionError(null);

    try {
      // Explicit review links must select the saved revision, never create a new session.
      const requestedSessionId = props.initialSessionId;
      if (requestedSessionId) {
        setSessionId(null);
        setSessions([]);
        setCurrentHeadSha(null);
        chat.clearMessages();
      }
      const data = requestedSessionId
        ? await trpc.prReview.selectSession.mutate({
            prUrl: requestPrUrl,
            sessionId: requestedSessionId,
          })
        : await trpc.prReview.getOrCreateSession.mutate({
            prUrl: props.prUrl,
            prNumber: props.prNumber,
            repoOwner: props.repoOwner,
            repoName: props.repoName,
            files: props.files,
            reviewMode: props.reviewMode,
            commitSha: props.reviewMode === "commit" ? (props.commitSha ?? undefined) : undefined,
          });

      if (requestVersion !== sessionInitializationVersion || props.prUrl !== requestPrUrl) return;
      if (!data.session?.id) {
        setSessionError("Invalid response: no session ID");
        return;
      }

      setSessionId(data.session.id);
      hydrateOrderScope(data);
      setNavigationRevision(
        requestedSessionId
          ? null
          : props.reviewMode === "commit"
            ? (props.commitSha ?? null)
            : data.sessionHeadSha,
      );
      setScopeSessionKey(
        props.reviewMode === "commit" && props.commitSha ? `commit:${props.commitSha}` : "full",
      );

      // Update sessions list and current head SHA
      if (data.sessions) {
        setSessions(data.sessions.filter((s: StoredSession) => !s.hidden));
      }
      if (data.headSha && !requestedSessionId) {
        setCurrentHeadSha(data.headSha);
      }
      setResolvedSessionTarget(requestTarget);
    } catch (err) {
      if (requestVersion === sessionInitializationVersion)
        setSessionError(err instanceof Error ? err.message : "Failed to initialize chat session");
    } finally {
      if (requestVersion === sessionInitializationVersion) setInitializing(false);
    }
  }

  async function submitMessage(message: string) {
    const trimmedMessage = message.trim();
    if (!trimmedMessage || reviewActionsDisabled() || !sessionId()) return;

    setPullNotice(null);
    setInput("");
    await chat.sendMessage(trimmedMessage, {
      reviewMode: props.reviewMode,
      commitSha: props.reviewMode === "commit" ? (props.commitSha ?? undefined) : undefined,
    });
  }

  async function sendSelection(
    selection: SourceSelection,
    body: string,
    target: string,
    selectionIsCurrent: () => boolean,
  ): Promise<boolean> {
    const prUrl = props.prUrl;
    if (
      !selection ||
      !prUrl ||
      sendingSelection() ||
      initializing() ||
      creatingNewSession() ||
      pullingLatest()
    )
      return false;
    const isCurrent = () =>
      !disposed &&
      props.prUrl === prUrl &&
      props.selectionScope === selection.scope &&
      selectionIsCurrent();
    const createInput = {
      prUrl,
      prNumber: props.prNumber!,
      repoOwner: props.repoOwner!,
      repoName: props.repoName!,
      files: [...props.files],
      reviewMode: props.reviewMode,
      commitSha: props.reviewMode === "commit" ? (props.commitSha ?? undefined) : undefined,
    };
    setSendingSelection(true);
    try {
      const delivery = props.interactions ?? selectionDelivery;
      const id = await delivery.askAbout(selection, body, {
        target,
        isCurrent,
        client: createReviewClient,
        createSession: async () => {
          const result = await trpc.prReview.create.mutate(createInput);
          if (!result.session?.id) throw new Error("No conversation was created.");
          if (isCurrent() && result.sessions)
            setSessions(result.sessions.filter((s: StoredSession) => !s.hidden));
          return result.session.id;
        },
      });
      if (!id) return false;
      if (isCurrent()) {
        // Receipt means the durable API accepted the prompt; do not wait for LLM completion.
        setSessionId(id);
        setSavedOrderScope(null);
        setNavigationRevision(null);
        void trpc.prReview.switch
          .mutate({ prUrl, sessionId: id })
          .then((data) => {
            if (isCurrent() && sessionId() === id) hydrateOrderScope(data);
          })
          .catch((cause) => console.error("Could not persist selected conversation", cause));
      }
      return true;
    } finally {
      setSendingSelection(false);
    }
  }

  onMount(() =>
    props.onSelectionController?.({
      currentSessionId: sessionId,
      currentBusy: () => chat.isStreaming() || chat.compacting(),
      disabled: () =>
        initializing() || creatingNewSession() || pullingLatest() || sendingSelection(),
      sessions,
      send: sendSelection,
    }),
  );
  onCleanup(() => props.onSelectionController?.(null));

  async function sendMessage(e: Event) {
    e.preventDefault();
    await submitMessage(input());
  }

  function startReview() {
    void submitMessage(buildReviewPrompt(STRUCTURED_REVIEW_PROMPT, useSte100()));
  }

  async function startAdversarialReview() {
    await submitMessage(buildReviewPrompt(ADVERSARIAL_REVIEW_PROMPT, useSte100()));
  }

  function toggleSte100() {
    const enabled = !useSte100();
    setUseSte100(enabled);
    try {
      localStorage.setItem(STE100_STORAGE_KEY, String(enabled));
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  }

  function handleAbort() {
    chat.abort();
  }

  // Session management handlers
  async function handlePullLatest() {
    const sid = sessionId();
    const prUrl = props.prUrl;
    if (!sid || !prUrl || reviewActionsDisabled()) return;
    const version = sessionInitializationVersion;
    const target = sessionTarget();
    setPullingLatest(true);
    setPullNotice(null);
    try {
      const result = await trpc.prReview.pullLatest.mutate({ sessionId: sid, prUrl });
      if (
        version !== sessionInitializationVersion ||
        target !== sessionTarget() ||
        sessionId() !== sid ||
        props.prUrl !== prUrl ||
        result.session.id !== sid
      )
        return;
      hydrateOrderScope(result);
      if (!result.changed) {
        setPullNotice(
          `Up to date at ${result.headSha.slice(0, 7)}. Run Review or Adversarial again to recheck this revision.`,
        );
        return;
      }
      setSessions((items) =>
        items.map((item) => (item.id === sid ? { ...item, headSha: result.headSha } : item)),
      );
      // The page diff and older transcript annotations can still reference the old revision.
      setNavigationRevision(null);
      setPullNotice(
        `Updated to ${result.headSha.slice(0, 7)}. Continuing the review in this conversation.`,
      );
    } catch (error) {
      if (
        version === sessionInitializationVersion &&
        target === sessionTarget() &&
        sessionId() === sid &&
        props.prUrl === prUrl
      )
        setPullNotice(error instanceof Error ? error.message : "Could not pull latest changes");
    } finally {
      if (version === sessionInitializationVersion && target === sessionTarget())
        setPullingLatest(false);
    }
  }

  async function handleSessionSwitch(newSessionId: string) {
    if (!props.prUrl || newSessionId === sessionId()) return;
    if (sendingSelection() || creatingNewSession() || pullingLatest()) return;
    const version = sessionInitializationVersion;
    const prUrl = props.prUrl;

    try {
      const data = await trpc.prReview.switch.mutate({
        prUrl: props.prUrl,
        sessionId: newSessionId,
      });
      if (version !== sessionInitializationVersion || props.prUrl !== prUrl) return;

      setSessionId(newSessionId);
      hydrateOrderScope(data);
      // Session list heads do not identify a saved commit-review scope.
      setNavigationRevision(null);
    } catch (err) {
      console.error("Failed to switch session:", err);
    }
  }

  async function handleNewSession(): Promise<boolean> {
    if (!props.prUrl || !props.prNumber || !props.repoOwner || !props.repoName) return false;
    if (sendingSelection() || creatingNewSession() || pullingLatest()) return false;
    const version = sessionInitializationVersion;
    const prUrl = props.prUrl;

    setCreatingNewSession(true);
    try {
      const data = await trpc.prReview.create.mutate({
        prUrl: props.prUrl,
        prNumber: props.prNumber,
        repoOwner: props.repoOwner,
        repoName: props.repoName,
        files: props.files,
        reviewMode: props.reviewMode,
        commitSha: props.reviewMode === "commit" ? (props.commitSha ?? undefined) : undefined,
      });

      if (!data.session?.id || version !== sessionInitializationVersion || props.prUrl !== prUrl)
        return false;

      batch(() => {
        setSessionId(data.session.id);
        hydrateOrderScope(data);
        setNavigationRevision(
          props.reviewMode === "commit" ? (props.commitSha ?? null) : data.sessionHeadSha,
        );
        chat.loadExistingMessages([]); // New session has no messages
        setScopeSessionKey(
          props.reviewMode === "commit" && props.commitSha ? `commit:${props.commitSha}` : "full",
        );
      });
      if (data.sessions) {
        setSessions(data.sessions.filter((s: StoredSession) => !s.hidden));
      }
      return true;
    } catch (err) {
      console.error("Failed to create new session:", err);
      return false;
    } finally {
      setCreatingNewSession(false);
    }
  }

  async function handleHideSession(hiddenSessionId: string) {
    if (!props.prUrl) return;
    if (sendingSelection() || creatingNewSession() || pullingLatest()) return;

    try {
      const data = await trpc.prReview.hide.mutate({
        prUrl: props.prUrl,
        sessionId: hiddenSessionId,
      });

      // Update sessions list
      if (data.sessions) {
        setSessions(data.sessions);
      }

      // If we hid the active session, switch to another one
      if (hiddenSessionId === sessionId()) {
        const remaining = data.sessions || [];
        if (remaining.length > 0) {
          // Switch to the most recent session
          const mostRecent = remaining.reduce((a: StoredSession, b: StoredSession) =>
            a.createdAt > b.createdAt ? a : b,
          );
          await handleSessionSwitch(mostRecent.id);
        } else {
          // No sessions left, create a new one
          // Note: UI prevents hiding last session, but handle edge case anyway
          try {
            await handleNewSession();
          } catch (newSessionErr) {
            console.error("Failed to create new session after hiding:", newSessionErr);
            // Clear state so UI shows proper "no session" state
            batch(() => {
              setSessionId(null);
              chat.clearMessages();
            });
          }
        }
      }
    } catch (err) {
      console.error("Failed to hide session:", err);
    }
  }

  // Handle file reference clicks
  const handleFileClick = (file: string, line?: number, ref?: string) => {
    const sid = sessionId();
    const reviewedHead = ref ?? navigationRevision();
    const activeHead = props.reviewMode === "commit" ? props.commitSha : props.displayedHeadSha;
    if (!sid) {
      setLinkNotice(
        "Wait for the review conversation to finish loading, then open the code link again.",
      );
      return;
    }
    setLinkNotice(null);
    if (props.interactions) {
      void props.interactions.openSource(
        {
          sessionId: sid,
          path: file,
          line,
          ref: reviewedHead ?? undefined,
          side: "RIGHT",
        },
        true,
      );
    } else {
      props.onScrollToFile?.(file, line, sid, !!reviewedHead && reviewedHead === activeHead, ref);
    }
  };

  // Handle apply review order
  const navigateSelectionSource = (selection: SelectionSourceContext) => {
    const sid = sessionId();
    if (!sid) {
      setLinkNotice(
        "Wait for the review conversation to finish loading, then open the selected source again.",
      );
      return;
    }
    if (props.interactions) {
      void props.interactions.openSource(
        {
          sessionId: sid,
          path: selection.file,
          line: selection.startLine,
          ref: selection.revision,
          side: selection.side,
          captured: {
            text: selection.text,
            startLine: selection.startLine,
            endLine: selection.endLine,
          },
        },
        true,
      );
    } else props.onSelectionSourceNavigate?.(selection, sid);
  };

  const handleApplyOrder = (files: string[]) => {
    props.onApplyReviewOrder?.(files);
  };

  // Copy all AI feedback to clipboard (full assistant messages, skipping dismissed annotations)
  const [feedbackCopied, setFeedbackCopied] = createSignal(false);

  /**
   * Build a clean text version of all assistant messages.
   * - Strips <<REVIEW_ORDER>> blocks entirely
   * - Converts <<ANNOTATION>> blocks to readable "[SEVERITY] file:line - message"
   * - Converts [[file:path:line]] refs to "path:line"
   * - Removes annotation blocks whose IDs are not in the active (non-dismissed) set
   */
  function buildFeedbackText(
    messages: Array<{ role: string; content: string }>,
    activeAnnotationIds: Set<string>,
  ): string {
    const parts: string[] = [];

    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.content.trim()) continue;

      let text = msg.content;

      // Strip review order blocks, including payloads wrapped in fenced json
      text = text.replace(/<<REVIEW_ORDER>>[\s\S]*?<<\/REVIEW_ORDER>>/g, "");

      // Replace annotation blocks - keep non-dismissed, remove dismissed
      text = text.replace(
        /<<ANNOTATION\s+file="([^"]+)"\s+line="([^"]+)"\s+severity="(info|note|warning|critical|error)">>([^]*?)<<\/ANNOTATION>>/g,
        (_match, file, lineStr, severity, message) => {
          const lineMatch = lineStr.match(/^(\d+)/);
          const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;
          const trimmedMessage = message.trim();

          // Compute the same hash-based ID used elsewhere
          const normalizedSeverity = severity === "note" ? "info" : severity;
          const content = `${file}:${line}:${normalizedSeverity}:${trimmedMessage}`;
          let hash = 0;
          for (let i = 0; i < content.length; i++) {
            hash = (hash << 5) - hash + content.charCodeAt(i);
            hash = hash & hash;
          }
          const id = `annotation-${Math.abs(hash).toString(36)}`;

          if (!activeAnnotationIds.has(id)) {
            return ""; // Dismissed - skip
          }

          const label = severity.toUpperCase();
          return `[${label}] ${file}:${line} - ${trimmedMessage}`;
        },
      );

      // Replace file references with plain text
      text = text.replace(
        /\*{0,2}\[\[file:([^\]:\s]+)(?::(\d+))?\]\]\*{0,2}/g,
        (_match, file, line) => (line ? `${file}:${line}` : file),
      );

      // Clean up excessive blank lines left by removals
      text = text.replace(/\n{3,}/g, "\n\n").trim();

      if (text) {
        parts.push(text);
      }
    }

    return parts.join("\n\n---\n\n");
  }

  async function handleCopyFeedback() {
    const messages = chat.messages();
    const activeIds = new Set((props.aiAnnotations || []).map((a) => a.id));

    const text = buildFeedbackText(messages, activeIds);
    if (!text) return;

    await navigator.clipboard.writeText(text);
    setFeedbackCopied(true);
    setTimeout(() => setFeedbackCopied(false), 2000);
  }

  // Render markdown text with Shiki syntax highlighting for code blocks
  function MarkdownText(mdProps: { content: string; streaming?: boolean; revision?: string }) {
    const [html, setHtml] = createSignal<string>("");

    // Track code blocks that need highlighting
    const codeBlocks: Array<{ id: string; code: string; lang: string }> = [];
    let blockCounter = 0;

    // Custom renderer that creates placeholders for code blocks
    const renderer = applySafeMarkdownRenderer(new marked.Renderer());
    const originalLink = renderer.link.bind(renderer);
    const originalCodespan = renderer.codespan.bind(renderer);
    const sourceButton = (file: string, line: number | undefined, label: string) => {
      const display = parseChatFileReference(label, props.files)
        ? label.trim().split(/[\\/]/).pop() || label
        : label;
      const title = `${file}${line ? `:${line}` : ""}`;
      return `<button type="button" data-chat-file="${escapeHtmlText(file).replace(/"/g, "&quot;")}"${line ? ` data-chat-line="${line}"` : ""} class="inline-block max-w-full truncate align-bottom rounded px-1 text-left font-mono text-[0.9em] text-text-muted underline decoration-border underline-offset-2 hover:text-accent hover:decoration-accent focus-visible:outline focus-visible:outline-accent" title="${escapeHtmlText(title).replace(/"/g, "&quot;")}">${escapeHtmlText(display)}</button>`;
    };
    renderer.link = (token: Tokens.Link) => {
      const reference = parseChatFileReference(token.href, props.files);
      return reference
        ? sourceButton(reference.file, reference.line, token.text)
        : originalLink(token);
    };
    renderer.codespan = (token: Tokens.Codespan) => {
      const reference = parseChatFileReference(token.text, props.files, true);
      return reference
        ? sourceButton(reference.file, reference.line, token.text)
        : originalCodespan(token);
    };
    renderer.code = (token: Tokens.Code) => {
      const language = (token.lang ?? "").trim().toLowerCase().split(/\s+/, 1)[0];
      if (language === "mermaid" && !mdProps.streaming) {
        const diagram = renderMermaidCodeBlock(token.text);
        if (diagram) return diagram;
      }

      const semanticText = renderSemanticTextCodeBlock(token.text, token.lang);
      if (semanticText) return semanticText;

      const id = `code-block-${blockCounter++}`;
      const lang = token.lang || "text";
      codeBlocks.push({ id, code: token.text, lang });
      // Return a placeholder div that will be replaced with highlighted code
      return `<div data-code-block-id="${id}" class="shiki-placeholder"><pre><code>${escapeHtml(token.text)}</code></pre></div>`;
    };

    // Parse markdown and trigger async highlighting
    createEffect(() => {
      const content = mdProps.content;
      const streaming = mdProps.streaming;

      // Reset for new content
      codeBlocks.length = 0;
      blockCounter = 0;

      try {
        // Use remend to complete incomplete markdown during streaming
        const preprocessed = normalizeMalformedInlineCode(streaming ? remend(content) : content);
        const parsedHtml = marked.parse(preprocessed, {
          async: false,
          renderer,
        }) as string;
        setHtml(parsedHtml);

        // If not streaming and there are code blocks, highlight them
        if (!streaming && codeBlocks.length > 0) {
          void highlightCodeBlocks(parsedHtml, [...codeBlocks]);
        }
      } catch {
        setHtml(escapeHtmlText(content));
      }
    });

    // Highlight code blocks asynchronously and update HTML
    async function highlightCodeBlocks(
      baseHtml: string,
      blocks: Array<{ id: string; code: string; lang: string }>,
    ) {
      let updatedHtml = baseHtml;

      for (const block of blocks) {
        try {
          const highlighted = await highlightCode(block.code, block.lang, props.theme);
          // Replace the placeholder with highlighted code
          const placeholder = `<div data-code-block-id="${block.id}" class="shiki-placeholder"><pre><code>${escapeHtml(block.code)}</code></pre></div>`;
          updatedHtml = updatedHtml.replace(placeholder, highlighted);
        } catch {
          // Keep the placeholder if highlighting fails
        }
      }

      setHtml(updatedHtml);
    }

    return (
      <div
        class="typeset"
        innerHTML={html()}
        onClick={(event) => {
          const button = (event.target as Element).closest<HTMLElement>("[data-chat-file]");
          if (!button || !event.currentTarget.contains(button)) return;
          event.preventDefault();
          event.stopPropagation();
          handleFileClick(
            button.dataset.chatFile!,
            button.dataset.chatLine ? Number(button.dataset.chatLine) : undefined,
            mdProps.revision,
          );
        }}
      />
    );
  }

  // Helper to escape HTML for placeholders
  const escapeHtml = escapeHtmlText;

  function sanitizeStreamingReviewTokens(content: string) {
    let sanitized = content;

    for (const tokenName of ["ANNOTATION", "REVIEW_ORDER"]) {
      const closeToken = `<</${tokenName}>>`;
      const openToken = `<<${tokenName}`;
      const firstCloseIndex = sanitized.indexOf(closeToken);
      const firstOpenIndex = sanitized.indexOf(openToken);

      if (firstCloseIndex !== -1 && (firstOpenIndex === -1 || firstCloseIndex < firstOpenIndex)) {
        sanitized = sanitized.slice(firstCloseIndex + closeToken.length);
      }

      const trailingOpenIndex = sanitized.lastIndexOf(openToken);
      if (trailingOpenIndex !== -1) {
        const trailingCloseIndex = sanitized.indexOf(closeToken, trailingOpenIndex);
        if (trailingCloseIndex === -1) {
          sanitized = sanitized.slice(0, trailingOpenIndex);
        }
      }
    }

    return sanitized;
  }

  // Render a message segment
  function MessageSegmentView(segmentProps: {
    segment: MessageSegment;
    streaming?: boolean;
    revision?: string;
  }) {
    return (
      <Switch>
        <Match when={segmentProps.segment.type === "text"}>
          <MarkdownText
            content={(segmentProps.segment as { type: "text"; content: string }).content}
            streaming={segmentProps.streaming}
            revision={segmentProps.revision}
          />
        </Match>
        <Match when={segmentProps.segment.type === "file-ref"}>
          <FileLink
            file={
              (
                segmentProps.segment as {
                  type: "file-ref";
                  file: string;
                  line?: number;
                }
              ).file
            }
            line={
              (
                segmentProps.segment as {
                  type: "file-ref";
                  file: string;
                  line?: number;
                }
              ).line
            }
            onClick={(file, line) => handleFileClick(file, line, segmentProps.revision)}
          />
        </Match>
        <Match when={segmentProps.segment.type === "annotation"}>
          <AnnotationBlock
            annotation={
              (
                segmentProps.segment as {
                  type: "annotation";
                  annotation: Annotation;
                }
              ).annotation
            }
            onNavigate={(file, line) => handleFileClick(file, line, segmentProps.revision)}
            onCreateComment={(annotation) => {
              const sid = sessionId();
              if (sid) {
                if (props.interactions)
                  props.interactions.prepareComment(
                    annotation,
                    sid,
                    segmentProps.revision ?? navigationRevision(),
                  );
                else
                  props.onCreateFindingComment?.(
                    annotation,
                    sid,
                    segmentProps.revision ?? navigationRevision(),
                  );
              }
            }}
          />
        </Match>
        <Match when={segmentProps.segment.type === "review-order"}>
          <ReviewOrderPanel
            files={
              (
                segmentProps.segment as {
                  type: "review-order";
                  files: string[];
                }
              ).files
            }
            currentFiles={props.files}
            onApplyOrder={handleApplyOrder}
            onFileClick={(file) => handleFileClick(file, undefined, segmentProps.revision)}
          />
        </Match>
      </Switch>
    );
  }

  // Render message content with token parsing for assistant messages
  function MessageContent(contentProps: {
    role: "user" | "assistant";
    content: string;
    streaming?: boolean;
    revision?: string;
  }) {
    if (contentProps.role === "user") {
      return <span class="whitespace-pre-wrap">{contentProps.content}</span>;
    }

    // Parse assistant messages for special tokens
    const parsed = parseReviewTokens(
      contentProps.streaming
        ? sanitizeStreamingReviewTokens(contentProps.content)
        : contentProps.content,
    );

    return (
      <For each={parsed.segments}>
        {(segment) => (
          <MessageSegmentView
            segment={segment}
            streaming={contentProps.streaming}
            revision={contentProps.revision}
          />
        )}
      </For>
    );
  }

  function ReasoningBlock(reasoningProps: { content: string; streaming?: boolean }) {
    return (
      <div class="space-y-1">
        <Show when={reasoningProps.streaming}>
          <div class="border-l-2 border-accent/40 pl-3">
            <div class="mb-1 text-xs font-medium text-text-faint">Latest thinking</div>
            <p class="whitespace-pre-wrap text-xs leading-relaxed text-text-muted wrap-break-word">
              {thinkingTail(reasoningProps.content)}
            </p>
          </div>
        </Show>
        <details class="py-1 text-text-muted">
          <summary class="cursor-pointer select-none text-xs font-medium text-text-faint">
            {reasoningProps.streaming ? "Full reasoning" : "Reasoning"}
          </summary>
          <div class="mt-1 whitespace-pre-wrap text-xs leading-relaxed wrap-break-word">
            {reasoningProps.content}
          </div>
        </details>
      </div>
    );
  }

  // Render tool call status
  function ToolCallView(toolProps: { tool: ToolCall }) {
    const tool = toolProps.tool;
    const targetKeys = ["path", "filePath", "file", "url", "query", "command", "pattern"];

    const targetEntry = () =>
      targetKeys
        .map((key) => [key, tool.input[key]] as const)
        .find((entry): entry is readonly [string, string] => typeof entry[1] === "string");

    const rangeLabel = () => {
      const line = tool.input.line;
      if (typeof line === "number") return `L${line}`;

      const startLine = tool.input.startLine;
      const endLine = tool.input.endLine;
      if (typeof startLine === "number") {
        return typeof endLine === "number" ? `L${startLine}-${endLine}` : `L${startLine}`;
      }

      const offset = tool.input.offset;
      const limit = tool.input.limit;
      if (typeof offset === "number") {
        return typeof limit === "number" && limit > 0
          ? `L${offset}-${offset + limit - 1}`
          : `L${offset}`;
      }

      return null;
    };

    const statusColor = () => {
      switch (tool.status) {
        case "pending":
        case "running":
          return "text-accent";
        case "completed":
          return "text-text-faint";
        case "error":
          return "text-error";
        default:
          return "text-text-muted";
      }
    };

    const statusIcon = () => {
      switch (tool.status) {
        case "pending":
          return "○";
        case "running":
          return "●";
        case "completed":
          return "✓";
        case "error":
          return "✗";
        default:
          return "";
      }
    };

    const hasDetails = () =>
      Object.keys(tool.input).length > 0 || Boolean(tool.output) || Boolean(tool.error);

    return (
      <details class="min-w-0 max-w-full overflow-hidden py-1.5 font-mono text-xs">
        <summary class="flex min-w-0 cursor-pointer list-none items-center gap-2 overflow-hidden">
          <span
            class={`shrink-0 ${statusColor()} ${tool.status === "running" ? "animate-pulse" : ""}`}
          >
            {statusIcon()}
          </span>
          <span class="shrink-0 text-text-muted">{tool.tool}</span>
          <Show when={targetEntry()?.[1]}>
            {(target) => (
              <span class="min-w-0 truncate text-xs text-text-faint" title={target()}>
                {target()}
              </span>
            )}
          </Show>
          <Show when={rangeLabel()}>
            {(range) => <span class="shrink-0 text-xs text-text-faint">{range()}</span>}
          </Show>
        </summary>
        <Show when={hasDetails()}>
          <div class="mt-1 min-w-0 max-w-full space-y-1 overflow-hidden border-t border-border pt-1 text-[11px] leading-relaxed text-text-faint">
            <Show when={Object.keys(tool.input).length > 0}>
              <div class="min-w-0 max-w-full overflow-hidden">
                <div class="text-text-muted">Arguments</div>
                <pre class="max-w-full overflow-auto whitespace-pre">
                  {JSON.stringify(tool.input, null, 2)}
                </pre>
              </div>
            </Show>
            <Show when={tool.output}>
              <div class="min-w-0 max-w-full overflow-hidden">
                <div class="text-text-muted">Result</div>
                <pre class="max-h-56 max-w-full overflow-auto whitespace-pre leading-5">
                  {tool.output}
                </pre>
              </div>
            </Show>
            <Show when={tool.error}>
              <div class="min-w-0 max-w-full overflow-hidden">
                <div class="text-error">Error</div>
                <pre class="max-h-40 max-w-full overflow-auto whitespace-pre text-error">
                  {tool.error}
                </pre>
              </div>
            </Show>
          </div>
        </Show>
      </details>
    );
  }

  // Combine error from session and streaming
  const displayError = createMemo(() => sessionError() || chat.error());

  // Resize handlers
  const handleMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isResizing()) return;
    const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX));
    setWidth(newWidth);
  };

  const handleMouseUp = () => {
    if (isResizing()) {
      setIsResizing(false);
      // Save width to localStorage
      try {
        localStorage.setItem(CHAT_WIDTH_KEY, width().toString());
      } catch {
        // Ignore storage errors
      }
    }
  };

  onMount(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  });

  onCleanup(() => {
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  });

  const transcript = createMemo(() => groupTranscript(chat.messages()));

  const liveActivity = createMemo(() =>
    currentActivity(chat.messages(), chat.activeTools(), chat.streamingReasoning()),
  );
  const isLiveGroup = (id: string) =>
    chat.isStreaming() &&
    transcript().at(-1)?.role === "assistant" &&
    transcript().at(-1)?.id === id;

  function Activity(props: { tools: ToolCall[]; live?: boolean }) {
    const running = () =>
      props.live ? props.tools.filter((t) => t.status === "running" || t.status === "pending") : [];
    const history = () => (props.live ? props.tools.slice(0, -3) : props.tools);
    const failed = () => history().filter((t) => t.status === "error").length;
    return (
      <Show when={props.tools.length > 0}>
        <div class="min-w-0 space-y-1">
          <Show when={running().length > 0}>
            <div class="flex min-w-0 items-center gap-2 text-xs text-text-muted" role="status">
              <SpinnerIcon size={12} class="shrink-0 animate-spin text-accent" />
              <span class="truncate">
                Running {running().at(-1)?.tool}
                {running().length > 1 ? ` · ${running().length} active` : ""}
              </span>
            </div>
          </Show>
          <Show when={props.live}>
            <div aria-label="Latest tool calls" class="divide-y divide-border">
              <For each={props.tools.slice(-3)}>{(tool) => <ToolCallView tool={tool} />}</For>
            </div>
          </Show>
          <Show when={history().length > 0}>
            <details class="text-xs text-text-muted">
              <summary class="cursor-pointer select-none py-1 hover:text-text">
                {history().length} {props.live ? "earlier " : ""}
                {history().length === 1 ? "step" : "steps"}
                {history().every((t) => t.status === "completed") ? " completed" : " recorded"}
                <Show when={failed() > 0}>
                  <span class="text-error"> · {failed()} failed</span>
                </Show>
              </summary>
              <div class="mt-1 divide-y divide-border">
                <For each={history()}>{(tool) => <ToolCallView tool={tool} />}</For>
              </div>
            </details>
          </Show>
        </div>
      </Show>
    );
  }

  return (
    <div
      id="chat-panel"
      class="chat-panel border-r border-border flex flex-col bg-bg-surface relative"
      style={{
        "--chat-panel-width": `${width()}px`,
        display: props.hidden ? "none" : undefined,
      }}
    >
      {/* Resize handle */}
      <div
        class="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-accent/50 transition-colors z-10"
        classList={{ "bg-accent": isResizing() }}
        onMouseDown={handleMouseDown}
      />

      <PanelHeader
        title="Review assistant"
        actions={
          <>
            <Show when={sessionId()}>
              <ReviewActions
                disabled={reviewActionsDisabled()}
                canPull={props.reviewMode !== "commit"}
                onReview={startReview}
                onSummarize={() =>
                  void submitMessage(
                    buildReviewPrompt("Summarize the changes in this PR.", useSte100()),
                  )
                }
                onSecurity={() =>
                  void submitMessage(
                    buildReviewPrompt(
                      "Are there any security concerns in these changes?",
                      useSte100(),
                    ),
                  )
                }
                onPull={() => void handlePullLatest()}
                onCompact={() => void chat.compact()}
                onCopy={() => void handleCopyFeedback()}
                canCopy={chat.messages().some((message) => message.role === "assistant")}
              />
            </Show>
            <Show when={chat.isStreaming()}>
              <Button onClick={handleAbort} variant="danger" size="sm">
                Stop
              </Button>
            </Show>
            <IconButton
              label="Assistant settings"
              aria-expanded={assistantSettingsOpen()}
              aria-controls="assistant-settings"
              onClick={() => setAssistantSettingsOpen(!assistantSettingsOpen())}
            >
              ···
            </IconButton>
          </>
        }
      />
      <Show when={sessionId()}>
        <div class="border-b border-border px-3 py-1.5">
          <ReviewSessionToolbar
            sessions={sessions()}
            activeSessionId={sessionId()}
            currentHeadSha={props.displayedHeadSha ?? currentHeadSha() ?? undefined}
            disabled={reviewActionsDisabled()}
            creating={creatingNewSession()}
            onSelect={handleSessionSwitch}
            onHide={handleHideSession}
            onNew={() => void handleNewSession()}
            onReview={startReview}
            onAdversarial={() => void startAdversarialReview()}
          />
          <p
            role="status"
            aria-live="polite"
            class="text-xs text-text-muted"
            classList={{
              "mt-2":
                pullingLatest() || !!pullNotice() || chat.compacting() || creatingNewSession(),
            }}
          >
            {pullingLatest()
              ? "Checking the PR and preparing the latest checkout…"
              : creatingNewSession()
                ? "Creating session…"
                : chat.compacting()
                  ? "Compacting context…"
                  : feedbackCopied()
                    ? "Feedback copied."
                    : pullNotice()}
          </p>
        </div>
      </Show>
      <div hidden={!assistantSettingsOpen()}>
        <div id="assistant-settings" class="border-b border-border bg-bg px-3 py-3 space-y-3">
          <Show when={sessionId()}>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-xs text-text-muted">Model</span>{" "}
              <ModelSelector
                align="left"
                disabled={chat.isStreaming() || initializing() || creatingNewSession()}
                class="shrink-0"
              />
            </div>
            <Checkbox
              label="Simplified technical English (STE100)"
              checked={useSte100()}
              onChange={toggleSte100}
              disabled={chat.isStreaming() || initializing() || creatingNewSession()}
            />
          </Show>
          <Show when={!sessionId()}>
            <p class="text-xs text-text-muted">
              Session settings are available after the PR loads.
            </p>
          </Show>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={(el) => {
          _messagesContainer = el;
        }}
        class="flex-1 overflow-y-auto px-4 py-3 space-y-2"
      >
        <Show when={!props.prUrl}>
          <div class="text-center py-8">
            <div class="text-text-faint text-sm">Load a PR to start chatting</div>
          </div>
        </Show>

        <Show when={props.prUrl && !initializing() && !sessionId() && sessionError()}>
          <div class="text-center py-8">
            <div class="text-error text-sm mb-2">{sessionError()}</div>
            <button
              type="button"
              onClick={initSession}
              class="text-sm text-accent hover:text-accent-bright"
            >
              Retry
            </button>
          </div>
        </Show>

        <Show
          when={
            props.prUrl &&
            (initializing() ||
              creatingNewSession() ||
              (sessionId() && chat.messages().length === 0 && !chat.isStreaming()))
          }
        >
          <div class="text-center py-4">
            <Show
              when={!initializing() && !creatingNewSession()}
              fallback={
                <div class="flex items-center justify-center gap-2 text-text-faint text-sm mb-3">
                  <SpinnerIcon size={14} class="animate-spin" />
                  <span>
                    {creatingNewSession() ? "Creating session..." : "Initializing session..."}
                  </span>
                </div>
              }
            >
              <div class="text-text-faint text-sm mb-3">
                Choose an action from Actions, or ask about the PR below.
              </div>
            </Show>
          </div>
        </Show>

        <For each={transcript()}>
          {(group) => (
            <Show
              when={group.role === "user"}
              fallback={
                <section class="min-w-0 space-y-3 py-2" aria-label="Assistant response">
                  <Show when={!isLiveGroup(group.id)}>
                    <Activity tools={group.messages.flatMap((message) => message.toolCalls)} />
                    <Show when={group.messages.some((message) => message.reasoning?.trim())}>
                      <ReasoningBlock
                        content={group.messages
                          .map((message) => message.reasoning)
                          .filter(Boolean)
                          .join("\n\n")}
                      />
                    </Show>
                  </Show>
                  <For each={group.messages.filter((message) => message.content.trim())}>
                    {(message) => (
                      <div class="text-sm text-text wrap-break-word leading-relaxed">
                        <MessageContent
                          role="assistant"
                          content={message.content}
                          revision={message.revision}
                        />
                      </div>
                    )}
                  </For>
                </section>
              }
            >
              <div class="border-t border-border pt-4 pb-2 text-sm">
                <Show
                  when={reviewRequestLabel(group.messages[0]!.content)}
                  fallback={
                    <div class="space-y-1">
                      <span class="text-xs text-text-faint">You</span>
                      <SelectionQuestionMessage
                        content={group.messages[0]!.content}
                        onNavigate={navigateSelectionSource}
                      />
                    </div>
                  }
                >
                  {(label) => (
                    <details>
                      <summary class="cursor-pointer text-sm font-medium text-text">
                        {label()}
                      </summary>
                      <p class="mt-3 whitespace-pre-wrap wrap-break-word text-xs text-text-muted leading-relaxed">
                        {group.messages[0]!.content}
                      </p>
                    </details>
                  )}
                </Show>
              </div>
            </Show>
          )}
        </For>

        <Show
          when={
            chat.isStreaming() ||
            chat.streamingContent() ||
            chat.streamingReasoning() ||
            chat.activeTools().length > 0
          }
        >
          <section class="min-w-0 space-y-3 py-2" aria-label="Current assistant response">
            <Show when={chat.isStreaming()}>
              <div class="flex items-center gap-2 text-xs text-text-muted" role="status">
                <span class="size-1.5 rounded-full bg-accent" />
                {chat.streamingContent()
                  ? "Writing review"
                  : chat.activeTools().some((t) => t.status === "running" || t.status === "pending")
                    ? "Reviewing changes"
                    : "Thinking"}
              </div>
            </Show>
            <Activity
              tools={chat.isStreaming() ? liveActivity().tools : chat.activeTools()}
              live={chat.isStreaming()}
            />
            <Show when={chat.isStreaming() ? liveActivity().reasoning : chat.streamingReasoning()}>
              <ReasoningBlock
                content={chat.isStreaming() ? liveActivity().reasoning : chat.streamingReasoning()}
                streaming={chat.isStreaming()}
              />
            </Show>
            <Show when={chat.streamingContent()}>
              <div class="text-sm text-text wrap-break-word leading-relaxed">
                <MessageContent
                  role="assistant"
                  content={chat.streamingContent()}
                  revision={chat.streamingRevision()}
                  streaming
                />
              </div>
            </Show>
          </section>
        </Show>
      </div>

      {/* Error and retry display */}
      <Show when={linkNotice()}>
        <div role="status" class="border-t border-warning/40 p-2 text-xs text-warning">
          {linkNotice()}{" "}
          <button type="button" onClick={() => setLinkNotice(null)}>
            Dismiss
          </button>
        </div>
      </Show>
      <Show when={displayError() || chat.retryableMessage()}>
        <div class="flex items-center justify-between gap-3 border-t border-error/20 bg-error/10 px-3 py-2">
          <div class="text-error text-sm">{displayError() ?? "The last prompt failed."}</div>
          <Show when={chat.retryableMessage() && !chat.isStreaming()}>
            <Button type="button" variant="secondary" size="xs" onClick={() => void chat.retry()}>
              Retry
            </Button>
          </Show>
        </div>
      </Show>

      {/* Input */}
      <div class="border-t border-border p-2">
        <MessageForm onSubmit={sendMessage}>
          <div class="flex flex-col gap-2">
            <Textarea
              value={input()}
              onInput={(e) => setInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.metaKey &&
                  !e.ctrlKey &&
                  !e.altKey &&
                  !e.isComposing &&
                  e.keyCode !== 229 &&
                  !e.repeat
                ) {
                  e.preventDefault();
                  const form = e.currentTarget.form;
                  const button = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
                  if (form && button && !button.disabled) form.requestSubmit(button);
                }
              }}
              placeholder={
                sessionId()
                  ? creatingNewSession()
                    ? "Creating session..."
                    : "Ask about this PR..."
                  : props.prUrl
                    ? initializing()
                      ? "Initializing..."
                      : sessionError()
                        ? "Session failed - retry above"
                        : "Connecting..."
                    : "Load a PR first"
              }
              disabled={
                !sessionId() || chat.isStreaming() || creatingNewSession() || sendingSelection()
              }
              aria-label="Message review assistant"
              class="w-full resize-none"
              rows={2}
            />
            <div class="flex justify-between items-center">
              <div class="flex items-center gap-2">
                {/* Connection status */}
                <div class="flex items-center gap-1">
                  <div
                    class="w-2 h-2 rounded-full"
                    classList={{
                      "bg-success": chat.connectionStatus() === "connected",
                      "bg-warning":
                        chat.connectionStatus() === "degraded" ||
                        chat.connectionStatus() === "reconnecting",
                      "bg-accent": chat.connectionStatus() === "connecting",
                      "bg-text-faint": !sessionId(),
                    }}
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={
                  !sessionId() ||
                  chat.isStreaming() ||
                  creatingNewSession() ||
                  sendingSelection() ||
                  !input().trim()
                }
                class="px-3 py-1 bg-primary text-primary-text text-sm font-medium hover:bg-primary-hover disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {chat.isStreaming() ? "..." : "Send"}
              </button>
            </div>
          </div>
        </MessageForm>
      </div>
    </div>
  );
}
