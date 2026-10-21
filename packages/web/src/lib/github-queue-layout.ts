/** Reveal recovery controls in the queue's own scroller, never the page behind it. */
export function revealGithubQueueContent(element: HTMLElement): void {
  if (!element.isConnected) return;
  const scroll = element.closest<HTMLElement>("[data-github-queue-scroll]");
  if (!scroll) return;
  const bounds = scroll.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const margin = Math.min(4, Math.max(0, (bounds.height - rect.height) / 2));
  if (rect.height > bounds.height || rect.top < bounds.top + margin)
    scroll.scrollTop += rect.top - bounds.top - margin;
  else if (rect.bottom > bounds.bottom - margin)
    scroll.scrollTop += rect.bottom - bounds.bottom + margin;
}
