import type { FileDiffMetadata } from "@pierre/diffs";
import { useParams } from "@solidjs/router";
import {
  type Resource,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onMount,
  onCleanup,
  createEffect,
  Show,
  Switch,
} from "solid-js";

import type {
  ReviewSession,
  ReviewSessionAnnotation,
  ReviewSessionResult,
} from "@better-review/shared";

import { ThemeToggle } from "../components/ThemeToggle";
import { Badge, Button, Card, Select, Textarea } from "../design-system";
import {
  DiffViewer,
  DEFAULT_DIFF_SETTINGS,
  getFileElementId,
  type DiffCommentDraft,
} from "../DiffViewer";
import { FileTreePanel } from "../FileTreePanel";
import { fetchWithApiAuth } from "../lib/apiAuth";
import { parseMarkdown } from "../lib/markdown";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithApiAuth(url, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as T;
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function normalizeSelectedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function statusVariant(
  status: ReviewSession["status"],
): "accent" | "success" | "warning" | "neutral" {
  if (status === "approved") return "success";
  if (status === "feedback") return "warning";
  if (status === "pending") return "accent";
  return "neutral";
}

function createAnnotationId(quote: string, comment: string): string {
  const seed = `${quote}:${comment}:${Date.now()}:${Math.random()}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return `review-annotation-${Math.abs(hash).toString(36)}`;
}

function annotationLocation(annotation: ReviewSessionAnnotation): {
  title: string;
  detail: string | null;
} {
  if (annotation.filePath) {
    if (annotation.startLine && annotation.endLine) {
      const range =
        annotation.startLine !== annotation.endLine
          ? `Lines ${annotation.startLine}-${annotation.endLine}`
          : `Line ${annotation.endLine}`;
      return { title: annotation.filePath, detail: range };
    }

    if (annotation.line) return { title: annotation.filePath, detail: `Line ${annotation.line}` };
    return { title: annotation.filePath, detail: "File note" };
  }

  if (annotation.kind === "line-range") return { title: "Line range", detail: null };
  if (annotation.kind === "file") return { title: "File note", detail: null };
  return { title: "Selection note", detail: null };
}

function annotationLabel(annotation: ReviewSessionAnnotation): string {
  const location = annotationLocation(annotation);
  return location.detail
    ? `${location.title}:${location.detail.replace("Line ", "")}`
    : location.title;
}

function annotationInlineCommentId(annotation: ReviewSessionAnnotation): number {
  let hash = 0;
  for (let i = 0; i < annotation.id.length; i += 1) {
    hash = (hash << 5) - hash + annotation.id.charCodeAt(i);
    hash |= 0;
  }
  return -Math.abs(hash || 1);
}

interface FloatingComposerPosition {
  top: number;
  left: number;
}

type ReviewSessionWithContext = ReviewSession & {
  prUrl?: string | null;
};

type SessionCommit = { sha: string; shortSha: string; subject: string };
type SessionDiffResponse = { rawPatch: string; headSha: string };

interface AgentReviewPanelVisibility {
  files: boolean;
  review: boolean;
}

const AGENT_REVIEW_PANELS_STORAGE_KEY = "agent-review-panel-visibility";
const AGENT_REVIEW_FOCUS_MODE_STORAGE_KEY = "agent-review-focus-mode";

function loadPanelVisibility(): AgentReviewPanelVisibility {
  try {
    const stored = localStorage.getItem(AGENT_REVIEW_PANELS_STORAGE_KEY);
    if (stored) {
      return { files: true, review: true, ...JSON.parse(stored) };
    }
  } catch {}

  return { files: true, review: true };
}

function savePanelVisibility(visibility: AgentReviewPanelVisibility): void {
  try {
    localStorage.setItem(AGENT_REVIEW_PANELS_STORAGE_KEY, JSON.stringify(visibility));
  } catch {}
}

function loadFocusMode(): boolean {
  try {
    return localStorage.getItem(AGENT_REVIEW_FOCUS_MODE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function saveFocusMode(enabled: boolean): void {
  try {
    localStorage.setItem(AGENT_REVIEW_FOCUS_MODE_STORAGE_KEY, String(enabled));
  } catch {}
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

export default function AgentReviewPage() {
  const params = useParams<{ sessionId: string }>();
  const [feedback, setFeedback] = createSignal("");
  const [annotationComment, setAnnotationComment] = createSignal("");
  const [draftQuote, setDraftQuote] = createSignal<string | null>(null);
  const [currentDiffVariantId, setCurrentDiffVariantId] = createSignal<string | null>(null);
  const [rangeBaseSha, setRangeBaseSha] = createSignal<string | null>(null);
  const [composerOpen, setComposerOpen] = createSignal(false);
  const [composerPosition, setComposerPosition] = createSignal<FloatingComposerPosition | null>(
    null,
  );
  const [annotations, setAnnotations] = createSignal<ReviewSessionAnnotation[]>([]);
  const [files, setFiles] = createSignal<FileDiffMetadata[]>([]);
  const [submitting, setSubmitting] = createSignal(false);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [resultVersion, setResultVersion] = createSignal(0);
  const [autoCloseCountdown, setAutoCloseCountdown] = createSignal<number | null>(null);
  const [panelVisibility, setPanelVisibility] =
    createSignal<AgentReviewPanelVisibility>(loadPanelVisibility());
  const [focusMode, setFocusMode] = createSignal(loadFocusMode());
  let contentRef: HTMLDivElement | undefined;
  let composerRef: HTMLDivElement | undefined;
  let composerTextareaRef: HTMLTextAreaElement | undefined;

  const [session, { refetch: refetchSession }] = createResource(async () =>
    fetchJson<ReviewSessionWithContext>(`/api/sessions/${encodeURIComponent(params.sessionId)}`),
  );

  const [result, { refetch: refetchResult }] = createResource(
    () => resultVersion(),
    async () => {
      const response = await fetchWithApiAuth(
        `/api/sessions/${encodeURIComponent(params.sessionId)}/result`,
      );
      if (response.status === 204 || response.status === 404) return null;
      if (!response.ok) {
        throw new Error(await response.text());
      }
      return (await response.json()) as ReviewSessionResult;
    },
  );

  const [commits] = createResource(
    () => (session()?.payload.kind === "diff" ? params.sessionId : null),
    async (sessionId) => {
      if (!sessionId) return [];
      const response = await fetchWithApiAuth(
        `/api/sessions/${encodeURIComponent(sessionId)}/commits`,
      );
      if (!response.ok) return [];
      const body = (await response.json()) as { commits: SessionCommit[] };
      return body.commits;
    },
  );

  const [rangeDiff] = createResource(rangeBaseSha, async (baseSha) => {
    const url = new URL(
      `/api/sessions/${encodeURIComponent(params.sessionId)}/diff`,
      window.location.origin,
    );
    url.searchParams.set("baseSha", baseSha);
    return fetchJson<SessionDiffResponse>(url.toString());
  });

  const renderedContent = createMemo(() => {
    const value = session();
    if (!value || value.payload.kind === "diff") return "";
    return parseMarkdown(value.payload.content ?? "");
  });

  const isDiffSession = createMemo(() => session()?.payload.kind === "diff");

  const showFilesPanel = createMemo(
    () => isDiffSession() && panelVisibility().files && !focusMode(),
  );

  const showReviewPanel = createMemo(() => panelVisibility().review && !focusMode());

  const togglePanel = (panel: keyof AgentReviewPanelVisibility) => {
    const next = {
      ...panelVisibility(),
      [panel]: !panelVisibility()[panel],
    };

    setPanelVisibility(next);
    savePanelVisibility(next);
  };

  const toggleFocusMode = () => {
    const next = !focusMode();
    setFocusMode(next);
    saveFocusMode(next);
  };

  const availableDiffVariants = createMemo(() => {
    const value = session();
    if (!value || value.payload.kind !== "diff") return [];
    return value.payload.variants ?? [];
  });

  const selectedDiffVariant = createMemo(() => {
    const value = session();
    if (!value || value.payload.kind !== "diff") return null;

    const variants = value.payload.variants ?? [];
    const selectedId = currentDiffVariantId() ?? value.payload.selectedVariantId;
    const selectedVariant = variants.find((variant) => variant.id === selectedId);

    if (selectedVariant) return selectedVariant;
    if (variants.length > 0) return variants[0] ?? null;

    return {
      id: "default",
      label: value.payload.label ?? "Diff",
      rawPatch: value.payload.rawPatch,
    };
  });

  const selectedRangeCommit = createMemo(
    () => commits()?.find((commit) => commit.sha === rangeBaseSha()) ?? null,
  );

  const diffLabel = createMemo(() => {
    const rangeCommit = selectedRangeCommit();
    if (rangeCommit) return `Since ${rangeCommit.shortSha}`;
    return selectedDiffVariant()?.label ?? undefined;
  });

  const activeVariantId = createMemo(() => {
    const baseSha = rangeBaseSha();
    const diff = rangeDiff();
    if (baseSha && diff?.headSha) return `commit-range:${baseSha}:${diff.headSha}`;
    return currentDiffVariantId();
  });

  const diffRawPatch = createMemo(() => {
    const baseSha = rangeBaseSha();
    if (baseSha) return rangeDiff()?.rawPatch ?? "";
    return selectedDiffVariant()?.rawPatch ?? "";
  });

  const inlineReviewComments = createMemo(() =>
    annotations()
      .filter((annotation) => annotation.filePath && (annotation.line ?? annotation.endLine))
      .map((annotation) => ({
        id: annotationInlineCommentId(annotation),
        node_id: annotation.id,
        path: annotation.filePath!,
        line: annotation.line ?? annotation.endLine ?? null,
        original_line: annotation.line ?? annotation.endLine ?? null,
        side: annotation.side ?? "RIGHT",
        body: annotation.comment,
        html_url: `#${annotation.id}`,
        user: {
          login: "You",
          avatar_url:
            "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23f59e0b'/%3E%3Ctext x='16' y='21' text-anchor='middle' font-family='system-ui,sans-serif' font-size='14' font-weight='700' fill='%23120f0b'%3EY%3C/text%3E%3C/svg%3E",
        },
        created_at: new Date(annotation.createdAt).toISOString(),
        canEdit: !result(),
      })),
  );

  const findAnnotationByInlineCommentId = (commentId: number) =>
    annotations().find((annotation) => annotationInlineCommentId(annotation) === commentId);

  const editInlineAnnotationComment = async (commentId: number, body: string) => {
    const annotation = findAnnotationByInlineCommentId(commentId);
    if (!annotation) return;
    updateAnnotation(annotation.id, body);
  };

  const deleteInlineAnnotationComment = async (commentId: number) => {
    const annotation = findAnnotationByInlineCommentId(commentId);
    if (!annotation) return;
    removeAnnotation(annotation.id);
  };

  const sessionPrUrl = createMemo(() => session()?.prUrl ?? null);

  createEffect(() => {
    const value = session();
    if (!value || value.payload.kind !== "diff") return;
    setCurrentDiffVariantId(
      value.payload.selectedVariantId ?? value.payload.variants?.[0]?.id ?? null,
    );
  });

  const scrollToFile = (fileName: string) => {
    const element = document.getElementById(getFileElementId(fileName));
    element?.scrollIntoView({ behavior: "instant", block: "start" });
  };

  const canSubmit = createMemo(() => !submitting() && !result());

  const dismissComposer = (clearSelection = true) => {
    setDraftQuote(null);
    setAnnotationComment("");
    setComposerOpen(false);
    setComposerPosition(null);
    if (clearSelection) {
      window.getSelection()?.removeAllRanges();
    }
  };

  const updateComposerFromSelection = () => {
    const root = contentRef;
    if (!root) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      dismissComposer(false);
      return;
    }

    const range = selection.getRangeAt(0);
    const commonAncestor = range.commonAncestorContainer;
    const anchorNode =
      commonAncestor.nodeType === Node.TEXT_NODE ? commonAncestor.parentNode : commonAncestor;

    if (!anchorNode || !root.contains(anchorNode)) {
      dismissComposer(false);
      return;
    }

    const selected = normalizeSelectedText(selection.toString());
    if (selected.length === 0) {
      dismissComposer(false);
      return;
    }

    const rect = range.getBoundingClientRect();
    const nextTop = Math.max(24, rect.bottom + 14);
    const nextLeft = Math.min(
      Math.max(24, rect.left + rect.width / 2 - 190),
      window.innerWidth - 400,
    );

    setDraftQuote(selected);
    setComposerOpen(true);
    setComposerPosition({
      top: nextTop,
      left: nextLeft,
    });

    queueMicrotask(() => {
      composerTextareaRef?.focus();
    });
  };

  const addAnnotation = () => {
    const quote = draftQuote();
    const comment = annotationComment().trim();
    if (!quote || comment.length === 0) return;

    const annotation: ReviewSessionAnnotation = {
      id: createAnnotationId(quote, comment),
      quote,
      comment,
      createdAt: Date.now(),
      kind: "selection",
    };

    setAnnotations((current) => [...current, annotation]);
    dismissComposer(true);
  };

  const captureSelection = () => {
    updateComposerFromSelection();
  };

  const clearDraftSelection = () => {
    dismissComposer(true);
  };

  const removeAnnotation = (annotationId: string) => {
    setAnnotations((current) => current.filter((annotation) => annotation.id !== annotationId));
  };

  const updateAnnotation = (annotationId: string, comment: string) => {
    setAnnotations((current) =>
      current.map((annotation) =>
        annotation.id === annotationId ? { ...annotation, comment } : annotation,
      ),
    );
  };

  const addDiffAnnotation = async ({
    filePath,
    body,
    side,
    startLine,
    endLine,
  }: DiffCommentDraft) => {
    const rangeLabel =
      startLine && endLine && startLine !== endLine
        ? `${filePath}:${startLine}-${endLine}`
        : `${filePath}:${endLine ?? startLine ?? 1}`;

    setAnnotations((current) => [
      ...current,
      {
        id: createAnnotationId(rangeLabel, body.trim()),
        quote: rangeLabel,
        comment: body.trim(),
        createdAt: Date.now(),
        kind: startLine && endLine ? (startLine === endLine ? "selection" : "line-range") : "file",
        filePath,
        line: endLine ?? startLine,
        startLine,
        endLine,
        side,
      },
    ]);

    return { success: true };
  };

  const submit = async (approved: boolean) => {
    const activeSession = session();
    if (!activeSession || !canSubmit()) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      await fetchJson<ReviewSessionResult>(
        `/api/sessions/${encodeURIComponent(activeSession.id)}/result`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            approved,
            feedback: feedback().trim(),
            annotations: annotations(),
          }),
        },
      );

      await Promise.all([refetchSession(), refetchResult()]);
      setResultVersion((value) => value + 1);
      setAutoCloseCountdown(3);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to submit review");
    } finally {
      setSubmitting(false);
    }
  };

  createEffect(() => {
    const countdown = autoCloseCountdown();
    if (countdown === null) return;

    if (countdown <= 0) {
      window.close();
      return;
    }

    const timer = setTimeout(() => setAutoCloseCountdown(countdown - 1), 1000);
    onCleanup(() => clearTimeout(timer));
  });

  const handlePointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (composerRef?.contains(target)) return;
    if (contentRef?.contains(target)) return;
    dismissComposer(false);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (
      event.key.toLowerCase() === "f" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !isEditableTarget(event.target)
    ) {
      event.preventDefault();
      toggleFocusMode();
      return;
    }

    if (event.key === "Escape" && (composerOpen() || draftQuote())) {
      event.preventDefault();
      dismissComposer(true);
      return;
    }

    if (event.key === "Escape" && focusMode()) {
      event.preventDefault();
      toggleFocusMode();
    }
  };

  onMount(() => {
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", clearDraftSelection);
  });

  onCleanup(() => {
    document.removeEventListener("pointerdown", handlePointerDown);
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("resize", clearDraftSelection);
  });

  return (
    <div class="min-h-screen bg-bg text-text">
      <Show
        when={session()}
        fallback={
          <div class="mx-auto mt-20 max-w-3xl">
            <Card>
              <div class="text-sm text-text-faint">Loading review session...</div>
            </Card>
          </div>
        }
      >
        {(loadedSession) => (
          <div class="flex flex-col h-screen">
            <Show when={!focusMode()}>
              <header class="border-b border-border bg-bg-surface flex-shrink-0">
                <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div class="flex items-center gap-3 min-w-0">
                    <h1 class="text-sm text-text truncate">{loadedSession().title}</h1>
                    <Badge variant={statusVariant(loadedSession().status)}>
                      {loadedSession().status}
                    </Badge>
                    <Badge variant="neutral">{loadedSession().mode}</Badge>
                  </div>
                  <div class="flex flex-wrap items-center justify-end gap-3 text-xs text-text-faint flex-shrink-0">
                    <div class="flex items-center gap-1 border-r border-border pr-3">
                      <Show when={isDiffSession()}>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          class={panelVisibility().files ? "border-primary/50" : "text-text-faint"}
                          title="Toggle file panel"
                          onClick={() => togglePanel("files")}
                        >
                          Files
                        </Button>
                      </Show>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        class={panelVisibility().review ? "border-primary/50" : "text-text-faint"}
                        title="Toggle review panel"
                        onClick={() => togglePanel("review")}
                      >
                        Review
                      </Button>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      title="Enter focus mode (F)"
                      onClick={toggleFocusMode}
                    >
                      Focus
                    </Button>
                    <span>Created {formatTimestamp(loadedSession().createdAt)}</span>
                    <span class="text-text-faint">·</span>
                    <span>{loadedSession().origin}</span>
                    <Show when={loadedSession().cwd}>
                      {(cwd) => (
                        <>
                          <span class="text-text-faint">·</span>
                          <span class="truncate max-w-48">{cwd()}</span>
                        </>
                      )}
                    </Show>
                    <ThemeToggle />
                  </div>
                </div>
              </header>
            </Show>

            <Show when={focusMode()}>
              <div class="flex items-center justify-between px-3 py-1.5 bg-bg-surface border-b border-accent/30 flex-shrink-0">
                <div class="flex items-center gap-2">
                  <span class="text-[10px] text-accent font-mono uppercase tracking-wide">
                    Focus mode
                  </span>
                  <span class="text-xs text-text-faint">
                    Side panels hidden. Press Esc or F to exit.
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  class="text-accent hover:text-accent"
                  title="Exit focus mode (F or Esc)"
                  onClick={toggleFocusMode}
                >
                  Exit <span class="text-accent/60 ml-1 font-mono">F</span>
                </Button>
              </div>
            </Show>

            <Show when={isDiffSession()}>
              <div class="flex flex-1 min-h-0">
                <Show when={showFilesPanel()}>
                  <div class="shrink-0 border-r border-border">
                    <FileTreePanel files={files()} onFileSelect={scrollToFile} />
                  </div>
                </Show>

                <div class="flex-1 min-w-0 flex flex-col">
                  <Show when={availableDiffVariants().length > 0 || (commits()?.length ?? 0) > 0}>
                    <div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 bg-bg-surface shrink-0">
                      <Show when={availableDiffVariants().length > 0}>
                        <Select
                          compact
                          value={currentDiffVariantId() ?? ""}
                          disabled={Boolean(rangeBaseSha())}
                          onInput={(event) => setCurrentDiffVariantId(event.currentTarget.value)}
                        >
                          <For each={availableDiffVariants()}>
                            {(variant) => <option value={variant.id}>{variant.label}</option>}
                          </For>
                        </Select>
                      </Show>
                      <Select
                        compact
                        value={rangeBaseSha() ?? ""}
                        title="Review changes since this commit"
                        onInput={(event) =>
                          setRangeBaseSha(event.currentTarget.value.trim() || null)
                        }
                      >
                        <option value="">Review original diff</option>
                        <For each={commits() ?? []}>
                          {(commit) => (
                            <option value={commit.sha}>
                              Since {commit.shortSha} — {commit.subject}
                            </option>
                          )}
                        </For>
                      </Select>
                      <Show when={rangeDiff.loading}>
                        <span class="text-xs text-text-faint">Loading diff...</span>
                      </Show>
                      <Show when={diffLabel()}>
                        {(label) => <Badge variant="accent">{label()}</Badge>}
                      </Show>
                    </div>
                  </Show>

                  <div class="flex-1 min-h-0 flex">
                    <div
                      ref={(element) => {
                        contentRef = element;
                      }}
                      class="flex-1 overflow-auto"
                    >
                      <DiffViewer
                        rawDiff={diffRawPatch()}
                        comments={inlineReviewComments()}
                        settings={DEFAULT_DIFF_SETTINGS}
                        onFilesLoaded={setFiles}
                        onAddComment={addDiffAnnotation}
                        onReplyToComment={async () => ({ success: true })}
                        onEditComment={editInlineAnnotationComment}
                        onDeleteComment={deleteInlineAnnotationComment}
                        sessionId={params.sessionId}
                        variantId={activeVariantId()}
                        prUrl={sessionPrUrl()}
                      />
                    </div>

                    <Show when={showReviewPanel()}>
                      <div class="w-72 flex-shrink-0 border-l border-border flex flex-col bg-bg-surface">
                        <div class="flex-1 overflow-y-auto">
                          <AnnotationsPanel
                            annotations={annotations()}
                            result={result}
                            isDiffSession={true}
                            onRemove={removeAnnotation}
                            onUpdate={updateAnnotation}
                            onNavigate={(annotation) => {
                              if (annotation.filePath) scrollToFile(annotation.filePath);
                            }}
                          />
                        </div>
                        <div class="border-t border-border flex-shrink-0">
                          <SubmitBar
                            feedback={feedback()}
                            setFeedback={setFeedback}
                            submitting={submitting()}
                            submitError={submitError()}
                            canSubmit={canSubmit()}
                            result={result}
                            onSubmit={submit}
                            autoCloseCountdown={autoCloseCountdown()}
                          />
                        </div>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
            </Show>

            <Show when={!isDiffSession()}>
              <div class="flex flex-1 min-h-0">
                <div class="flex-1 min-w-0 overflow-auto">
                  <div
                    ref={(element) => {
                      contentRef = element;
                    }}
                    class="mx-auto max-w-4xl px-6 py-6"
                    onMouseUp={captureSelection}
                    onKeyUp={captureSelection}
                  >
                    <div
                      class="markdown-content px-1 text-sm leading-7 text-text [&_blockquote]:bg-accent/5 [&_blockquote]:py-2 [&_blockquote]:pr-4 [&_h1]:text-lg [&_h1]:font-medium [&_h2]:text-base [&_h3]:text-sm [&_pre]:border [&_pre]:border-border [&_pre]:bg-bg-surface [&_pre]:p-3"
                      innerHTML={renderedContent()}
                    />
                  </div>
                </div>

                <Show when={showReviewPanel()}>
                  <div class="w-72 flex-shrink-0 border-l border-border flex flex-col bg-bg-surface">
                    <div class="flex-1 overflow-y-auto">
                      <AnnotationsPanel
                        annotations={annotations()}
                        result={result}
                        isDiffSession={false}
                        onRemove={removeAnnotation}
                        onUpdate={updateAnnotation}
                      />
                    </div>
                    <div class="border-t border-border flex-shrink-0">
                      <SubmitBar
                        feedback={feedback()}
                        setFeedback={setFeedback}
                        submitting={submitting()}
                        submitError={submitError()}
                        canSubmit={canSubmit()}
                        result={result}
                        onSubmit={submit}
                        autoCloseCountdown={autoCloseCountdown()}
                      />
                    </div>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={!isDiffSession() && draftQuote() && composerOpen()}>
        {(quote) => (
          <Show when={composerPosition()}>
            {(position) => (
              <div
                ref={(element) => {
                  composerRef = element;
                  return undefined;
                }}
                class="fixed z-50 w-[min(380px,calc(100vw-2rem))] border border-accent/30 bg-bg shadow-lg"
                style={{
                  top: `${position().top}px`,
                  left: `${position().left}px`,
                }}
              >
                <div class="border-b border-accent/20 bg-accent/5 px-4 py-3">
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-xs text-accent">Attach Note</div>
                    <div class="text-xs text-text-faint">Cmd/Ctrl+Enter to save</div>
                  </div>
                </div>
                <div class="space-y-3 px-4 py-4">
                  <blockquote class="m-0 bg-accent/5 px-3 py-2 text-sm text-text">
                    {quote()}
                  </blockquote>
                  <Textarea
                    ref={(element) => {
                      composerTextareaRef = element;
                    }}
                    value={annotationComment()}
                    onInput={(event) => setAnnotationComment(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        addAnnotation();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        clearDraftSelection();
                      }
                    }}
                    placeholder="Attach a comment to this selection..."
                    class="min-h-24"
                  />
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-xs text-text-faint">Esc to cancel</div>
                    <div class="flex gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={clearDraftSelection}>
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={annotationComment().trim().length === 0}
                        onClick={addAnnotation}
                      >
                        Save Note
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </Show>
        )}
      </Show>
    </div>
  );
}

function AnnotationsPanel(props: {
  annotations: ReviewSessionAnnotation[];
  result: Resource<ReviewSessionResult | null>;
  isDiffSession: boolean;
  onRemove: (id: string) => void;
  onUpdate: (id: string, comment: string) => void;
  onNavigate?: (annotation: ReviewSessionAnnotation) => void;
}) {
  const items = () => props.result()?.annotations ?? props.annotations;
  const [annotationsHidden, setAnnotationsHidden] = createSignal(false);
  const [editingAnnotationId, setEditingAnnotationId] = createSignal<string | null>(null);
  const [editingComment, setEditingComment] = createSignal("");

  const startEditing = (annotation: ReviewSessionAnnotation) => {
    setEditingAnnotationId(annotation.id);
    setEditingComment(annotation.comment);
  };

  const cancelEditing = () => {
    setEditingAnnotationId(null);
    setEditingComment("");
  };

  const saveEditing = () => {
    const annotationId = editingAnnotationId();
    const comment = editingComment().trim();
    if (!annotationId || comment.length === 0) return;
    props.onUpdate(annotationId, comment);
    cancelEditing();
  };

  return (
    <div class="p-3 space-y-3">
      <div class="flex items-center justify-between gap-2 text-xs text-text-faint">
        <span>
          {items().length} annotation{items().length === 1 ? "" : "s"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={items().length === 0}
          onClick={() => setAnnotationsHidden((hidden) => !hidden)}
          title={
            annotationsHidden()
              ? "Show all comments and annotations"
              : "Hide all comments and annotations"
          }
        >
          {annotationsHidden() ? "Show all" : "Hide all"}
        </Button>
      </div>

      <Show
        when={!annotationsHidden()}
        fallback={
          <div class="border border-border border-dashed px-3 py-4 text-center text-xs text-text-faint">
            All comments and annotations are hidden.
          </div>
        }
      >
        <Show
          when={items().length > 0}
          fallback={
            <div class="text-xs text-text-faint py-3">
              {props.isDiffSession
                ? "Add comments on lines as you review."
                : "Highlight text to attach notes."}
            </div>
          }
        >
          <div class="space-y-2">
            <For each={items()}>
              {(annotation) => {
                const location = () => annotationLocation(annotation);
                return (
                  <div id={annotation.id} class="border border-border bg-bg p-3">
                    <div class="flex items-start justify-between gap-2">
                      <div class="min-w-0 flex-1 text-left">
                        <button
                          type="button"
                          class="flex min-w-0 max-w-full items-baseline gap-2 text-left disabled:cursor-default"
                          onClick={() => props.onNavigate?.(annotation)}
                          disabled={!props.onNavigate}
                          title={
                            annotation.filePath ? `Go to ${annotationLabel(annotation)}` : undefined
                          }
                        >
                          <span
                            class="truncate font-mono text-[11px] text-text"
                            title={location().title}
                          >
                            {location().title}
                          </span>
                          <Show when={location().detail}>
                            {(detail) => (
                              <span class="shrink-0 text-[11px] text-text-faint">{detail()}</span>
                            )}
                          </Show>
                        </button>
                        <Show
                          when={editingAnnotationId() === annotation.id}
                          fallback={
                            <p class="m-0 mt-2 whitespace-pre-wrap text-xs leading-5 text-text">
                              {annotation.comment}
                            </p>
                          }
                        >
                          <Textarea
                            value={editingComment()}
                            onInput={(event) => setEditingComment(event.currentTarget.value)}
                            onKeyDown={(event) => {
                              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                                event.preventDefault();
                                saveEditing();
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                cancelEditing();
                              }
                            }}
                            class="mt-2 min-h-20 text-xs"
                            onClick={(event) => event.stopPropagation()}
                          />
                        </Show>
                        <blockquote class="m-0 mt-2 line-clamp-3 border-l border-border pl-2 text-[11px] leading-4 text-text-faint">
                          {annotation.quote}
                        </blockquote>
                      </div>
                      <Show when={!props.result()}>
                        <div class="flex shrink-0 flex-col gap-1">
                          <Show
                            when={editingAnnotationId() === annotation.id}
                            fallback={
                              <>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => startEditing(annotation)}
                                  title="Edit annotation"
                                >
                                  Edit
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => props.onRemove(annotation.id)}
                                  title="Remove annotation"
                                >
                                  ×
                                </Button>
                              </>
                            }
                          >
                            <Button
                              type="button"
                              variant="primary"
                              size="xs"
                              disabled={editingComment().trim().length === 0}
                              onClick={saveEditing}
                              title="Save annotation"
                            >
                              Save
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              onClick={cancelEditing}
                              title="Cancel editing"
                            >
                              Cancel
                            </Button>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}

function SubmitBar(props: {
  feedback: string;
  setFeedback: (v: string) => void;
  submitting: boolean;
  submitError: string | null;
  canSubmit: boolean;
  result: Resource<ReviewSessionResult | null>;
  onSubmit: (approved: boolean) => void;
  autoCloseCountdown: number | null;
}) {
  return (
    <Switch>
      <Match when={props.result.loading}>
        <div class="px-4 py-3 text-sm text-text-faint">Loading existing result...</div>
      </Match>
      <Match when={props.result()}>
        {(existingResult) => (
          <div class="px-4 py-3 space-y-2">
            <div class="flex items-center gap-3">
              <Badge variant={existingResult().approved ? "success" : "warning"}>
                {existingResult().approved ? "Approved" : "Changes Requested"}
              </Badge>
              <span class="text-xs text-text-faint">
                Submitted {formatTimestamp(existingResult().submittedAt)}
              </span>
            </div>
            <p class="text-sm text-text-muted">
              Review submitted. The CLI should continue now. You can close this tab.
            </p>
            <Show when={props.autoCloseCountdown !== null}>
              <p class="text-xs text-text-faint">Closing in {props.autoCloseCountdown}s...</p>
            </Show>
          </div>
        )}
      </Match>
      <Match when={true}>
        <div class="space-y-3 px-4 py-3">
          <Show when={props.result.error}>
            <div class="border border-error/50 bg-error/10 px-3 py-2 text-sm text-error">
              {props.result.error?.message}
            </div>
          </Show>

          <Textarea
            value={props.feedback}
            onInput={(event) => props.setFeedback(event.currentTarget.value)}
            placeholder="Write your verdict..."
            class="min-h-20"
          />

          <Show when={props.submitError}>
            <div class="border border-error/50 bg-error/10 px-3 py-2 text-sm text-error">
              {props.submitError}
            </div>
          </Show>

          <div class="flex gap-2">
            <Button
              type="button"
              variant="success"
              size="sm"
              disabled={!props.canSubmit}
              onClick={() => void props.onSubmit(true)}
            >
              {props.submitting ? "Submitting..." : "Approve"}
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={!props.canSubmit}
              onClick={() => void props.onSubmit(false)}
            >
              {props.submitting ? "Submitting..." : "Request Changes"}
            </Button>
          </div>
        </div>
      </Match>
    </Switch>
  );
}
