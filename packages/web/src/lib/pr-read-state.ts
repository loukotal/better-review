import type { IssueComment, PRComment, PrDetail, PrStatus } from "@better-review/shared";

import type { PrExtrasData } from "./query";

/** Query owns transport/cache policy; the selected read owner owns publication. */
export interface PrReadQueryAdapter {
  cachedDetail(url: string): PrDetail | undefined;
  cachedExtras(url: string): PrExtrasData | undefined;
  fetchDetail(url: string): Promise<PrDetail>;
  fetchExtras(url: string): Promise<PrExtrasData>;
  refreshDetail(url: string, options: { afterWrite?: boolean }): Promise<PrDetail>;
  refreshExtras(url: string): Promise<PrExtrasData>;
  refreshList(): Promise<void>;
  cancelOtherPrQueries(url: string): Promise<void>;
  cancelPrQueries(url: string): Promise<void>;
  invalidatePrQueries(url: string): Promise<void>;
  subscribe(listener: (event: { url: string; resource: "detail" | "extras" }) => void): () => void;
}

export interface PrReadSnapshot {
  url?: string;
  detail?: PrDetail;
  displayDetail?: PrDetail;
  mergeDetail?: PrDetail;
  staleNotice?: string;
  detailError?: string;
  refreshingDetail: boolean;
  comments: PRComment[];
  issueComments: IssueComment[];
  status: PrStatus | null;
  reviewThreads?: PrExtrasData["reviewThreads"];
  loadingStatus: boolean;
  loadingComments: boolean;
  commentsUnavailable: boolean;
  issueCommentsUnavailable: boolean;
}

const empty = (): PrReadSnapshot => ({
  refreshingDetail: false,
  comments: [],
  issueComments: [],
  status: null,
  loadingStatus: false,
  loadingComments: false,
  commentsUnavailable: false,
  issueCommentsUnavailable: false,
});

/** Display fallback must never become write authority. */
function retainPrDetailForDisplay(
  previous: PrDetail | undefined,
  next: PrDetail,
): { data: PrDetail; stale: string[] } {
  if (!previous || previous.url !== next.url || previous.metadata.status !== "available")
    return { data: next, stale: [] };
  if (next.metadata.status === "unavailable")
    return {
      data: { ...previous, actor: next.actor, mergeCapabilities: next.mergeCapabilities },
      stale: [next.metadata.message],
    };
  if (
    previous.metadata.data.head.sha !== next.metadata.data.head.sha ||
    previous.metadata.data.base.sha !== next.metadata.data.base.sha
  )
    return { data: next, stale: [] };
  const data = { ...next },
    stale: string[] = [];
  if (next.checks.status === "unavailable" && previous.checks.status === "available") {
    data.checks = previous.checks;
    stale.push(next.checks.message);
  }
  if (next.labels.status === "unavailable" && previous.labels.status === "available") {
    data.labels = previous.labels;
    stale.push(next.labels.message);
  }
  if (next.reviews.status === "unavailable" && previous.reviews.status === "available") {
    data.reviews = previous.reviews;
    stale.push(next.reviews.message);
  }
  if (
    next.reviewRequests.status === "unavailable" &&
    previous.reviewRequests.status === "available"
  ) {
    data.reviewRequests = previous.reviewRequests;
    stale.push(next.reviewRequests.message);
  }
  return { data: stale.length ? data : next, stale };
}

