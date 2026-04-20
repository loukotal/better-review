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
} from "solid-js";

import { SYSTEM_CONTEXT_MARKER, type StoredSession } from "@better-review/shared";

import { AnnotationBlock } from "./components/AnnotationBlock";
import { FileLink } from "./components/FileLink";
import { ModelSelector } from "./components/ModelSelector";
import { ReviewOrderPanel } from "./components/ReviewOrderPanel";
import { SessionSelector } from "./components/SessionSelector";
import { Button } from "./design-system";
import type { DiffTheme } from "./diff/types";
import { useStreamingChat, type ToolCall } from "./hooks/useStreamingChat";
import { CheckIcon } from "./icons/check-icon";
import { CopyIcon } from "./icons/copy-icon";
import { SpinnerIcon } from "./icons/spinner-icon";
import {
  applySafeMarkdownRenderer,
  escapeHtmlText,
  normalizeMalformedInlineCode,
} from "./lib/markdown";
import { highlightCode, clearHighlightCache } from "./lib/shiki";
import { trpc } from "./lib/trpc";
import { parseReviewTokens, type Annotation, type MessageSegment } from "./utils/parseReviewTokens";

// Configure marked for safe, minimal output
marked.setOptions({
  gfm: true,
  breaks: true,
});

interface ChatPanelProps {
  prUrl: string | null;
  prNumber: number | null;
  repoOwner: string | null;
  repoName: string | null;
  files: string[];
  theme: DiffTheme;
  aiAnnotations?: Annotation[];
  onScrollToFile?: (file: string, line?: number) => void;
  onApplyReviewOrder?: (files: string[]) => void;
  onAnnotationsReceived?: (annotations: Annotation[]) => void;
  reviewMode?: "full" | "commit";
  commitSha?: string | null;
}

const CHAT_WIDTH_KEY = "chat-panel-width";
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 600;

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

