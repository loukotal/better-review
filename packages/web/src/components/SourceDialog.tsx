import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  on,
  Show,
} from "solid-js";

import { Button, Dialog } from "../design-system";
import type { SourceTarget } from "../lib/annotation-navigation";
import { validateSelection, type SelectedSource } from "../lib/ask-ai-selection";
import {
  lineSelectionAnchor,
  textSelectionAnchor,
  type SelectionBubbleAnchor,
} from "../lib/selection-bubble";
import { trpc } from "../lib/trpc";
import { SelectionBubble } from "./SelectionBubble";

export function SourceDialog(props: {
  target: SourceTarget;
  onClose: () => void;
  onAskAi?: (selection: SelectedSource, anchor: SelectionBubbleAnchor, revision: string) => void;
  askEditorOpen?: boolean;
}) {
  const [candidate, setCandidate] = createSignal<SelectedSource | null>(null);
  const [selectionError, setSelectionError] = createSignal<string | null>(null);
  const [bubbleAnchor, setBubbleAnchor] = createSignal<SelectionBubbleAnchor | null>(null);
  const hideCandidate = () => {
    setCandidate(null);
    setSelectionError(null);
    setBubbleAnchor(null);
  };
  const dismissCandidate = () => {
    hideCandidate();
    window.getSelection()?.removeAllRanges();
  };
  createEffect(() => {
    if (props.askEditorOpen) hideCandidate();
  });
  createEffect(on(() => props.target, hideCandidate, { defer: true }));
  let anchor = 1;
  const select = (start: number, end: number, text: string) => {
    try {
      validateSelection(text);
      setCandidate({
        file: props.target.path,
        side: "RIGHT",
        startLine: start,
        endLine: end,
        text,
      });
      setSelectionError(null);
    } catch (error) {
      setCandidate(null);
      setSelectionError(error instanceof Error ? error.message : "Invalid selection");
    }
  };
  const capture = () => {
    if (props.askEditorOpen) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0);
    try {
      setBubbleAnchor(textSelectionAnchor(document));
    } catch {
      setBubbleAnchor(lineSelectionAnchor(document, () => (code ? [code] : [])));
    }
    const row = (node: Node) =>
      (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest<HTMLElement>(
        "code[data-source-line]",
      );
    const start = row(range.startContainer);
    const end = row(range.endContainer);
    if (!start || !end || !code?.contains(start) || !code.contains(end)) {
      setCandidate(null);
      setSelectionError("Select source in this file only.");
      return;
    }
    const startLine = Number(start.dataset.sourceLine);
    const endLine = Number(end.dataset.sourceLine);
    const parts = Array.from(code.querySelectorAll("code[data-source-line]"))
      .filter((el) => range.intersectsNode(el))
      .map((el) => {
        const part = document.createRange();
        part.selectNodeContents(el);
        if (el === start) part.setStart(range.startContainer, range.startOffset);
        if (el === end) part.setEnd(range.endContainer, range.endOffset);
        return part.toString();
      });
    select(startLine, endLine, parts.join("\n"));
  };
  const [source, { refetch }] = createResource(
    () => props.target,
    (target) =>
      trpc.prReview.source.query({
        sessionId: target.sessionId,
        path: target.path,
        ref: target.ref,
      }),
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
            <Show when={props.onAskAi}>
              <p class="text-xs text-text-muted">
                Select text or click line numbers (Shift-click for a range) to ask AI. Alt+Enter
                focuses the selection action.
              </p>
              <Show when={bubbleAnchor()}>
                {(anchor) => (
                  <SelectionBubble
                    anchor={anchor()}
                    label={
                      candidate()
                        ? `Lines ${candidate()!.startLine}–${candidate()!.endLine}`
                        : undefined
                    }
                    error={selectionError()}
                    onAsk={
                      candidate()
                        ? () => {
                            const selected = candidate();
                            if (selected) props.onAskAi?.(selected, anchor(), result().ref);
                            hideCandidate();
                          }
                        : undefined
                    }
                    onDismiss={dismissCandidate}
                    onHide={hideCandidate}
                  />
                )}
              </Show>
            </Show>
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
                onMouseUp={(event) => {
                  if (!(event.target as Element).closest("button")) capture();
                }}
                onKeyUp={(event) => {
                  if (event.shiftKey || event.key === "Shift") capture();
                }}
              >
                <For each={lines()}>
                  {(text, index) => (
                    <div
                      data-target={
                        validLine() && index() + 1 === props.target.line ? "true" : undefined
                      }
                      class={`flex min-w-max leading-6 ${validLine() && index() + 1 === props.target.line ? "bg-accent/15" : ""}`}
                    >
                      <button
                        type="button"
                        aria-label={`Select source line ${index() + 1}`}
                        onClick={(event) => {
                          if (props.askEditorOpen) return;
                          if (!event.shiftKey) anchor = index() + 1;
                          const first = Math.min(anchor, index() + 1);
                          const last = Math.max(anchor, index() + 1);
                          setBubbleAnchor(
                            lineSelectionAnchor(document, () =>
                              [first, last].flatMap((line) => {
                                const row = code?.querySelector(`[data-source-line="${line}"]`);
                                return row ? [row] : [];
                              }),
                            ),
                          );
                          select(
                            first,
                            last,
                            lines()
                              .slice(first - 1, last)
                              .join("\n"),
                          );
                        }}
                        class="sticky left-0 w-14 shrink-0 select-none bg-bg-surface px-3 text-right text-text-faint"
                      >
                        {index() + 1}
                      </button>
                      <code data-source-line={index() + 1} class="whitespace-pre px-3">
                        {text}
                      </code>
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
