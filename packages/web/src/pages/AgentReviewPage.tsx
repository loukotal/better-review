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

import { Badge, Button, Card, Select, Textarea } from "../design-system";
import { cn } from "../design-system/cn";
import {
  DiffViewer,
  DEFAULT_DIFF_SETTINGS,
  getFileElementId,
  type DiffCommentDraft,
} from "../DiffViewer";
import { FileTreePanel } from "../FileTreePanel";
import { PlusIcon } from "../icons/plus-icon";
import { parseMarkdown } from "../lib/markdown";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
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

function annotationLabel(annotation: ReviewSessionAnnotation): string {
  if (annotation.filePath && annotation.startLine && annotation.endLine) {
    if (annotation.startLine !== annotation.endLine) {
      return `${annotation.filePath}:${annotation.startLine}-${annotation.endLine}`;
    }

    return `${annotation.filePath}:${annotation.endLine}`;
  }

  if (annotation.filePath && annotation.line) {
    return `${annotation.filePath}:${annotation.line}`;
  }

  if (annotation.filePath) {
    return annotation.filePath;
  }

  if (annotation.kind === "line-range") return "Line range";
  if (annotation.kind === "file") return "File note";
  return "Selection note";
}

interface FloatingComposerPosition {
  top: number;
  left: number;
}

type ReviewSessionWithContext = ReviewSession & {
  prUrl?: string | null;
};

