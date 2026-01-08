import { marked } from "marked";
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
} from "solid-js";

import { SYSTEM_CONTEXT_MARKER, type StoredSession } from "@better-review/shared";

import { AnnotationBlock } from "./components/AnnotationBlock";
import { FileLink } from "./components/FileLink";
import { ModelSelector } from "./components/ModelSelector";
import { ReviewOrderPanel } from "./components/ReviewOrderPanel";
import { SessionSelector } from "./components/SessionSelector";
import { useStreamingChat, type ToolCall } from "./hooks/useStreamingChat";
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
  onScrollToFile?: (file: string, line?: number) => void;
  onApplyReviewOrder?: (files: string[]) => void;
  onAddAnnotationAsComment?: (annotation: Annotation) => void;
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
    }
  });

  async function initSession() {
    if (!props.prUrl || !props.prNumber || !props.repoOwner || !props.repoName) {
      return;
    }

    setInitializing(true);
    setSessionError(null);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const res = await fetch("/api/opencode/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prUrl: props.prUrl,
          prNumber: props.prNumber,
          repoOwner: props.repoOwner,
          repoName: props.repoName,
          files: props.files,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text();
        setSessionError(`Server error: ${res.status} - ${text}`);
        return;
      }

      const data = await res.json();

      if (data.error) {
        setSessionError(data.error);
        return;
      }

      if (!data.session?.id) {
        setSessionError("Invalid response: no session ID");
        return;
      }

      setSessionId(data.session.id);

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
      if (err instanceof Error && err.name === "AbortError") {
        setSessionError("Connection timed out - is OpenCode running?");
      } else {
        setSessionError(err instanceof Error ? err.message : "Failed to initialize chat session");
      }
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
    await chat.sendMessage(message, useReviewAgent ? "review" : undefined);
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

  async function handleNewSession() {
    if (!props.prUrl || !props.prNumber || !props.repoOwner || !props.repoName) return;

    try {
      const data = await trpc.sessions.create.mutate({
        prUrl: props.prUrl,
        prNumber: props.prNumber,
        repoOwner: props.repoOwner,
        repoName: props.repoName,
        files: props.files,
      });

      if (data.session?.id) {
        batch(() => {
          setSessionId(data.session.id);
          chat.loadExistingMessages([]); // New session has no messages
        });
      }
      if (data.sessions) {
        setSessions(data.sessions.filter((s: StoredSession) => !s.hidden));
      }
    } catch (err) {
      console.error("Failed to create new session:", err);
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

  // Handle add annotation as comment
  const handleAddAsComment = (annotation: Annotation) => {
    props.onAddAnnotationAsComment?.(annotation);
  };

  // Render markdown text (with streaming support via remend)
  function MarkdownText(mdProps: { content: string; streaming?: boolean }) {
    const html = () => {
      try {
        // Use remend to complete incomplete markdown during streaming
        const preprocessed = mdProps.streaming ? remend(mdProps.content) : mdProps.content;
        return marked.parse(preprocessed, { async: false }) as string;
      } catch {
        return mdProps.content;
      }
    };

    return <span class="markdown-content" innerHTML={html()} />;
  }

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
            onAddAsComment={handleAddAsComment}
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
            <span class="text-accent text-sm flex-shrink-0">AI</span>
            <h2 class="text-sm text-text font-medium truncate">Review Assistant</h2>
          </div>
          <div class="flex items-center gap-1 flex-shrink-0">
            <Show when={sessionId() && !chat.isStreaming()}>
              <button
                type="button"
                onClick={startReview}
                class="px-1.5 py-0.5 text-xs bg-accent text-black hover:bg-accent-bright transition-colors whitespace-nowrap"
              >
                {width() < 300 ? "Review" : "Start Review"}
              </button>
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
                class="flex items-center gap-1 px-1.5 py-0.5 text-xs border border-accent text-accent hover:bg-accent hover:text-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
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
      <div ref={_messagesContainer} class="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        <Show when={!props.prUrl}>
          <div class="text-center py-8">
            <div class="text-text-faint text-sm">Load a PR to start chatting</div>
          </div>
        </Show>

        <Show when={props.prUrl && initializing()}>
          <div class="text-center py-8">
            <div class="text-text-faint text-sm">Initializing session...</div>
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
          when={props.prUrl && sessionId() && chat.messages().length === 0 && !chat.isStreaming()}
        >
          <div class="text-center py-4">
            <div class="text-text-faint text-sm mb-3">
              Click "Start Review" for a structured review, or ask questions about this PR
            </div>
            <div class="flex flex-wrap gap-1.5 justify-center">
              <For each={quickPrompts}>
                {(qp) => (
                  <button
                    type="button"
                    onClick={() => handleQuickPrompt(qp.prompt)}
                    class="px-2 py-1 text-sm border border-border text-text-muted hover:border-accent hover:text-accent transition-colors"
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

                <div class="text-text break-words leading-relaxed text-sm">
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
                <div class="text-sm text-text break-words leading-relaxed">
                  <MarkdownText content={chat.streamingContent()!} streaming={true} />
                </div>
              </Show>

              {/* Show cursor when actively streaming with no content yet */}
              <Show
                when={
                  chat.isStreaming() && !chat.streamingContent() && chat.activeTools().length === 0
                }
              >
                <div class="text-text-muted text-sm">
                  <span class="inline-block animate-pulse">Thinking...</span>
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
              class="w-full px-2 py-1.5 bg-bg border border-border text-sm text-text placeholder:text-text-faint hover:border-text-faint focus:border-accent resize-none disabled:opacity-50 disabled:cursor-not-allowed"
              rows={2}
            />
            <div class="flex justify-between items-center">
              <div class="flex items-center gap-2">
                {/* Connection status */}
                <div class="flex items-center gap-1">
                  <div
                    class="w-1.5 h-1.5 rounded-full"
                    classList={{
                      "bg-success": chat.isConnected(),
                      "bg-warning": !!sessionId() && !chat.isConnected(),
                      "bg-text-faint": !sessionId(),
                    }}
                  />
                  <span class="text-[9px] text-text-faint">
                    {chat.isConnected() ? "Connected" : sessionId() ? "Reconnecting" : "Offline"}
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
                class="px-3 py-1 bg-accent text-black text-sm font-medium hover:bg-accent-bright disabled:opacity-30 disabled:cursor-not-allowed"
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
