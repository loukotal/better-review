import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";

import type { ResolvedSource } from "@better-review/shared";

import type { SourceTarget } from "../lib/annotation-navigation";
import type { SelectedSource } from "../lib/ask-ai-selection";
import { createSourceNavigation, type SourceNavigation } from "../lib/review-interactions";
import { textSelectionAnchor, type SelectionBubbleAnchor } from "../lib/selection-bubble";
import { trpc } from "../lib/trpc";
import { SelectionBubble } from "./SelectionBubble";

/** Navigation only: no comment controls or conversion of fallback lines into PR targets. */
export function InlineSourceView(props: {
  target: SourceTarget;
  navigation?: SourceNavigation;
  onClose: () => void;
  onChoose: (target: SourceTarget) => void;
  onResolved: (source: Extract<ResolvedSource, { status: "found" }>) => void;
  askEditorOpen?: boolean;
  onAskAi?: (selection: SelectedSource, anchor: SelectionBubbleAnchor, revision: string) => void;
}) {
  let section!: HTMLElement;
  const [candidate, setCandidate] = createSignal<{
    selection: SelectedSource;
    anchor: SelectionBubbleAnchor;
    ref: string;
  } | null>(null);
  const navigation =
    props.navigation ??
    createSourceNavigation(
      () => "standalone",
      (target, range, signal) =>
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
    );
  createEffect(() => {
    const target = props.target;
    if (!props.navigation) void navigation.openSource(target);
  });
  onCleanup(() => {
    if (!props.navigation) navigation.close();
  });
  const data = () => (navigation.error() ? undefined : navigation.destination()?.result);
  const found = () => {
    const value = data();
    return value?.status === "found" ? value : undefined;
  };
  const captured = () =>
    props.target.captured && (!found() || found()?.approximate) ? props.target.captured : undefined;
  const startLine = () => captured()?.startLine ?? found()?.contentStartLine ?? 1;
  const lines = () => navigation.presentation()?.lines ?? [];
  const selectedLine = () => captured()?.startLine ?? found()?.line;
  const capture = () => {
    if (props.askEditorOpen || !props.onAskAi || navigation.loading()) return;
    const selection = getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0);
    const row = (node: Node) =>
      (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest<HTMLElement>(
        "[data-source-line]",
      );
    const start = row(range.startContainer),
      end = row(range.endContainer);
    if (!start || !end || !section.contains(start) || !section.contains(end)) return;
    try {
      const text = Array.from(section.querySelectorAll("code"))
        .filter((code) => range.intersectsNode(code))
        .map((code) => {
          const part = document.createRange();
          part.selectNodeContents(code);
          if (code.contains(range.startContainer))
            part.setStart(range.startContainer, range.startOffset);
          if (code.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset);
          return part.toString();
        })
        .join("\n");
      const anchor = textSelectionAnchor(document);
      const source = navigation.selectSource(
        Number(start.dataset.sourceLine),
        Number(end.dataset.sourceLine),
        text,
      );
      if (!anchor || !source?.revision) return;
      setCandidate({
        selection: source,
        anchor,
        ref: source.revision,
      });
    } catch {
      setCandidate(null);
    }
  };
  createEffect(() => {
    if (props.askEditorOpen) setCandidate(null);
  });
  createEffect(() => {
    navigation.range();
    setCandidate(null);
  });
  createEffect(() => {
    const value = found();
    if (
      !props.navigation &&
      value &&
      !captured() &&
      !props.target.notice &&
      value.line >= (value.contentStartLine ?? 1) &&
      value.line <= (value.contentEndLine ?? Number.MAX_SAFE_INTEGER)
    )
      props.onResolved(value);
    if (value || captured())
      requestAnimationFrame(() => {
        if (!section.isConnected) return;
        const row = section.querySelector<HTMLElement>(`[data-source-line="${selectedLine()}"]`);
        (row ?? section).scrollIntoView({ block: "center", behavior: "instant" });
        row?.focus({ preventScroll: true });
      });
  });
  return (
    <section
      ref={(element) => {
        section = element;
      }}
      onMouseUp={capture}
      onKeyUp={capture}
      data-inline-source
      data-source-ready={!!found() || !!captured()}
      data-source-ref={captured() ? props.target.ref : found()?.ref}
      data-source-side={captured() ? props.target.side : found()?.side}
      class="mb-4 rounded border border-border bg-bg-elevated p-3"
    >
      <header class="mb-2 flex items-center justify-between gap-2">
        <h2 class="break-all font-mono text-sm">
          {captured() ? props.target.path : (found()?.path ?? props.target.path)} · Read-only source
        </h2>
        <button type="button" aria-label="Close inline source" onClick={props.onClose}>
          Close
        </button>
      </header>
      <p class="break-all text-xs text-text-muted">
        Revision:{" "}
        {captured() ? props.target.ref : (found()?.ref ?? props.target.ref ?? "resolving")} ·{" "}
        {(captured() ? props.target.side : found()?.side) === "LEFT"
          ? "Previous version"
          : "Reviewed source"}
        . Navigation only; not a PR comment target.
      </p>
      <Show when={!captured() && (props.target.notice || found()?.notice)}>
        <p role="status" class="my-2 text-sm text-warning">
          {props.target.notice} {found()?.notice}
        </p>
      </Show>
      <Show when={navigation.loading()}>
        <p role="status">Looking up reviewed source…</p>
      </Show>
      <Show when={navigation.error()}>
        <p role="alert" class="my-2 text-warning">
          {navigation.error()?.message ?? "Source lookup failed"}{" "}
          <button type="button" onClick={() => navigation.retry()}>
            Retry
          </button>
        </p>
      </Show>
      <Show when={data()?.status === "missing"}>
        <p role="status" class="my-2 text-warning">
          {data()?.notice}
        </p>
      </Show>
      <Show when={data()?.status === "ambiguous" ? data() : undefined} keyed>
        {(value) =>
          value.status === "ambiguous" && (
            <div role="status">
              <p>{value.notice}</p>
              <For each={value.candidates}>
                {(path) => (
                  <button
                    type="button"
                    class="block font-mono text-accent underline"
                    onClick={() => {
                      const target = navigation.chooseTarget(path);
                      if (target) props.onChoose(target);
                    }}
                  >
                    {path}
                  </button>
                )}
              </For>
            </div>
          )
        }
      </Show>
      <Show when={captured()}>
        <p role="status" class="my-2 text-warning">
          Exact captured selection from the original version. Full-file lookup did not verify this
          revision/range; retaining the captured text instead of showing fallback code. No
          current-line mapping was made.
          <Show when={props.target.lookup?.approximate}>
            <span class="block">
              Chosen file lookup remains approximate, not a mapping of the captured lines:{" "}
              {props.target.lookup?.notice}
            </span>
          </Show>
        </p>
      </Show>
      <Show when={found() || captured()}>
        <Show when={!captured() && found()?.totalLines !== undefined}>
          <nav aria-label="Source pages" class="my-2 flex items-center gap-3 text-xs">
            <button
              type="button"
              disabled={navigation.loading() || startLine() <= 1}
              onClick={() => navigation.page("earlier")}
            >
              Load earlier lines
            </button>
            <span>
              Lines {startLine()}–{found()?.contentEndLine ?? startLine() + lines().length - 1} of{" "}
              {found()?.totalLines}
            </span>
            <button
              type="button"
              disabled={
                navigation.loading() || (found()?.contentEndLine ?? 0) >= (found()?.totalLines ?? 0)
              }
              onClick={() => navigation.page("later")}
            >
              Load later lines
            </button>
          </nav>
        </Show>
        <div class="mt-3 overflow-x-auto font-mono text-xs">
          <For each={lines()}>
            {(text, index) => (
              <div
                tabIndex={-1}
                data-source-line={startLine() + index()}
                data-selected-line={startLine() + index() === selectedLine() ? "true" : undefined}
                class={`flex whitespace-pre leading-6 ${startLine() + index() === selectedLine() ? "bg-accent/15 outline-none" : ""}`}
              >
                <span class="mr-4 w-12 shrink-0 select-none text-right text-text-faint">
                  {startLine() + index()}
                </span>
                <code>{text}</code>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={candidate()} keyed>
        {(value) => (
          <SelectionBubble
            anchor={value.anchor}
            label={`Lines ${value.selection.startLine}–${value.selection.endLine}`}
            onHide={() => setCandidate(null)}
            onDismiss={() => {
              setCandidate(null);
              getSelection()?.removeAllRanges();
            }}
            onAsk={() => {
              props.onAskAi?.(value.selection, value.anchor, value.ref);
              setCandidate(null);
            }}
          />
        )}
      </Show>
    </section>
  );
}
