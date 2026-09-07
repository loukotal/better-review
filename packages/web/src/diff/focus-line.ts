import { FileDiff, VirtualizedFileDiff, type AnnotationSide } from "@pierre/diffs";

// Widen only documented protected APIs; never reach into virtualizer caches.
export class FocusableFileDiff<T> extends FileDiff<T> {
  public override getFileContainer() {
    return super.getFileContainer();
  }
  getExpandedHunks() {
    return this.hunksRenderer.getExpandedHunksMap();
  }
}

export class FocusableVirtualizedFileDiff<T> extends VirtualizedFileDiff<T> {
  public override getFileContainer() {
    return super.getFileContainer();
  }
  getExpandedHunks() {
    return this.hunksRenderer.getExpandedHunksMap();
  }
}

export function focusRowSelector(indices: readonly number[], side: AnnotationSide, line: number) {
  const row = `[data-line][data-line-index="${indices.join(",")}"]`;
  const unified =
    side === "additions"
      ? `${row}[data-line="${line}"]:not([data-line-type="change-deletion"])`
      : `${row}[data-line="${line}"][data-line-type="change-deletion"], [data-code][data-unified] ${row}[data-alt-line="${line}"]`;
  return `[data-code][data-${side}] ${row}[data-line="${line}"], [data-code][data-unified] ${unified}`;
}

export function centerFocusRow(
  row: { getBoundingClientRect(): { top: number; height: number } },
  scroll: {
    scrollTop: number;
    clientTop: number;
    clientHeight: number;
    getBoundingClientRect(): { top: number };
    scrollTo(options: { top: number; behavior: "instant" }): void;
  },
) {
  const rect = row.getBoundingClientRect();
  scroll.scrollTo({
    top: Math.max(
      0,
      scroll.scrollTop +
        rect.top -
        scroll.getBoundingClientRect().top -
        scroll.clientTop +
        rect.height / 2 -
        scroll.clientHeight / 2,
    ),
    behavior: "instant",
  });
}

/** Returns cancellation for both rendering retries and layout settling. */
export function focusRenderedLine<Row>({
  findRow,
  center,
  renderAll,
  failed,
}: {
  findRow: () => Row | undefined;
  center: (row: Row) => void;
  renderAll: () => void;
  failed: () => void;
}): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let attempts = 0;
  let settled = 0;
  const tick = () => {
    if (cancelled) return;
    const row = findRow();
    if (row !== undefined) {
      center(row);
      if (++settled === 3) return;
    } else settled = 0;
    if (++attempts >= 60) {
      if (row === undefined) failed();
      return;
    }
    timer = setTimeout(tick, 32);
  };
  if (findRow() === undefined) renderAll();
  tick();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