export function ChatPanel(props: ChatPanelProps) {
  const [input, setInput] = createSignal("");
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [sessionError, setSessionError] = createSignal<string | null>(null);
  const [initializing, setInitializing] = createSignal(false);
  const [scopeSessionKey, setScopeSessionKey] = createSignal<string | null>(null);
  const [switchingCommitSession, setSwitchingCommitSession] = createSignal(false);

  // Session management state
  const [sessions, setSessions] = createSignal<StoredSession[]>([]);
  const [currentHeadSha, setCurrentHeadSha] = createSignal<string | null>(null);

  // Resize state
  const [width, setWidth] = createSignal(loadSavedWidth());
  const [isResizing, setIsResizing] = createSignal(false);

  // Use the streaming chat hook
  const chat = useStreamingChat({
    getSessionId: () => sessionId(),
    onError: (err) => console.error("[ChatPanel] Stream error:", err),
  });

  let _messagesContainer: HTMLDivElement | undefined;

  // Auto-scroll to bottom when messages or streaming content changes
  createEffect(() => {
    // Track all relevant signals that should trigger scroll
    chat.messages();
    chat.streamingContent();
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
        chat
          .messages()
          .map((m) => m.id)
          .join(","),
      () => {
        if (!props.onAnnotationsReceived) return;

        // Extract annotations from all assistant messages
        const allAnnotations: Annotation[] = [];
        for (const msg of chat.messages()) {
          if (msg.role === "assistant") {
            const parsed = parseReviewTokens(msg.content);
            allAnnotations.push(...parsed.annotations);
          }
        }

        if (allAnnotations.length > 0) {
          props.onAnnotationsReceived(allAnnotations);
        }
      },
      { defer: true },
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

  // Initialize session when PR changes
  createEffect(() => {
    const prUrl = props.prUrl;
    const prNumber = props.prNumber;
    const repoOwner = props.repoOwner;
    const repoName = props.repoName;

    if (prUrl && prNumber && repoOwner && repoName) {
      initSession();
    } else {
      setSessionId(null);
      setSessions([]);
      setCurrentHeadSha(null);
      chat.clearMessages();
      setSessionError(null);
      setScopeSessionKey(null);
    }
  });

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

    setInitializing(true);
    setSessionError(null);

    try {
      const data = await trpc.opencode.getOrCreateSession.mutate({
        prUrl: props.prUrl,
        prNumber: props.prNumber,
        repoOwner: props.repoOwner,
        repoName: props.repoName,
        files: props.files,
        reviewMode: props.reviewMode,
        commitSha: props.reviewMode === "commit" ? (props.commitSha ?? undefined) : undefined,
      });

      if (!data.session?.id) {
        setSessionError("Invalid response: no session ID");
        return;
      }

      setSessionId(data.session.id);
      setScopeSessionKey(
        props.reviewMode === "commit" && props.commitSha ? `commit:${props.commitSha}` : "full",
      );

      // Update sessions list and current head SHA
      if (data.sessions) {
        setSessions(data.sessions.filter((s: StoredSession) => !s.hidden));
      }
      if (data.headSha) {
        setCurrentHeadSha(data.headSha);
      }

      // If session existed, load previous messages
      if (data.existing) {
        await loadMessages(data.session.id);
      }
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : "Failed to initialize chat session");
    } finally {
      setInitializing(false);
    }
  }

  async function loadMessages(sid: string) {
    try {
      const data = await trpc.opencode.messages.query({ sessionId: sid });

      if (data.messages && Array.isArray(data.messages)) {
        const transformed = transformOpenCodeMessages(data.messages);
        chat.loadExistingMessages(transformed);
      } else {
        chat.loadExistingMessages([]);
      }
    } catch (err) {
      console.error("Failed to load messages:", err);
      chat.loadExistingMessages([]);
    }
  }

  /**
   * Transform OpenCode messages to our StreamingMessage format
   * OpenCode SDK returns: Array<{ info: Message; parts: Array<Part> }>
   */
  function transformOpenCodeMessages(messages: unknown[]) {
    const result: Parameters<typeof chat.loadExistingMessages>[0] = [];

    // OpenCode returns { info: Message, parts: Part[] } for each message
    for (const item of messages as Array<{
      info: {
        id: string;
        role: "user" | "assistant";
        time?: { created: number };
      };
      parts: Array<{ type: string; text?: string }>;
    }>) {
      const msg = item.info;
      const parts = item.parts || [];

      // Skip messages with no parts
      if (parts.length === 0) continue;

      // Combine text parts into content
      const textParts = parts.filter((p) => p.type === "text" && p.text);
      const content = textParts.map((p) => p.text).join("");

      // Skip empty messages
      if (!content.trim()) continue;

      // Skip system-injected context messages (identified by marker prefix)
      if (msg.role === "user" && content.startsWith(SYSTEM_CONTEXT_MARKER)) {
        continue;
      }

      result.push({
        id: msg.id,
        role: msg.role,
        content,
        toolCalls: [], // Historical tool calls aren't critical for display
        isStreaming: false,
        timestamp: msg.time?.created || Date.now(),
      });
    }

    return result;
  }

  async function sendMessage(e: Event, useReviewAgent = false) {
    e.preventDefault();

    const message = input().trim();
    if (!message || chat.isStreaming() || !sessionId()) return;

    setInput("");
    await chat.sendMessage(message, {
      agent: useReviewAgent ? "review" : undefined,
      reviewMode: props.reviewMode,
      commitSha: props.reviewMode === "commit" ? (props.commitSha ?? undefined) : undefined,
    });
  }

  function handleQuickPrompt(prompt: string) {
    setInput(prompt);
  }

  function startReview() {
    const reviewPrompt =
      "Please analyze this PR and provide a structured review with file order and annotations.";
    setInput(reviewPrompt);
    setTimeout(() => {
      const fakeEvent = new Event("submit", { cancelable: true });
      sendMessage(fakeEvent, true);
    }, 50);
  }

  function handleAbort() {
    chat.abort();
  }

  // Session management handlers
  async function handleSessionSwitch(newSessionId: string) {
    if (!props.prUrl || newSessionId === sessionId()) return;

    try {
      await trpc.sessions.switch.mutate({
        prUrl: props.prUrl,
        sessionId: newSessionId,
      });

      // Load messages for the new session BEFORE switching
      const messagesData = await trpc.opencode.messages.query({
        sessionId: newSessionId,
      });

      let newMessages: Parameters<typeof chat.loadExistingMessages>[0] = [];
      if (messagesData.messages && Array.isArray(messagesData.messages)) {
        newMessages = transformOpenCodeMessages(messagesData.messages);
      }

      // Update session ID and messages atomically
      batch(() => {
        setSessionId(newSessionId);
        chat.loadExistingMessages(newMessages);
      });
    } catch (err) {
      console.error("Failed to switch session:", err);
    }
  }

  async function handleNewSession(): Promise<boolean> {
    if (!props.prUrl || !props.prNumber || !props.repoOwner || !props.repoName) return false;

    try {
      const data = await trpc.sessions.create.mutate({
        prUrl: props.prUrl,
        prNumber: props.prNumber,
        repoOwner: props.repoOwner,
        repoName: props.repoName,
        files: props.files,
        reviewMode: props.reviewMode,
        commitSha: props.reviewMode === "commit" ? (props.commitSha ?? undefined) : undefined,
      });

      if (data.session?.id) {
        batch(() => {
          setSessionId(data.session.id);
          chat.loadExistingMessages([]); // New session has no messages
          setScopeSessionKey(
            props.reviewMode === "commit" && props.commitSha ? `commit:${props.commitSha}` : "full",
          );
        });
      }
      if (data.sessions) {
        setSessions(data.sessions.filter((s: StoredSession) => !s.hidden));
      }
      return true;
    } catch (err) {
      console.error("Failed to create new session:", err);
      return false;
    }
  }

  async function handleHideSession(hiddenSessionId: string) {
    if (!props.prUrl) return;

    try {
      const data = await trpc.sessions.hide.mutate({
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
  const handleFileClick = (file: string, line?: number) => {
    props.onScrollToFile?.(file, line);
  };

  // Handle apply review order
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
        /<<ANNOTATION\s+file="([^"]+)"\s+line="([^"]+)"\s+severity="(info|warning|critical)">>([^]*?)<<\/ANNOTATION>>/g,
        (_match, file, lineStr, severity, message) => {
          const lineMatch = lineStr.match(/^(\d+)/);
          const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;
          const trimmedMessage = message.trim();

          // Compute the same hash-based ID used elsewhere
          const content = `${file}:${line}:${severity}:${trimmedMessage}`;
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
  function MarkdownText(mdProps: { content: string; streaming?: boolean }) {
    const [html, setHtml] = createSignal<string>("");

    // Track code blocks that need highlighting
    const codeBlocks: Array<{ id: string; code: string; lang: string }> = [];
    let blockCounter = 0;

    // Custom renderer that creates placeholders for code blocks
    const renderer = applySafeMarkdownRenderer(new marked.Renderer());
    renderer.code = (token: Tokens.Code) => {
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

    return <span class="markdown-content" innerHTML={html()} />;
  }

  // Helper to escape HTML for placeholders
  const escapeHtml = escapeHtmlText;

  // Render a message segment
  function MessageSegmentView(segmentProps: { segment: MessageSegment }) {
    return (
      <Switch>
        <Match when={segmentProps.segment.type === "text"}>
          <MarkdownText
            content={(segmentProps.segment as { type: "text"; content: string }).content}
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
            onClick={handleFileClick}
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
            onNavigate={handleFileClick}
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
            onFileClick={(file) => handleFileClick(file)}
          />
        </Match>
      </Switch>
    );
  }

  // Render message content with token parsing for assistant messages
  function MessageContent(contentProps: { role: "user" | "assistant"; content: string }) {
    if (contentProps.role === "user") {
      return <span class="whitespace-pre-wrap">{contentProps.content}</span>;
    }

    // Parse assistant messages for special tokens
    const parsed = parseReviewTokens(contentProps.content);

    return (
      <For each={parsed.segments}>{(segment) => <MessageSegmentView segment={segment} />}</For>
    );
  }

  // Render tool call status
  function ToolCallView(toolProps: { tool: ToolCall }) {
    const tool = toolProps.tool;
    const statusColor = () => {
      switch (tool.status) {
        case "pending":
        case "running":
          return "text-accent";
        case "completed":
          return "text-success";
        case "error":
          return "text-error";
        default:
          return "text-text-muted";
      }
    };

    const statusIcon = () => {
      switch (tool.status) {
        case "pending":
          return "...";
        case "running":
          return "...";
        case "completed":
          return "✓";
        case "error":
          return "✗";
        default:
          return "";
      }
    };

    return (
      <div class="text-sm px-2 py-1 bg-bg border border-border mb-1 flex items-center gap-2">
        <span class={statusColor()}>{statusIcon()}</span>
        <span class="text-text-muted">{tool.title || tool.tool}</span>
        <Show when={tool.status === "running"}>
          <span class="animate-pulse">...</span>
        </Show>
      </div>
    );
  }

  const quickPrompts = [
    { label: "Summarize", prompt: "Summarize the changes in this PR." },
    {
      label: "Security",
      prompt: "Are there any security concerns in these changes?",
    },
  ];

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

  return (
    <div
      class="border-r border-border flex flex-col bg-bg-surface relative"
      style={{
        width: `${width()}px`,
        "min-width": `${MIN_WIDTH}px`,
        "max-width": `${MAX_WIDTH}px`,
      }}
    >
      {/* Resize handle */}
      <div
        class="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-accent/50 transition-colors z-10"
        classList={{ "bg-accent": isResizing() }}
        onMouseDown={handleMouseDown}
      />

      {/* Header */}
      <div class="px-3 py-2 border-b border-border">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-accent text-sm shrink-0">AI</span>
            <h2 class="text-sm text-text font-medium truncate">Review Assistant</h2>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <Show when={chat.messages().some((m) => m.role === "assistant") && !chat.isStreaming()}>
              <button
                type="button"
                onClick={handleCopyFeedback}
                class={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs border transition-colors whitespace-nowrap ${
                  feedbackCopied()
                    ? "border-success/50 text-success"
                    : "border-border text-text-faint hover:border-accent hover:text-accent"
                }`}
                title="Copy all AI feedback to clipboard (skips dismissed suggestions)"
              >
                {feedbackCopied() ? <CheckIcon size={10} /> : <CopyIcon size={10} />}
                <span>{feedbackCopied() ? "Copied" : "Copy Feedback"}</span>
              </button>
            </Show>
            <Show when={sessionId() && !chat.isStreaming()}>
              <Button
                type="button"
                onClick={startReview}
                variant="primary"
                size="xs"
                class="whitespace-nowrap"
              >
                {width() < 300 ? "Review" : "Start Review"}
              </Button>
            </Show>
            <Show when={chat.isStreaming()}>
              <button
                type="button"
                onClick={handleAbort}
                class="px-1.5 py-0.5 text-xs bg-error text-white hover:bg-error/80 transition-colors"
              >
                Stop
              </button>
            </Show>
          </div>
        </div>
        {/* Session selector row - show when we have a session */}
        <Show when={sessionId()}>
          <div
            class="mt-1.5 gap-1.5"
            classList={{
              "flex flex-col": width() < 300,
              "flex items-center justify-between": width() >= 300,
            }}
          >
            <div class="flex items-center gap-1.5 min-w-0">
              <SessionSelector
                sessions={sessions()}
                activeSessionId={sessionId()}
                currentHeadSha={currentHeadSha() || undefined}
                disabled={chat.isStreaming() || initializing()}
                onSelect={handleSessionSwitch}
                onNewSession={handleNewSession}
                onHide={handleHideSession}
              />
              <button
                type="button"
                onClick={handleNewSession}
                disabled={chat.isStreaming() || initializing()}
                class="flex items-center gap-1 px-1.5 py-0.5 text-xs border border-accent text-accent hover:bg-accent hover:text-bg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                title="Create new session"
              >
                {width() < 300 ? "+New" : "+ New"}
              </button>
            </div>
            <ModelSelector disabled={chat.isStreaming()} />
          </div>
        </Show>
        {/* Model selector when no session yet */}
        <Show when={!sessionId() && props.prUrl}>
          <div class="flex items-center justify-end mt-1.5">
            <ModelSelector disabled={chat.isStreaming()} />
          </div>
        </Show>
      </div>

      {/* Messages */}
      <div
        ref={(el) => {
          _messagesContainer = el;
        }}
        class="flex-1 overflow-y-auto px-3 py-2 space-y-3"
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
            (initializing() || (sessionId() && chat.messages().length === 0 && !chat.isStreaming()))
          }
        >
          <div class="text-center py-4">
            <Show
              when={!initializing()}
              fallback={
                <div class="flex items-center justify-center gap-2 text-text-faint text-sm mb-3">
                  <SpinnerIcon size={14} class="animate-spin" />
                  <span>Initializing session...</span>
                </div>
              }
            >
              <div class="text-text-faint text-sm mb-3">
                Click "Start Review" for a structured review, or ask questions about this PR
              </div>
            </Show>
            <div class="flex flex-wrap gap-1.5 justify-center">
              <For each={quickPrompts}>
                {(qp) => (
                  <button
                    type="button"
                    onClick={() => handleQuickPrompt(qp.prompt)}
                    disabled={initializing()}
                    class="px-2 py-1 text-sm border border-border text-text-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    classList={{
                      "hover:border-accent hover:text-accent": !initializing(),
                    }}
                  >
                    {qp.label}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Completed messages */}
        <For each={chat.messages()}>
          {(msg) => (
            <div class={`text-sm ${msg.role === "user" ? "ml-4" : "mr-2"}`}>
              <div
                class={`px-2.5 py-2 ${
                  msg.role === "user"
                    ? "bg-accent/10 border border-accent/20"
                    : "bg-bg-elevated border border-border"
                }`}
              >
                <div class="text-sm text-text-faint mb-1">
                  {msg.role === "user" ? "You" : "Assistant"}
                </div>

                {/* Show tool calls for assistant messages */}
                <Show when={msg.role === "assistant" && msg.toolCalls.length > 0}>
                  <div class="mb-2">
                    <For each={msg.toolCalls}>{(tool) => <ToolCallView tool={tool} />}</For>
                  </div>
                </Show>

                <div class="text-text wrap-break-word leading-relaxed text-sm">
                  <MessageContent role={msg.role} content={msg.content} />
                </div>
              </div>
            </div>
          )}
        </For>

        {/* Streaming message */}
        <Show when={chat.isStreaming() || chat.streamingContent() || chat.activeTools().length > 0}>
          <div class="mr-2">
            <div class="px-2.5 py-2 bg-bg-elevated border border-border">
              <div class="text-sm text-text-faint mb-1">Assistant</div>

              {/* Active tool calls */}
              <Show when={chat.activeTools().length > 0}>
                <div class="mb-2">
                  <For each={chat.activeTools()}>{(tool) => <ToolCallView tool={tool} />}</For>
                </div>
              </Show>

              {/* Streaming content - render markdown with remend for incomplete blocks */}
              <Show when={chat.streamingContent()}>
                <div class="text-sm text-text wrap-break-word leading-relaxed">
                  <MarkdownText content={chat.streamingContent()!} streaming={true} />
                </div>
              </Show>

              {/* Show cursor when actively streaming with no content yet */}
              <Show
                when={
                  chat.awaitingFirstToken() &&
                  !chat.streamingContent() &&
                  chat.activeTools().length === 0
                }
              >
                <div class="text-text-muted text-sm flex items-center gap-2">
                  <SpinnerIcon size={12} class="animate-spin" />
                  <span class="inline-block animate-pulse">Model is thinking...</span>
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </div>

      {/* Error display */}
      <Show when={displayError()}>
        <div class="px-3 py-2 bg-error/10 border-t border-error/20">
          <div class="text-error text-sm">{displayError()}</div>
        </div>
      </Show>

      {/* Input */}
      <div class="border-t border-border p-2">
        <form onSubmit={(e) => sendMessage(e, false)}>
          <div class="flex flex-col gap-2">
            <textarea
              value={input()}
              onInput={(e) => setInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage(e, false);
                }
              }}
              placeholder={
                sessionId()
                  ? "Ask about this PR..."
                  : props.prUrl
                    ? initializing()
                      ? "Initializing..."
                      : sessionError()
                        ? "Session failed - retry above"
                        : "Connecting..."
                    : "Load a PR first"
              }
              disabled={!sessionId() || chat.isStreaming()}
              class="w-full px-2 py-1.5 bg-bg border border-border text-sm text-text placeholder:text-text-faint hover:border-text-faint focus:border-accent resize-none disabled:opacity-50 disabled:cursor-not-allowed font-mono"
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
                  <span class="text-[9px] text-text-faint font-mono">
                    {(() => {
                      if (!sessionId()) return "Offline";
                      const status = chat.connectionStatus();
                      if (status === "connected") return "Connected";
                      if (status === "degraded") return "Degraded";
                      if (status === "reconnecting") return "Reconnecting";
                      if (status === "connecting") return "Connecting";
                      return "Offline";
                    })()}
                  </span>
                  <Show when={chat.upstreamStatus()}>
                    <span class="text-[9px] text-text-faint/80 font-mono">
                      upstream: {chat.upstreamStatus()}
                    </span>
                  </Show>
                  <span class="text-[9px] text-text-faint/80 font-mono">
                    scope:{" "}
                    {props.reviewMode === "commit" && props.commitSha
                      ? `commit ${props.commitSha.slice(0, 7)}`
                      : "full pr"}
                  </span>
                </div>
                {/* Quick prompts */}
                <Show when={chat.messages().length > 0}>
                  <div class="flex gap-1">
                    <For each={quickPrompts}>
                      {(qp) => (
                        <button
                          type="button"
                          onClick={() => handleQuickPrompt(qp.prompt)}
                          disabled={!sessionId() || chat.isStreaming()}
                          class="px-1.5 py-0.5 text-[9px] border border-border text-text-faint hover:border-accent hover:text-accent transition-colors disabled:opacity-30"
                        >
                          {qp.label}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
              <button
                type="submit"
                disabled={!sessionId() || chat.isStreaming() || !input().trim()}
                class="px-3 py-1 bg-primary text-text text-sm font-medium hover:bg-primary-hover disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {chat.isStreaming() ? "..." : "Send"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
