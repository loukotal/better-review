import { A, useSearchParams } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";

import { Badge, Button, Select } from "../design-system";
import { SpinnerIcon } from "../icons/spinner-icon";
import {
  queryKeys,
  api,
  prefetchPr,
  prefetchCiStatuses,
  queryClient,
  type SearchedPr,
  type CiStatus,
} from "../lib/query";

// CI status indicator component (used when status is already loaded)
const CiStatusBadgeInner: Component<{ status: CiStatus }> = (props) => {
  const statusColor = () => {
    const { state, passed, total } = props.status;
    if (state === "SUCCESS" || passed === total) return "text-success";
    if (
      state === "FAILURE" ||
      state === "ERROR" ||
      (passed < total && state !== "PENDING" && state !== "EXPECTED")
    )
      return "text-error";
    if (state === "PENDING" || state === "EXPECTED") return "text-yellow-500";
    return "text-text-faint";
  };

  const statusIcon = () => {
    const { state, passed, total } = props.status;
    if (state === "SUCCESS" || passed === total) return "✓";
    if (state === "FAILURE" || state === "ERROR") return "✗";
    if (state === "PENDING" || state === "EXPECTED") return "◷";
    return "○";
  };

  return (
    <span class={statusColor()} title={`CI: ${props.status.passed}/${props.status.total} passed`}>
      {statusIcon()} {props.status.passed}/{props.status.total}
    </span>
  );
};

// CI status badge - reads from cache (populated by batch fetch)
const CiStatusBadge: Component<{ prUrl: string; ciStatuses: Record<string, CiStatus | null> }> = (
  props,
) => {
  const status = () => props.ciStatuses[props.prUrl];

  return <Show when={status()}>{(s) => <CiStatusBadgeInner status={s()} />}</Show>;
};

// Lines changed indicator
const LinesChanged: Component<{ additions: number; deletions: number }> = (props) => {
  const format = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return n.toString();
  };

  return (
    <span class="font-mono">
      <span class="text-diff-add-text">+{format(props.additions)}</span>
      <span class="text-text-faint mx-0.5">/</span>
      <span class="text-diff-remove-text">-{format(props.deletions)}</span>
    </span>
  );
};

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else if (diffDays === 1) {
    return "yesterday";
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else {
    return date.toLocaleDateString();
  }
}

