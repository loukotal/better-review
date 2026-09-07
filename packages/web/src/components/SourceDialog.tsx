import { createEffect, createMemo, createResource, For, onCleanup, Show } from "solid-js";

import { Button, Dialog } from "../design-system";
import type { SourceTarget } from "../lib/annotation-navigation";
import { trpc } from "../lib/trpc";

export function SourceDialog(props: { target: SourceTarget; onClose: () => void }) {
  const [source, { refetch }] = createResource(
    () => props.target,
    (target) => trpc.flueReview.source.query({ sessionId: target.sessionId, path: target.path }),
  );
  // Catch resource errors here so the dialog stays open and offers retry.
  const data = () => (source.error ? undefined : source());
  const lines = createMemo(() => {
    const content = data()?.content;
    if (!content) return [];
    const result = content.split(/\r?\n/);
    if (result.at(-1) === "") result.pop();
    return result;
  });
  const validLine = () =>
    props.target.line !== undefined &&
    Number.isSafeInteger(props.target.line) &&
    props.target.line > 0 &&
    props.target.line <= lines().length;
  let code: HTMLDivElement | undefined;
  createEffect(() => {
    if (data() && validLine()) {
      const frame = requestAnimationFrame(() => {
        code?.querySelector('[data-target="true"]')?.scrollIntoView({ block: "center" });
      });
      onCleanup(() => cancelAnimationFrame(frame));
    }
  });

  return (
    <Dialog open onClose={props.onClose} title={props.target.path} wide>
      <Show when={source.loading}>
        <p role="status" class="text-sm text-text-muted">
          Loading reviewed source...
        </p>
      </Show>
      <Show when={source.error}>
        <div role="alert" class="space-y-3">
          <p class="text-sm text-text-muted">
            {source.error?.data?.code === "NOT_FOUND"
              ? "Source not found at this review revision."
              : `Unable to load reviewed source: ${source.error instanceof Error ? source.error.message : "Unknown error"}`}
          </p>
          <Button onClick={() => void refetch()}>Retry</Button>
        </div>
      </Show>
      <Show when={data()}>
        {(result) => (
          <div class="space-y-3">
            <p class="break-all font-mono text-xs text-text-muted">
              Read-only source at {result().ref}
            </p>
            <Show when={props.target.line !== undefined && !validLine()}>
              <p role="status" class="text-sm text-text-muted">
                Line {String(props.target.line)} does not exist in this revision ({lines().length}{" "}
                lines).
              </p>
            </Show>
            <Show
              when={lines().length > 0}
              fallback={<p class="text-sm text-text-muted">This file is empty.</p>}
            >
              <div
                ref={(element) => {
                  code = element;
                }}
                class="max-h-[65dvh] overflow-auto rounded border border-border bg-bg font-mono text-xs"
                tabIndex={0}
                aria-label="Reviewed source"
              >
                <For each={lines()}>
                  {(text, index) => (
                    <div
                      data-target={
                        validLine() && index() + 1 === props.target.line ? "true" : undefined
                      }
                      class={`flex min-w-max leading-6 ${validLine() && index() + 1 === props.target.line ? "bg-accent/15" : ""}`}
                    >
                      <span class="sticky left-0 w-14 shrink-0 select-none bg-bg-surface px-3 text-right text-text-faint">
                        {index() + 1}
                      </span>
                      <code class="whitespace-pre px-3">{text || " "}</code>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </Dialog>
  );
}
