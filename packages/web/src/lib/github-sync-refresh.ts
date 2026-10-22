import type { BrowserGithubState } from "./github-outbox";

/** Refresh read models for new completions, never replay history or retry a write. */
export function createGithubSyncRefreshCoordinator(options: {
  refreshPr: (url: string) => Promise<void>;
  /** Fresh review/mergeability read model; caller owns its query invalidation. */
  refreshDetail?: (url: string) => Promise<void>;
  refreshList: () => Promise<void>;
  onReviewCompletion?: () => void;
  global?: boolean;
  schedule?: (work: () => Promise<void>) => () => void;
}) {
  const statuses = new Map<string, Map<string, string>>();
  const pending = new Set<string>();
  const reviewDetails = new Set<string>();
  let approval = false;
  let activeUrl: string | undefined;
  let cancel: (() => void) | undefined;
  let running = false;
  let listRunning = false;
  let listAgain = false;
  let disposed = false;
  const schedule =
    options.schedule ??
    ((work) => {
      const timer = setTimeout(() => void work(), 75);
      return () => clearTimeout(timer);
    });
  const arm = () => {
    if (disposed || running) return;
    cancel?.();
    cancel = schedule(flush);
  };
  const refreshList = () => {
    if (listRunning) {
      listAgain = true;
      return;
    }
    listRunning = true;
    void Promise.resolve()
      .then(options.refreshList)
      .catch(() => {})
      .finally(() => {
        listRunning = false;
        if (!disposed && listAgain) {
          listAgain = false;
          refreshList();
        }
      });
  };
  async function flush() {
    cancel = undefined;
    if (disposed || running) return;
    const urls = [...pending].filter((url) => options.global || url === activeUrl);
    const details = [...reviewDetails].filter((url) => options.global || url === activeUrl);
    const approved = approval;
    pending.clear();
    reviewDetails.clear();
    approval = false;
    running = true;
    if (approved) refreshList();
    // Mark transitions consumed before starting I/O. Read failures never resend writes.
    await Promise.allSettled([
      ...urls.map((url) => Promise.resolve().then(() => options.refreshPr(url))),
      ...details.map((url) => Promise.resolve().then(() => options.refreshDetail?.(url))),
    ]);
    running = false;
    if (!disposed && (pending.size || approval)) arm();
  }
  return {
    observe(state: BrowserGithubState | undefined) {
      activeUrl = state?.scope.url;
      if (!state || disposed) return;
      let known = statuses.get(state.scope.url);
      if (!known) statuses.set(state.scope.url, (known = new Map()));
      let changed = false;
      for (const item of state.operations) {
        const id = item.command.operationId;
        const ids = [id, ...(item.submittedOperationIds ?? [])];
        const previous =
          ids
            .map((alias) => known.get(alias))
            .find(
              (status) => status !== undefined && status !== "synced" && status !== "cancelled",
            ) ?? known.get(id);
        for (const alias of ids) known.set(alias, item.status);
        // First-seen synced operations are history, including journal hydration/reloads.
        if (
          item.status !== "synced" ||
          previous === undefined ||
          previous === "synced" ||
          previous === "cancelled"
        )
          continue;
        pending.add(state.scope.url);
        const review =
          item.command.action.kind === "approve" ||
          item.command.action.kind === "request-changes" ||
          item.command.action.kind === "review-comment";
        approval ||= review;
        if (review) options.onReviewCompletion?.();
        if (review) reviewDetails.add(state.scope.url);
        changed = true;
      }
      if (changed) arm();
    },
    dispose() {
      disposed = true;
      cancel?.();
      pending.clear();
      reviewDetails.clear();
    },
  };
}
