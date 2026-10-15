import { readSelectionRange } from "./ask-ai-selection";

export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export interface SelectionBubbleAnchor {
  root: Node;
  rect: (trackNativeSelection?: boolean) => AnchorRect | null;
  container?: HTMLElement;
  bounds?: () => AnchorRect | null;
  fallbackRect?: AnchorRect;
}

/** Fixed viewport coordinates; prefer above, flip below, never overflow the viewport. */
export function positionSelectionBubble(
  anchor: AnchorRect | null,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  boundary?: AnchorRect | null,
) {
  const margin = 8;
  const gap = 6;
  if (
    !anchor ||
    ![anchor.left, anchor.right, anchor.top, anchor.bottom].every(Number.isFinite) ||
    anchor.right <= 0 ||
    anchor.left >= viewport.width ||
    anchor.bottom <= 0 ||
    anchor.top >= viewport.height
  )
    return null;
  const minX = Math.max(margin, boundary?.left ?? margin);
  const maxX = Math.min(viewport.width - margin, boundary?.right ?? viewport.width - margin);
  const minY = Math.max(margin, boundary?.top ?? margin);
  const maxY = Math.min(viewport.height - margin, boundary?.bottom ?? viewport.height - margin);
  const left = Math.max(
    minX,
    Math.min((anchor.left + anchor.right - size.width) / 2, maxX - size.width),
  );
  const above = anchor.top - gap - size.height;
  const top = Math.max(
    minY,
    Math.min(above >= minY ? above : anchor.bottom + gap, maxY - size.height),
  );
  return { left, top };
}

/** Text fragments only: element/whole-line boxes must never center the bubble. */
export function selectionEndpointRect(
  fragments: AnchorRect[],
  backwards = false,
): AnchorRect | null {
  const visible = fragments.filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
  const fragment = backwards ? visible[0] : visible.at(-1);
  if (!fragment) return null;
  const left = backwards ? fragment.left : Math.max(fragment.left, fragment.right - 1);
  return { left, right: left + 1, top: fragment.top, bottom: fragment.bottom };
}

function textFragments(range: Range) {
  const nodes: Text[] = [];
  if (range.commonAncestorContainer.nodeType === Node.TEXT_NODE)
    nodes.push(range.commonAncestorContainer as Text);
  else {
    const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) if (range.intersectsNode(node)) nodes.push(node as Text);
  }
  return nodes.flatMap((node) => {
    const part = document.createRange();
    part.selectNodeContents(node);
    if (range.comparePoint(node, 0) < 0) part.setStart(range.startContainer, range.startOffset);
    if (range.comparePoint(node, node.length) > 0) part.setEnd(range.endContainer, range.endOffset);
    return Array.from(part.getClientRects())
      .map((rect) => clippedRect(rect, node.parentElement!))
      .filter((rect): rect is AnchorRect => !!rect);
  });
}

function anchorContext(element: Element) {
  const container = element.closest<HTMLDialogElement>("dialog") ?? undefined;
  const root = element.getRootNode();
  const boundsElement =
    root instanceof ShadowRoot
      ? (root.host.closest(".diff-viewer")?.parentElement ?? root.host)
      : (container ?? element);
  return {
    container,
    bounds: () =>
      clippedRect(
        { left: 8, top: 8, right: innerWidth - 8, bottom: innerHeight - 8 },
        boundsElement,
      ),
  };
}

function clippedRect(rect: AnchorRect, element: Element): AnchorRect | null {
  const result = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  let parent: Element | null = element;
  while (parent) {
    const style = getComputedStyle(parent);
    const bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      result.left = Math.max(result.left, bounds.left);
      result.right = Math.min(result.right, bounds.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      result.top = Math.max(result.top, bounds.top);
      result.bottom = Math.min(result.bottom, bounds.bottom);
    }
    parent =
      parent.parentElement ??
      (parent.getRootNode() instanceof ShadowRoot
        ? (parent.getRootNode() as ShadowRoot).host
        : null);
  }
  return result.right > result.left && result.bottom > result.top ? result : null;
}

export function textSelectionAnchor(root: ShadowRoot | Document): SelectionBubbleAnchor | null {
  const range = readSelectionRange(root);
  if (!range) return null;
  const element =
    range.startContainer.nodeType === 1
      ? (range.startContainer as Element)
      : range.startContainer.parentElement!;
  const local = root as typeof root & { getSelection?: () => Selection | null };
  const native = local.getSelection?.() ?? window.getSelection();
  const backwards =
    native?.focusNode === range.startContainer && native?.focusOffset === range.startOffset;
  return {
    root,
    ...anchorContext(element),
    rect: (trackNativeSelection = true) => {
      if (!range.startContainer.isConnected || !range.endContainer.isConnected) return null;
      const current = trackNativeSelection ? readSelectionRange(root) : null;
      if (
        trackNativeSelection &&
        (!current ||
          current.startContainer !== range.startContainer ||
          current.endContainer !== range.endContainer ||
          current.startOffset !== range.startOffset ||
          current.endOffset !== range.endOffset)
      )
        return null;
      return selectionEndpointRect(textFragments(range), backwards);
    },
  };
}

/** Resolve live rows each time: comment rendering/virtualization may replace their DOM. */
export function lineSelectionAnchor(root: Node, rows: () => Element[]): SelectionBubbleAnchor {
  const element = rows()[0];
  return {
    root,
    ...(element ? anchorContext(element) : {}),
    rect: () => {
      const rects = rows()
        .filter((row) => row.isConnected)
        .map((row) => {
          const range = document.createRange();
          range.selectNodeContents(row);
          const fragment = textFragments(range)[0] ?? clippedRect(row.getBoundingClientRect(), row);
          return fragment
            ? {
                left: fragment.left,
                right: fragment.left + 1,
                top: fragment.top,
                bottom: fragment.bottom,
              }
            : null;
        })
        .filter((rect): rect is AnchorRect => !!rect);
      if (!rects.length) return null;
      return rects.at(-1)!;
    },
  };
}

// A new candidate replaces any previous file's bubble, not its already-open composer.
let owner: { hide: () => void } | undefined;
export function claimSelectionBubble(hide: () => void) {
  const previous = owner;
  const next = { hide };
  owner = next;
  previous?.hide();
  return () => {
    if (owner === next) owner = undefined;
  };
}

/** Shared lifecycle: scroll dismisses; resize/selection/DOM changes remeasure once per frame. */
export function watchSelectionBubble(options: {
  events: EventTarget[];
  update: () => void;
  hide: () => void;
  schedule: (callback: () => void) => number;
  cancel: (id: number) => void;
}) {
  let frame: number | undefined;
  let disposed = false;
  const refresh = () => {
    if (disposed || frame !== undefined) return;
    frame = options.schedule(() => {
      frame = undefined;
      if (!disposed) options.update();
    });
  };
  const hide = () => {
    if (!disposed) options.hide();
  };
  for (const target of options.events) {
    target.addEventListener("scroll", hide, true);
    target.addEventListener("resize", refresh);
    target.addEventListener("selectionchange", refresh);
  }
  refresh();
  return {
    refresh,
    dispose: () => {
      disposed = true;
      if (frame !== undefined) options.cancel(frame);
      for (const target of options.events) {
        target.removeEventListener("scroll", hide, true);
        target.removeEventListener("resize", refresh);
        target.removeEventListener("selectionchange", refresh);
      }
    },
  };
}
