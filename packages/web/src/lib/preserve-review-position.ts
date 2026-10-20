/** Solid's keyed file list moves existing nodes; keep the visible file and editor intact. */
export function preserveReviewPosition(container: HTMLElement | undefined, reorder: () => void) {
  if (!container) {
    reorder();
    return;
  }
  const top = container.getBoundingClientRect().top;
  const anchor = [...container.querySelectorAll<HTMLElement>('[id^="file-"]')].find(
    (element) => element.getBoundingClientRect().bottom > top,
  );
  const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
  const focused =
    document.activeElement instanceof HTMLElement && container.contains(document.activeElement)
      ? document.activeElement
      : null;
  reorder();
  const restore = () => {
    if (!container.isConnected || !anchor?.isConnected) return;
    if (focused?.isConnected && document.activeElement !== focused)
      focused.focus({ preventScroll: true });
    container.scrollTop +=
      anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - offset;
  };
  // Effects flush before this microtask. A frame also accounts for virtualizer measurement.
  queueMicrotask(() => {
    restore();
    requestAnimationFrame(restore);
  });
}