/** One selected PR's read lifecycle. Shared query flights outlive this owner. */
export function createPrReadState(options: {
  query: PrReadQueryAdapter;
  requestedUrl: () => string | undefined;
}) {
  const query = options.query;
  let state = empty();
  let selectionEpoch = 0;
  let detailEpoch = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  function publish(patch: Partial<PrReadSnapshot>) {
    if (disposed) return;
    const next = { ...state, ...patch };
    next.mergeDetail =
      next.detail === state.detail && next.detailError === state.detailError
        ? state.mergeDetail
        : next.detail && next.detailError
          ? {
              ...next.detail,
              mergeCapabilities: {
                status: "unavailable",
                message:
                  "Current merge permissions could not be refreshed. Refresh details before merging.",
              },
            }
          : next.detail;
    state = next;
    for (const listener of listeners) listener();
  }
  const selected = (url: string, epoch: number) =>
    !disposed && selectionEpoch === epoch && state.url === url;
  const current = (url: string, epoch: number) =>
    selected(url, epoch) && options.requestedUrl() === url;
  function publishDetail(data: PrDetail) {
    const view = retainPrDetailForDisplay(state.displayDetail, data);
    publish({
      detail: data,
      displayDetail: view.data,
      staleNotice: view.stale.length ? view.stale.join(" · ") : undefined,
      detailError: undefined,
    });
  }
  function publishExtras(data: PrExtrasData, settled = false) {
    publish({
      comments: data.comments ?? state.comments,
      issueComments: data.issueComments ?? state.issueComments,
      status: data.status ?? state.status,
      commentsUnavailable: data.comments === null,
      issueCommentsUnavailable: data.issueComments === null,
      reviewThreads: data.reviewThreads,
      ...(settled ? { loadingStatus: false, loadingComments: false } : {}),
    });
  }
  const unsubscribe = query.subscribe(({ url, resource }) => {
    if (!current(url, selectionEpoch)) return;
    if (resource === "detail") {
      const data = query.cachedDetail(url);
      if (data) publishDetail(data);
    } else {
      const data = query.cachedExtras(url);
      if (data) publishExtras(data, true);
    }
  });

  function select(url: string | undefined) {
    if (disposed) return;
    const epoch = ++selectionEpoch;
    const read = ++detailEpoch;
    const extras = url ? query.cachedExtras(url) : undefined;
    const detail = url ? query.cachedDetail(url) : undefined;
    state = empty();
    publish({
      url,
      detail,
      displayDetail: detail,
      comments: extras?.comments ?? [],
      issueComments: extras?.issueComments ?? [],
      status: extras?.status ?? null,
      reviewThreads: extras?.reviewThreads,
      loadingStatus: !!url && !extras?.status,
      loadingComments: !!url && !extras,
      commentsUnavailable: !!extras && extras.comments === null,
      issueCommentsUnavailable: !!extras && extras.issueComments === null,
    });
    if (!url || disposed) return;
    void query.cancelOtherPrQueries(url);
    void query
      .fetchDetail(url)
      .then((data) => {
        if (current(url, epoch) && read === detailEpoch) publishDetail(data);
      })
      .catch((cause) => {
        if (current(url, epoch) && read === detailEpoch)
          publish({
            detailError:
              cause instanceof Error ? cause.message : "Pull request details unavailable",
          });
      });
    void query
      .fetchExtras(url)
      .then((data) => {
        if (current(url, epoch)) publishExtras(data);
      })
      .catch((cause) => {
        console.error("Failed to load PR comments and status:", cause);
        if (current(url, epoch))
          publish({ commentsUnavailable: true, issueCommentsUnavailable: true });
      })
      .finally(() => {
        if (current(url, epoch)) publish({ loadingStatus: false, loadingComments: false });
      });
  }

  async function readDetail(url: string, epoch: number, read: number, afterWrite = false) {
    const ownsRead = () => current(url, epoch) && read === detailEpoch;
    if (selected(url, epoch) && read === detailEpoch) publish({ refreshingDetail: true });
    try {
      const data = await query.refreshDetail(url, { afterWrite });
      if (ownsRead()) publishDetail(data);
    } catch (cause) {
      if (ownsRead())
        publish({ detailError: cause instanceof Error ? cause.message : String(cause) });
      throw cause;
    } finally {
      if (ownsRead()) publish({ refreshingDetail: false });
    }
  }
  async function refreshDetail(options: { afterWrite?: boolean } = {}) {
    if (disposed) return;
    const url = state.url;
    const epoch = selectionEpoch;
    const read = ++detailEpoch;
    if (url) await readDetail(url, epoch, read, options.afterWrite);
  }
  async function refreshAfterMerge() {
    if (disposed || !state.url) return;
    const url = state.url;
    const epoch = selectionEpoch;
    await query.cancelPrQueries(url);
    await query.invalidatePrQueries(url);
    // The target stays captured across awaits. Only the current selection may
    // acquire detail ownership when this successor starts.
    const read = selected(url, epoch) ? ++detailEpoch : detailEpoch;
    const [extras] = await Promise.all([
      query.refreshExtras(url),
      readDetail(url, epoch, read, true),
      query.refreshList(),
    ]);
    if (selected(url, epoch)) publishExtras(extras);
  }
  return {
    select,
    getState: (): Readonly<PrReadSnapshot> => state,
    subscribe(listener: () => void) {
      if (!disposed) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refreshDetail,
    refreshAfterMerge,
    dispose() {
      if (disposed) return;
      disposed = true;
      selectionEpoch++;
      detailEpoch++;
      unsubscribe();
      listeners.clear();
    },
  };
}