const PrListPage: Component = () => {
  // Use TanStack Query for PR list - automatically cached in IndexedDB
  // staleTime: 0 ensures we always fetch fresh data on mount while showing cached immediately
  // refetchInterval: refresh every minute, but not when tab is in background
  const prsQuery = useQuery(() => ({
    queryKey: queryKeys.prs.list,
    queryFn: ({ signal }) => api.fetchPrList(signal),
    staleTime: 0,
    refetchInterval: 60 * 1000,
    refetchIntervalInBackground: true,
  }));

  // Convenience accessor: extract the PR list from the query result
  const prs = () => prsQuery.data?.prs ?? [];

  // If the backend returned stale cached data (fetchedAt older than 30s),
  // trigger an immediate hard refetch so fresh data arrives quickly.
  // The backend's getAndRefresh kicks off a background refresh, so the
  // second request should get fresh data.
  const STALE_THRESHOLD_MS = 30 * 1000;
  let staleRefetchDone = false;
  createEffect(() => {
    const data = prsQuery.data;
    if (!data?.fetchedAt || prsQuery.isFetching || staleRefetchDone) return;
    const age = Date.now() - data.fetchedAt;
    if (age > STALE_THRESHOLD_MS) {
      staleRefetchDone = true;
      prsQuery.refetch();
    }
  });

  // Auto-updating "last updated" display — ticks every 15s
  const [now, setNow] = createSignal(Date.now());
  const nowInterval = setInterval(() => setNow(Date.now()), 15_000);
  onCleanup(() => clearInterval(nowInterval));

  const lastUpdatedText = () => {
    const fetchedAt = prsQuery.data?.fetchedAt;
    if (!fetchedAt) return null;
    const ageMs = now() - fetchedAt;
    const seconds = Math.floor(ageMs / 1000);
    if (seconds < 10) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  // Hard refresh: bypasses backend cache, fetches live from GitHub
  const [hardRefreshing, setHardRefreshing] = createSignal(false);
  const hardRefresh = async () => {
    setHardRefreshing(true);
    try {
      const fresh = await api.refreshPrList();
      // Update the query cache with the fresh data so the UI updates immediately
      queryClient.setQueryData(queryKeys.prs.list, fresh);
    } catch (e) {
      console.error("Hard refresh failed:", e);
    } finally {
      setHardRefreshing(false);
    }
  };

  // CI statuses fetched via batch
  const [ciStatuses, setCiStatuses] = createSignal<Record<string, CiStatus | null>>({});

  // Prefetch on mousedown (user intent to click)
  const handleMouseDown = (prUrl: string) => {
    prefetchPr(prUrl);
  };

  // Filter state from URL params
  const [searchParams, setSearchParams] = useSearchParams();
  const showMyPrs = () => searchParams.mine === "1";
  const showDrafts = () => searchParams.drafts === "1";
  const showNeedsReview = () => searchParams.needsReview !== "0";
  const repoFilter = () => searchParams.repo ?? "";

  // Get unique repos from PR list
  const uniqueRepos = () => {
    const repos = prs().map((pr: SearchedPr) => pr.repository.nameWithOwner);
    return [...new Set(repos)].sort();
  };

  // Filtered PR list
  const filteredPrs = () => {
    let result = prs();

    if (showMyPrs()) {
      result = result.filter((pr: SearchedPr) => pr.isAuthor);
    }

    if (!showDrafts()) {
      result = result.filter((pr: SearchedPr) => !pr.isDraft);
    }

    if (showNeedsReview()) {
      result = result.filter(
        (pr: SearchedPr) =>
          pr.reviewRequested &&
          pr.myReviewState !== "APPROVED" &&
          pr.myReviewState !== "CHANGES_REQUESTED",
      );
    }

    if (repoFilter()) {
      result = result.filter((pr: SearchedPr) => pr.repository.nameWithOwner === repoFilter());
    }

    return result;
  };

  // Prefetch first 5 PRs in the filtered list
  createEffect(() => {
    const prs = filteredPrs().slice(0, 5);
    prs.forEach((pr) => prefetchPr(pr.url));
  });

  // Batch fetch CI statuses for all visible PRs (debounced)
  let ciStatusTimeout: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const prs = filteredPrs();
    if (prs.length > 0) {
      const urls = prs.map((pr) => pr.url);

      // Debounce to avoid rapid requests when filters change quickly
      clearTimeout(ciStatusTimeout);
      ciStatusTimeout = setTimeout(async () => {
        try {
          // Use prefetchCiStatuses which has caching logic to skip already-cached URLs
          await prefetchCiStatuses(urls);

          // Read from query cache and update local signal
          const statuses: Record<string, CiStatus | null> = {};
          for (const url of urls) {
            const cached = queryClient.getQueryData<CiStatus | null>(queryKeys.pr.ciStatus(url));
            if (cached !== undefined) {
              statuses[url] = cached;
            }
          }
          setCiStatuses((prev) => ({ ...prev, ...statuses }));
        } catch (e) {
          console.error("Failed to fetch CI statuses:", e);
        }
      }, 100);
    }

    onCleanup(() => clearTimeout(ciStatusTimeout));
  });

  return (
    <div class="h-screen bg-bg text-text flex flex-col">
      {/* Header */}
      <header class="border-b border-border bg-bg-surface flex-shrink-0">
        <div class="px-6 py-4">
          <div class="flex items-center justify-between">
            <A href="/" class="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <span class="text-accent text-base">●</span>
              <h1 class="text-base text-text">better-review</h1>
            </A>
            <A href="/review" class="text-base text-text-faint hover:text-text transition-colors">
              Enter PR URL manually
            </A>
          </div>
        </div>
      </header>

      {/* Content */}
      <main class="flex-1 overflow-y-auto">
        <div class="max-w-4xl mx-auto px-6 py-8">
          <div class="flex items-center justify-between mb-6">
            <div>
              <h2 class="text-lg font-medium text-text">Review Requests</h2>
              <p class="text-base text-text-faint mt-1">
                PRs where you're requested as a reviewer or have already reviewed
              </p>
            </div>
            <div class="flex items-center gap-3 flex-shrink-0 whitespace-nowrap">
              <Show when={lastUpdatedText()}>
                <span class="text-sm text-text-faint">Updated {lastUpdatedText()}</span>
              </Show>
              <Button
                onClick={hardRefresh}
                disabled={hardRefreshing() || prsQuery.isFetching}
                variant="secondary"
                size="md"
                class="text-base"
              >
                <Show when={hardRefreshing() || prsQuery.isFetching}>
                  <SpinnerIcon size={12} class="animate-spin" />
                </Show>
                {hardRefreshing() || prsQuery.isFetching ? "Refreshing" : "Refresh"}
              </Button>
            </div>
          </div>

          {/* Filter chips */}
          <div class="flex items-center gap-2 mb-6 text-sm">
            <span class="text-text-faint mr-1">Filters:</span>
            <Button
              onClick={() => setSearchParams({ mine: showMyPrs() ? undefined : "1" })}
              variant="secondary"
              size="sm"
              class={
                showMyPrs()
                  ? "border-accent bg-accent/10 text-accent hover:text-accent hover:border-accent"
                  : "text-text-faint"
              }
            >
              My PRs
            </Button>
            <Button
              onClick={() => setSearchParams({ drafts: showDrafts() ? undefined : "1" })}
              variant="secondary"
              size="sm"
              class={
                showDrafts()
                  ? "border-accent bg-accent/10 text-accent hover:text-accent hover:border-accent"
                  : "text-text-faint"
              }
            >
              Drafts
            </Button>
            <Button
              onClick={() =>
                setSearchParams({
                  needsReview: showNeedsReview() ? "0" : undefined,
                })
              }
              variant="secondary"
              size="sm"
              class={
                showNeedsReview()
                  ? "border-accent bg-accent/10 text-accent hover:text-accent hover:border-accent"
                  : "text-text-faint"
              }
            >
              Needs Review
            </Button>
            <Select
              id="repo-filter"
              compact
              value={repoFilter()}
              onChange={(e) => setSearchParams({ repo: e.currentTarget.value || undefined })}
              class={
                repoFilter()
                  ? "border-accent bg-accent/10 text-accent"
                  : "text-text-faint hover:border-text-faint"
              }
            >
              <option value="">All repos</option>
              <For each={uniqueRepos()}>{(repo) => <option value={repo}>{repo}</option>}</For>
            </Select>
          </div>

          {/* Loading state */}
          <Show when={prsQuery.isPending || (prsQuery.isFetching && filteredPrs().length === 0)}>
            <div class="text-center py-12">
              <div class="flex items-center justify-center gap-2 text-text-faint text-base">
                <SpinnerIcon size={14} class="animate-spin" />
                Loading PRs...
              </div>
            </div>
          </Show>

          {/* Error state */}
          <Show when={prsQuery.isError}>
            <div class="border border-error/50 bg-diff-remove-bg px-4 py-3 text-base text-error">
              {prsQuery.error?.message ?? "Failed to load PRs"}
            </div>
          </Show>

          {/* Empty state */}
          <Show
            when={
              prsQuery.isSuccess &&
              filteredPrs().length === 0 &&
              !(prsQuery.isPending || prsQuery.isFetching)
            }
          >
            <div class="text-center py-12 border border-border">
              <div class="text-text-faint text-base">No PRs match your filters</div>
              <p class="text-base text-text-faint mt-2">Try adjusting your filter settings</p>
            </div>
          </Show>

          {/* PR list */}
          <Show when={filteredPrs().length > 0}>
            <div class="space-y-2">
              <For each={filteredPrs()}>
                {(pr) => (
                  <A
                    href={`/review?prUrl=${encodeURIComponent(pr.url)}`}
                    class="block border border-border hover:border-text-faint transition-colors"
                    onMouseDown={() => handleMouseDown(pr.url)}
                  >
                    <div class="px-4 py-3">
                      <div class="flex items-start justify-between gap-4">
                        <div class="flex-1 min-w-0">
                          <div class="text-sm text-text-faint mb-1">
                            {pr.repository.nameWithOwner}
                          </div>
                          <div class="flex items-center gap-2">
                            <span class="text-sm text-text truncate">{pr.title}</span>
                            <Show when={pr.isDraft}>
                              <Badge
                                variant="neutral"
                                class="text-sm border-text-faint/50 bg-text-faint/10 text-text-muted"
                              >
                                DRAFT
                              </Badge>
                            </Show>
                            <Show when={pr.myReviewState === "APPROVED"}>
                              <Badge variant="accent" class="text-sm">
                                APPROVED
                              </Badge>
                            </Show>
                            <Show when={pr.myReviewState === "CHANGES_REQUESTED"}>
                              <Badge variant="danger" class="text-sm">
                                CHANGES REQUESTED
                              </Badge>
                            </Show>
                          </div>
                          <div class="text-sm text-text-faint mt-1.5 flex items-center justify-between">
                            <span>
                              #{pr.number} opened {formatRelativeTime(pr.createdAt)} by{" "}
                              {pr.author.login}
                            </span>
                            <span class="flex items-center gap-3 text-sm">
                              <LinesChanged additions={pr.additions} deletions={pr.deletions} />
                              <CiStatusBadge prUrl={pr.url} ciStatuses={ciStatuses()} />
                            </span>
                          </div>
                        </div>
                        <div class="text-text-faint text-sm mt-1">→</div>
                      </div>
                    </div>
                  </A>
                )}
              </For>
            </div>
          </Show>
        </div>
      </main>
    </div>
  );
};

export default PrListPage;