export default function AgentReviewPage() {
  const params = useParams<{ sessionId: string }>();
  const [feedback, setFeedback] = createSignal("");
  const [annotationComment, setAnnotationComment] = createSignal("");
  const [draftQuote, setDraftQuote] = createSignal<string | null>(null);
  const [currentDiffVariantId, setCurrentDiffVariantId] = createSignal<string | null>(null);
  const [composerOpen, setComposerOpen] = createSignal(false);
  const [composerPosition, setComposerPosition] = createSignal<FloatingComposerPosition | null>(
    null,
  );
  const [annotations, setAnnotations] = createSignal<ReviewSessionAnnotation[]>([]);
  const [files, setFiles] = createSignal<FileDiffMetadata[]>([]);
  const [submitting, setSubmitting] = createSignal(false);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [resultVersion, setResultVersion] = createSignal(0);
  let contentRef: HTMLDivElement | undefined;
  let composerRef: HTMLDivElement | undefined;
  let composerTextareaRef: HTMLTextAreaElement | undefined;

  const [session, { refetch: refetchSession }] = createResource(async () =>
    fetchJson<ReviewSessionWithContext>(`/api/sessions/${encodeURIComponent(params.sessionId)}`),
  );

  const [result, { refetch: refetchResult }] = createResource(
    () => resultVersion(),
    async () => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(params.sessionId)}/result`);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(await response.text());
      }
      return (await response.json()) as ReviewSessionResult;
    },
  );

  const renderedContent = createMemo(() => {
    const value = session();
    if (!value) return "";

    if (value.payload.kind === "diff") {
      return `<pre><code>${value.payload.rawPatch
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</code></pre>`;
    }

    return parseMarkdown(value.payload.content ?? "");
  });

  const isDiffSession = createMemo(() => session()?.payload.kind === "diff");

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

  const diffLabel = createMemo(() => selectedDiffVariant()?.label ?? undefined);

  const diffRawPatch = createMemo(() => selectedDiffVariant()?.rawPatch ?? "");

  const annotationCount = createMemo(() => annotations().length);
  const sessionPrUrl = createMemo(() => session()?.prUrl ?? null);

  const contentHeading = createMemo(() => {
    if (isDiffSession()) return diffLabel() ?? "Patch under review";
    return "Agent output";
  });

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

  createEffect(() => {
    const existingResult = result();
    if (!existingResult) return;

    const timeout = window.setTimeout(() => {
      window.close();
    }, 1000);

    onCleanup(() => {
      window.clearTimeout(timeout);
    });
  });

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
      Math.max(24, rect.left + rect.width / 2 - 80),
      window.innerWidth - 180,
    );

    setDraftQuote(selected);
    setComposerOpen(false);
    setComposerPosition({
      top: nextTop,
      left: nextLeft,
    });
  };

  const captureSelection = () => {
    updateComposerFromSelection();
  };

  const clearDraftSelection = () => {
    dismissComposer(true);
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

  const openComposer = () => {
    const position = composerPosition();
    if (!position) return;

    setComposerOpen(true);
    setComposerPosition({
      top: position.top,
      left: Math.min(Math.max(24, position.left - 100), window.innerWidth - 384),
    });

    queueMicrotask(() => {
      composerTextareaRef?.focus();
    });
  };

  const removeAnnotation = (annotationId: string) => {
    setAnnotations((current) => current.filter((annotation) => annotation.id !== annotationId));
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
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to submit review");
    } finally {
      setSubmitting(false);
    }
  };

  const handlePointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (composerRef?.contains(target)) return;
    if (contentRef?.contains(target)) return;
    dismissComposer(false);
  };

  const handleEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      dismissComposer(true);
    }
  };

  onMount(() => {
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", clearDraftSelection);
  });

  onCleanup(() => {
    document.removeEventListener("pointerdown", handlePointerDown);
    window.removeEventListener("keydown", handleEscape);
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
          <div class="flex flex-col" classList={{ "h-screen": isDiffSession() }}>
            <header class="border-b border-border bg-bg-surface flex-shrink-0">
              <div class="flex items-center justify-between gap-4 px-4 py-3">
                <div class="flex items-center gap-3 min-w-0">
                  <h1 class="text-sm text-text truncate">{loadedSession().title}</h1>
                  <Badge variant={statusVariant(loadedSession().status)}>
                    {loadedSession().status}
                  </Badge>
                  <Badge variant="neutral">{loadedSession().mode}</Badge>
                </div>
                <div class="flex items-center gap-3 text-xs text-text-faint flex-shrink-0">
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
                </div>
              </div>
            </header>

            <Show when={isDiffSession()}>
              <div class="flex flex-1 min-h-0">
                <div class="shrink-0 border-r border-border">
                  <FileTreePanel files={files()} onFileSelect={scrollToFile} />
                </div>

                <div class="flex-1 min-w-0 flex flex-col">
                  <Show when={availableDiffVariants().length > 0}>
                    <div class="flex items-center gap-2 border-b border-border px-3 py-2 bg-bg-surface shrink-0">
                      <Select
                        compact
                        value={currentDiffVariantId() ?? ""}
                        onInput={(event) => setCurrentDiffVariantId(event.currentTarget.value)}
                      >
                        <For each={availableDiffVariants()}>
                          {(variant) => <option value={variant.id}>{variant.label}</option>}
                        </For>
                      </Select>
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
                        comments={[]}
                        settings={DEFAULT_DIFF_SETTINGS}
                        onFilesLoaded={setFiles}
                        onAddComment={addDiffAnnotation}
                        onReplyToComment={async () => ({ success: true })}
                        onEditComment={async () => ({ success: true })}
                        onDeleteComment={async () => ({ success: true })}
                        sessionId={params.sessionId}
                        variantId={currentDiffVariantId()}
                        prUrl={sessionPrUrl()}
                      />
                    </div>

                    <div class="w-72 flex-shrink-0 border-l border-border flex flex-col bg-bg-surface">
                      <div class="flex-1 overflow-y-auto">
                        <AnnotationsPanel
                          annotations={annotations()}
                          result={result}
                          isDiffSession={true}
                          onRemove={removeAnnotation}
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
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Show>

            <Show when={!isDiffSession()}>
              <div class="mx-auto w-full max-w-4xl px-6 py-6 space-y-4">
                <Card padding="sm">
                  <div
                    ref={(element) => {
                      contentRef = element;
                    }}
                    class="max-h-[calc(100vh-24rem)] overflow-auto px-3 py-3"
                    onMouseUp={captureSelection}
                    onKeyUp={captureSelection}
                  >
                    <div
                      class="markdown-content px-1 text-sm leading-7 text-text [&_blockquote]:border-l-2 [&_blockquote]:border-accent [&_blockquote]:bg-accent/5 [&_blockquote]:py-2 [&_blockquote]:pr-4 [&_h1]:text-lg [&_h1]:font-medium [&_h2]:text-base [&_h3]:text-sm [&_pre]:border [&_pre]:border-border [&_pre]:bg-bg-surface [&_pre]:p-3"
                      innerHTML={renderedContent()}
                    />
                  </div>
                </Card>

                <AnnotationsPanel
                  annotations={annotations()}
                  result={result}
                  isDiffSession={false}
                  onRemove={removeAnnotation}
                />

                <Card>
                  <SubmitBar
                    feedback={feedback()}
                    setFeedback={setFeedback}
                    submitting={submitting()}
                    submitError={submitError()}
                    canSubmit={canSubmit()}
                    result={result}
                    onSubmit={submit}
                  />
                </Card>
              </div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={!isDiffSession() && draftQuote() && !composerOpen()}>
        {(quote) => (
          <Show when={composerPosition()}>
            {(position) => (
              <div
                ref={(element) => {
                  composerRef = element;
                  return undefined;
                }}
                class="fixed z-50 flex items-center gap-2 border border-accent/30 bg-bg px-3 py-2 shadow-lg"
                style={{
                  top: `${position().top}px`,
                  left: `${position().left}px`,
                }}
              >
                <div class="text-xs text-accent">Quote captured</div>
                <button
                  type="button"
                  onClick={openComposer}
                  title="Add annotation"
                  class="inline-flex h-7 w-7 items-center justify-center border border-primary/50 bg-primary text-text transition-colors hover:bg-primary-hover"
                >
                  <PlusIcon size={12} />
                </button>
                <div class="max-w-44 truncate text-xs text-text-muted">{quote()}</div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  class="px-1"
                  onClick={clearDraftSelection}
                >
                  ×
                </Button>
              </div>
            )}
          </Show>
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
                  <blockquote class="m-0 border-l-2 border-accent bg-accent/5 px-3 py-2 text-sm text-text">
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
}) {
  const items = () => props.result()?.annotations ?? props.annotations;

  return (
    <div class="p-3 space-y-3">
      <div class="text-xs text-text-faint">
        {items().length} annotation{items().length === 1 ? "" : "s"}
      </div>

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
            {(annotation) => (
              <div class="border border-border p-3">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0 flex-1">
                    <div class="text-xs text-text-faint">{annotationLabel(annotation)}</div>
                    <blockquote class="m-0 mt-1.5 border-l-2 border-accent/60 pl-2 text-xs text-text">
                      {annotation.quote}
                    </blockquote>
                    <p class="m-0 mt-1.5 whitespace-pre-wrap text-xs text-text-muted">
                      {annotation.comment}
                    </p>
                  </div>
                  <Show when={!props.result()}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => props.onRemove(annotation.id)}
                    >
                      ×
                    </Button>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
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
