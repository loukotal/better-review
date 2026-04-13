import type { FileDiffMetadata } from "@pierre/diffs";
import { useParams } from "@solidjs/router";
import {
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

import { Badge, Button, Card, Textarea } from "../design-system";
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

interface FloatingComposerPosition {
  top: number;
  left: number;
}

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
    fetchJson<ReviewSession>(`/api/sessions/${encodeURIComponent(params.sessionId)}`),
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
    }, 300);

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
      <div class="w-full px-6 py-8">
        <Show
          when={session()}
          fallback={
            <Card class="max-w-2xl mx-auto mt-24">
              <div class="text-sm text-text-muted">Loading review session...</div>
            </Card>
          }
        >
          {(loadedSession) => (
            <div
              class={
                isDiffSession()
                  ? "grid gap-6 xl:grid-cols-[220px_minmax(0,1fr)_360px]"
                  : "grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]"
              }
            >
              <Show when={isDiffSession()}>
                <FileTreePanel files={files()} onFileSelect={scrollToFile} />
              </Show>

              <div class="space-y-4">
                <div class="flex flex-wrap items-center gap-3">
                  <Badge variant={statusVariant(loadedSession().status)}>
                    {loadedSession().status}
                  </Badge>
                  <Badge variant="neutral">{loadedSession().mode}</Badge>
                  <span class="text-xs text-text-faint">
                    Created {formatTimestamp(loadedSession().createdAt)}
                  </span>
                </div>

                <div>
                  <h1 class="m-0 text-2xl text-text">{loadedSession().title}</h1>
                  <div class="mt-2 text-sm text-text-muted">
                    Origin: {loadedSession().origin}
                    <Show when={loadedSession().cwd}>{(cwd) => <span> • cwd: {cwd()}</span>}</Show>
                  </div>
                </div>

                <Show when={isDiffSession() && availableDiffVariants().length > 0}>
                  <div class="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-bg-muted/40 px-3 py-3">
                    <label class="flex min-w-64 flex-col gap-1 text-sm text-text">
                      <span class="text-xs uppercase tracking-[0.2em] text-text-faint">
                        Review scope
                      </span>
                      <select
                        class="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text"
                        value={currentDiffVariantId() ?? ""}
                        onInput={(event) => setCurrentDiffVariantId(event.currentTarget.value)}
                      >
                        <For each={availableDiffVariants()}>
                          {(variant) => <option value={variant.id}>{variant.label}</option>}
                        </For>
                      </select>
                    </label>
                    <Show when={selectedDiffVariant()?.description}>
                      {(description) => <div class="text-xs text-text-muted">{description()}</div>}
                    </Show>
                    <Show when={diffLabel()}>
                      {(label) => <Badge variant="accent">{label()}</Badge>}
                    </Show>
                  </div>
                </Show>

                <div
                  ref={(element) => {
                    contentRef = element;
                  }}
                  class="max-h-[78vh] overflow-auto"
                  onMouseUp={captureSelection}
                  onKeyUp={captureSelection}
                >
                  <Show
                    when={isDiffSession()}
                    fallback={
                      <div
                        class="markdown-content px-1 text-sm leading-7"
                        innerHTML={renderedContent()}
                      />
                    }
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
                    />
                  </Show>
                </div>
              </div>

              <div class="space-y-4">
                <Card>
                  <div class="mb-3 text-sm text-text">Review Outcome</div>

                  <Show when={result.error}>
                    <div class="mb-3 border border-error/50 bg-error/10 px-3 py-2 text-sm text-error">
                      {result.error?.message}
                    </div>
                  </Show>

                  <Switch>
                    <Match when={result.loading}>
                      <div class="text-sm text-text-muted">Loading existing result...</div>
                    </Match>
                    <Match when={result()}>
                      {(existingResult) => (
                        <div class="space-y-3">
                          <Badge variant={existingResult().approved ? "success" : "warning"}>
                            {existingResult().approved ? "Approved" : "Changes Requested"}
                          </Badge>
                          <div class="border border-accent/30 bg-accent/8 px-3 py-3 text-sm text-text">
                            Review submitted. The CLI should continue now. You can close this tab.
                          </div>
                          <div class="text-xs text-text-faint">
                            Submitted {formatTimestamp(existingResult().submittedAt)}
                          </div>
                          <pre class="m-0 overflow-auto border border-border bg-bg px-3 py-3 text-sm text-text whitespace-pre-wrap">
                            {existingResult().feedback || "(no feedback)"}
                          </pre>
                          <Show when={existingResult().annotations.length > 0}>
                            <div class="space-y-2">
                              <div class="text-xs uppercase tracking-[0.2em] text-text-faint">
                                Annotations
                              </div>
                              <For each={existingResult().annotations}>
                                {(annotation) => (
                                  <div class="border border-border bg-bg px-3 py-3">
                                    <blockquote class="m-0 border-l-2 border-accent/60 pl-3 text-sm text-text">
                                      {annotation.quote}
                                    </blockquote>
                                    <p class="mb-0 mt-2 whitespace-pre-wrap text-sm text-text-muted">
                                      {annotation.comment}
                                    </p>
                                  </div>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      )}
                    </Match>
                    <Match when={true}>
                      <div class="space-y-3">
                        <Textarea
                          value={feedback()}
                          onInput={(event) => setFeedback(event.currentTarget.value)}
                          placeholder="Summarize approval or request changes..."
                          class="min-h-40"
                        />

                        <Card class="space-y-3 bg-bg">
                          <div class="flex items-center justify-between gap-2">
                            <div class="text-sm text-text">Annotations</div>
                            <span class="text-xs text-text-faint">
                              Select text to open the floating composer
                            </span>
                          </div>

                          <Show
                            when={annotations().length > 0}
                            fallback={
                              <div class="border border-dashed border-border px-3 py-3 text-sm text-text-faint">
                                No annotations yet.
                              </div>
                            }
                          >
                            <div class="space-y-2">
                              <For each={annotations()}>
                                {(annotation) => (
                                  <div class="border border-border bg-bg-surface/40 px-3 py-3">
                                    <div class="flex items-start justify-between gap-3">
                                      <div class="min-w-0 flex-1">
                                        <blockquote class="m-0 border-l-2 border-accent/60 pl-3 text-sm text-text">
                                          {annotation.quote}
                                        </blockquote>
                                        <p class="mb-0 mt-2 whitespace-pre-wrap text-sm text-text-muted">
                                          {annotation.comment}
                                        </p>
                                      </div>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="xs"
                                        onClick={() => removeAnnotation(annotation.id)}
                                      >
                                        Remove
                                      </Button>
                                    </div>
                                  </div>
                                )}
                              </For>
                            </div>
                          </Show>
                        </Card>

                        <Show when={submitError()}>
                          <div class="border border-error/50 bg-error/10 px-3 py-2 text-sm text-error">
                            {submitError()}
                          </div>
                        </Show>

                        <div class="flex gap-2">
                          <Button
                            type="button"
                            variant="success"
                            size="md"
                            disabled={!canSubmit()}
                            onClick={() => void submit(true)}
                          >
                            {submitting() ? "Submitting..." : "Approve"}
                          </Button>
                          <Button
                            type="button"
                            variant="danger"
                            size="md"
                            disabled={!canSubmit()}
                            onClick={() => void submit(false)}
                          >
                            {submitting() ? "Submitting..." : "Request Changes"}
                          </Button>
                        </div>
                      </div>
                    </Match>
                  </Switch>
                </Card>

                <Card>
                  <div class="mb-2 text-sm text-text">Session</div>
                  <div class="space-y-1 text-xs text-text-faint">
                    <div>ID: {loadedSession().id}</div>
                    <Show when={loadedSession().repoRoot}>
                      {(repoRoot) => <div>Repo: {repoRoot()}</div>}
                    </Show>
                    <Show when={diffLabel()}>{(label) => <div>Label: {label()}</div>}</Show>
                  </div>
                </Card>
              </div>
            </div>
          )}
        </Show>
      </div>
      <Show when={!isDiffSession() && draftQuote() && !composerOpen()}>
        {(quote) => (
          <Show when={composerPosition()}>
            {(position) => (
              <div
                ref={(element) => {
                  composerRef = element;
                  return undefined;
                }}
                class="fixed z-50 flex items-center gap-2 rounded-full border border-accent/40 bg-[#111111]/96 px-2 py-2 shadow-[0_18px_60px_rgba(0,0,0,0.45)] backdrop-blur"
                style={{
                  top: `${position().top}px`,
                  left: `${position().left}px`,
                }}
              >
                <button
                  type="button"
                  onClick={openComposer}
                  title="Add annotation"
                  class="inline-flex h-9 w-9 items-center justify-center rounded-full border border-accent/50 bg-accent text-black transition-colors hover:bg-accent-bright"
                >
                  <PlusIcon size={14} />
                </button>
                <div class="max-w-36 truncate pr-1 text-[11px] uppercase tracking-[0.14em] text-accent/90">
                  {quote()}
                </div>
                <Button type="button" variant="ghost" size="xs" onClick={clearDraftSelection}>
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
                class="fixed z-50 w-[min(360px,calc(100vw-2rem))] overflow-hidden border border-accent/30 bg-[#111111]/96 shadow-[0_24px_80px_rgba(0,0,0,0.55)] backdrop-blur"
                style={{
                  top: `${position().top}px`,
                  left: `${position().left}px`,
                }}
              >
                <div class="border-b border-accent/20 bg-accent/8 px-4 py-3">
                  <div class="text-[11px] uppercase tracking-[0.2em] text-accent">
                    New Annotation
                  </div>
                </div>
                <div class="space-y-3 px-4 py-4">
                  <blockquote class="m-0 border-l-2 border-accent pl-3 text-sm leading-6 text-text">
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
                    class="min-h-28 border-accent/30 bg-bg-surface"
                  />
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-xs text-text-faint">Cmd/Ctrl+Enter to save</div>
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
