import { createEffect, onCleanup, Show, type JSX } from "solid-js";

import { CloseIcon } from "../icons/close-icon";
import {
  claimSelectionBubble,
  positionSelectionBubble,
  watchSelectionBubble,
  type SelectionBubbleAnchor,
} from "../lib/selection-bubble";

export function SelectionBubble(props: {
  anchor: SelectionBubbleAnchor;
  label?: string;
  error?: string | null;
  onAsk?: () => void;
  onDismiss: () => void;
  /** Close an editor without discarding its draft; explicit Dismiss remains separate. */
  onClose?: () => void;
  /** Candidate-only cleanup; must not clear a new selection or an open composer draft. */
  onHide: () => void;
  expanded?: boolean;
  /** Retained question drafts must remain reachable after source selection/DOM disappears. */
  retained?: boolean;
  children?: JSX.Element;
}) {
  let bubble!: HTMLDivElement;
  let action: HTMLButtonElement | undefined;
  createEffect(() => {
    const anchor = props.anchor;
    const release = claimSelectionBubble(props.onHide);
    let lastRect = anchor.fallbackRect;
    let focusPending = !!props.expanded;
    let focusFrame: number | undefined;
    const inertAncestor = (node: Node): boolean => {
      if (node instanceof Element && node.closest("[inert]")) return true;
      const root = node.getRootNode();
      return root instanceof ShadowRoot ? inertAncestor(root.host) : false;
    };
    const inactive = () => inertAncestor(bubble) || inertAncestor(anchor.root);
    const update = () => {
      if (inactive()) {
        if (bubble.matches(":popover-open")) bubble.hidePopover();
        if (!props.retained) props.onHide();
        return;
      }
      if (!bubble.matches(":popover-open")) bubble.showPopover();
      let rect;
      try {
        rect = anchor.rect(!props.expanded);
      } catch {
        rect = null;
      }
      if (rect) lastRect = rect;
      let boundary = anchor.bounds?.();
      if (props.expanded || props.retained) {
        if (
          !boundary ||
          boundary.right - boundary.left < 180 ||
          boundary.bottom - boundary.top < 140
        )
          boundary = { left: 8, right: innerWidth - 8, top: 8, bottom: innerHeight - 8 };
        if (props.expanded) {
          bubble.style.maxWidth = `${Math.min(360, boundary.right - boundary.left)}px`;
          bubble.style.maxHeight = `${Math.min(420, boundary.bottom - boundary.top)}px`;
        }
        const previous = rect ?? lastRect ?? boundary;
        const left = Math.max(boundary.left, Math.min(previous.left, boundary.right - 1));
        const top = Math.max(boundary.top, Math.min(previous.top, boundary.bottom - 1));
        rect = {
          left,
          right: left + 1,
          top,
          bottom: Math.min(top + previous.bottom - previous.top, boundary.bottom),
        };
      }
      const position = positionSelectionBubble(
        rect,
        bubble.getBoundingClientRect(),
        {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        props.expanded || props.retained ? boundary : undefined,
      );
      if (!position || (!props.expanded && !props.retained && !anchor.root.isConnected)) {
        props.onHide();
        return;
      }
      bubble.style.left = `${position.left}px`;
      bubble.style.top = `${position.top}px`;
      bubble.style.visibility = "visible";
      if (focusPending) {
        focusPending = false;
        focusFrame = requestAnimationFrame(() => {
          if (bubble.isConnected && !inactive())
            bubble.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
        });
      }
    };
    bubble.showPopover();
    if (props.expanded || props.retained) update();
    const watcher = watchSelectionBubble({
      events: [window, document, anchor.root],
      update,
      hide: () => {
        if (props.expanded || props.retained) watcher.refresh();
        else props.onHide();
      },
      schedule: (callback) => requestAnimationFrame(callback),
      cancel: (id) => cancelAnimationFrame(id),
    });
    const observer = new MutationObserver(watcher.refresh);
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["inert"],
    });
    observer.observe(anchor.root, { childList: true, subtree: true });
    const resize = new ResizeObserver(watcher.refresh);
    resize.observe(bubble);
    const pointer = (event: Event) => {
      if (inactive()) return;
      if (!event.composedPath().includes(bubble)) {
        if (props.expanded) (props.onClose ?? props.onDismiss)();
        else props.onHide();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (inactive()) return;
      if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        (props.expanded ? (props.onClose ?? props.onDismiss) : props.onDismiss)();
      }
      if (event.altKey && event.key === "Enter" && action) {
        event.preventDefault();
        action.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", key, true);
    onCleanup(() => {
      release();
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      watcher.dispose();
      observer.disconnect();
      resize.disconnect();
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", key, true);
      if (bubble.matches(":popover-open")) bubble.hidePopover();
    });
  });
  return (
    <div
      ref={(element) => {
        bubble = element;
      }}
      popover="manual"
      role={props.expanded ? "dialog" : "toolbar"}
      aria-label={props.expanded ? "Ask about selection" : "Selection actions"}
      class={
        props.expanded
          ? "fixed m-0 w-[360px] overflow-auto rounded-xl border border-border bg-bg-elevated text-text shadow-xl open:block"
          : "fixed m-0 max-w-[calc(100vw-16px)] items-center gap-1 rounded-full border border-border bg-bg-elevated px-1.5 py-1 text-xs text-text shadow-lg open:flex"
      }
      style={{ inset: "auto", visibility: props.expanded ? "visible" : "hidden" }}
      onPointerDown={(event) => {
        if (!props.expanded) event.preventDefault();
      }}
      onMouseDown={(event) => {
        if (!props.expanded) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (props.expanded || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        const buttons = Array.from(bubble.querySelectorAll<HTMLButtonElement>("button"));
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next]?.focus({ preventScroll: true });
      }}
    >
      <Show
        when={props.expanded}
        fallback={
          <>
            <Show when={props.error}>
              <span role="status" class="max-w-64 px-2">
                {props.error}
              </span>
            </Show>
            <Show when={props.onAsk && !props.error}>
              <span class="sr-only" role="status">
                Selection ready. Press Alt+Enter to focus Ask AI.
              </span>
              <button
                ref={(element) => {
                  action = element;
                }}
                type="button"
                aria-keyshortcuts="Alt+Enter"
                title="Ask AI (Alt+Enter)"
                class="rounded-full px-2 py-1 font-medium text-accent hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() => props.onAsk?.()}
              >
                Ask AI
              </button>
              <Show when={props.label}>
                <span class="text-text-faint">{props.label}</span>
              </Show>
            </Show>
            <button
              type="button"
              aria-label="Dismiss selection actions"
              title="Dismiss selection actions"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-bg focus-visible:outline-2 focus-visible:outline-accent"
              onClick={props.onDismiss}
            >
              <CloseIcon size={12} />
            </button>
          </>
        }
      >
        {props.children}
      </Show>
    </div>
  );
}
