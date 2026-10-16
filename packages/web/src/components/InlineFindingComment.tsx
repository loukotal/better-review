import { createEffect, createMemo, createResource, For, Show } from "solid-js";

import type { FindingCommentRequest } from "../lib/finding-comment";
import { queryClient } from "../lib/query";
import { trpc } from "../lib/trpc";
import { CachedCommentForm, type CachedCommentDraft } from "./CachedCommentForm";

export interface InlineFindingDraft {
  request: FindingCommentRequest;
  draft: CachedCommentDraft;
}

/** Source outside patch hunks stays inline, pinned to the finding's verified current head. */
export function InlineFindingComment(props: {
  entry: InlineFindingDraft;
  isCurrent: () => boolean;
  onSubmit: (body: string, draftKey?: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [source, { refetch }] = createResource(
    () => props.entry.request,
    (request) =>
      queryClient.fetchQuery({
        queryKey: ["finding-source", request.sessionId, request.expectedHeadSha, request.filePath],
        queryFn: () =>
          trpc.prReview.source.query({
            sessionId: request.sessionId,
            path: request.filePath,
            ref: request.expectedHeadSha,
          }),
        staleTime: Infinity,
      }),
  );
  const data = () => (source.error ? undefined : source());
  const lines = createMemo(() => data()?.content.split(/\r?\n/) ?? []);
  const ready = () =>
    !!data() &&
    data()!.ref === props.entry.request.expectedHeadSha &&
    props.entry.request.line <= lines().length &&
    props.isCurrent();
  const context = createMemo(() =>
    lines()
      .map((text, index) => ({ text, line: index + 1 }))
      .slice(Math.max(0, props.entry.request.line - 9), props.entry.request.line + 8),
  );
  let section!: HTMLElement;
  createEffect(() => {
    if (ready())
      requestAnimationFrame(() => {
        section?.scrollIntoView({ block: "center", behavior: "instant" });
        section?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
      });
  });
  return (
    <section
      ref={(element) => {
        section = element;
      }}
      data-inline-finding-comment
      data-file={props.entry.request.filePath}
      data-line={props.entry.request.line}
      data-side="RIGHT"
      data-source-ready={ready() ? "true" : "false"}
      class="mb-3 rounded border border-accent bg-bg-surface p-3"
    >
      <h3 class="break-all text-sm font-medium">
        {props.entry.request.filePath} · Line {props.entry.request.line}
      </h3>
      <p class="mb-2 text-xs text-text-muted">
        Full-file source at {props.entry.request.expectedHeadSha.slice(0, 7)}. This is an editable
        PR comment draft, not a published comment.
      </p>
      <Show when={source.loading}>
        <p role="status">Loading reviewed source…</p>
      </Show>
      <Show when={source.error}>
        <p role="alert" class="text-xs text-error">
          Could not load this exact file/revision. If the finding uses only a basename, supply its
          full repository-relative path. Your draft was preserved.
        </p>
        <button type="button" onClick={() => void refetch()}>
          Retry source
        </button>
      </Show>
      <Show when={data() && props.entry.request.line > lines().length}>
        <p role="alert">
          This line does not exist at the reviewed revision. No comment can be submitted.
        </p>
      </Show>
      <div class="max-h-48 overflow-auto bg-bg font-mono text-xs">
        <For each={context()}>
          {(row) => (
            <div
              data-source-line={row.line}
              class={`flex whitespace-pre px-2 leading-5 ${row.line === props.entry.request.line ? "bg-accent/15" : ""}`}
            >
              <span class="mr-3 w-10 shrink-0 text-right text-text-faint">{row.line}</span>
              <code>{row.text}</code>
            </div>
          )}
        </For>
      </div>
      <div class="mt-3">
        <CachedCommentForm
          draft={props.entry.draft}
          startLine={props.entry.request.line}
          endLine={props.entry.request.line}
          disabled={() => !ready()}
          onSubmit={props.onSubmit}
          onCancel={props.onCancel}
        />
      </div>
    </section>
  );
}
