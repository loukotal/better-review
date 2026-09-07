import { A, useSearchParams } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import { Component, For, Show, createEffect, createSignal, onCleanup } from "solid-js";

import type { AutomaticReviewStatus } from "@better-review/shared";

import { AppHeader } from "../components/AppHeader";
import { Alert, Badge, Button, EmptyState, LoadingState, Select } from "../design-system";
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
import { trpc } from "../lib/trpc";

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
    if (state === "PENDING" || state === "EXPECTED") return "text-warning";
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
    <span
      class={statusColor()}
      title={`CI: ${props.status.passed}/${props.status.total} passed`}
      aria-label={`CI: ${props.status.passed}/${props.status.total} passed`}
    >
      {statusIcon()}
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
  // refetchInterval: refresh periodically while the tab is active
  const prsQuery = useQuery(() => ({
    queryKey: queryKeys.prs.list,
    queryFn: ({ signal }) => api.fetchPrList(signal),
    staleTime: 0,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: false,
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

  const reviewStatuses = useQuery(() => ({
    queryKey: ["automatic-review-statuses", filteredPrs().map((pr) => pr.url)],
    queryFn: () =>
      trpc.flueReview.automaticStatuses.query({ prUrls: filteredPrs().map((pr) => pr.url) }),
    enabled: filteredPrs().length > 0,
    staleTime: 0,
    refetchInterval: 3000,
  }));
  const [launching, setLaunching] = createSignal<Set<string>>(new Set());
  const [launchErrors, setLaunchErrors] = createSignal<Record<string, string>>({});
  const startReview = async (prUrl: string) => {
    if (launching().has(prUrl)) return;
    setLaunching((previous) => new Set(previous).add(prUrl));
    setLaunchErrors((previous) => {
      const next = { ...previous };
      delete next[prUrl];
      return next;
    });
    try {
      let simplifiedEnglish = false;
      try {
        simplifiedEnglish = localStorage.getItem("better-review:use-ste100") === "true";
      } catch {}
      await trpc.flueReview.startAutomatic.mutate({ prUrl, simplifiedEnglish });
      await reviewStatuses.refetch();
    } catch (error) {
      setLaunchErrors((previous) => ({
        ...previous,
        [prUrl]: error instanceof Error ? error.message : "Could not start review",
      }));
    } finally {
      setLaunching((previous) => {
        const next = new Set(previous);
        next.delete(prUrl);
        return next;
      });
    }
  };
  const reviewStatus = (url: string): AutomaticReviewStatus | undefined =>
    launching().has(url)
      ? { state: "starting" }
      : launchErrors()[url]
        ? { state: "failed", error: launchErrors()[url] }
        : reviewStatuses.data?.[url];

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
      <AppHeader constrained />

      {/* Content */}
      <main class="flex-1 overflow-y-auto">
        <div class="mx-auto max-w-6xl px-4 py-4">
          <div class="mb-3 flex items-center justify-between gap-4">
            <div class="flex min-w-0 items-baseline gap-2.5">
              <h1 class="text-lg font-semibold tracking-tight text-text">Reviews</h1>
              <Show when={!prsQuery.isPending}>
                <span class="font-mono text-xs text-text-faint">{filteredPrs().length}</span>
              </Show>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0 whitespace-nowrap">
              <Show when={lastUpdatedText()}>
                <span class="hidden text-xs text-text-faint sm:inline">
                  Updated {lastUpdatedText()}
                </span>
              </Show>
              <Button
                onClick={hardRefresh}
                disabled={hardRefreshing() || prsQuery.isFetching}
                variant="secondary"
                size="xs"
              >
                <Show when={hardRefreshing() || prsQuery.isFetching}>
                  <SpinnerIcon size={12} class="animate-spin" />
                </Show>
                {hardRefreshing() || prsQuery.isFetching ? "Refreshing" : "Refresh"}
              </Button>
            </div>
          </div>

          <div class="mb-3 flex flex-wrap items-center justify-between gap-3 border-y border-border py-1">
            <div
              class="flex items-center gap-1 text-sm"
              role="group"
              aria-label="Filter pull requests"
            >
              <For
                each={[
                  {
                    label: "Needs review",
                    active: showNeedsReview,
                    toggle: () =>
                      setSearchParams({ needsReview: showNeedsReview() ? "0" : undefined }),
                  },
                  {
                    label: "Authored by me",
                    active: showMyPrs,
                    toggle: () => setSearchParams({ mine: showMyPrs() ? undefined : "1" }),
                  },
                  {
                    label: "Drafts",
                    active: showDrafts,
                    toggle: () => setSearchParams({ drafts: showDrafts() ? undefined : "1" }),
                  },
                ]}
              >
                {(filter) => (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    aria-pressed={filter.active()}
                    onClick={filter.toggle}
                    class={`font-medium ${
                      filter.active()
                        ? "bg-bg-elevated text-text"
                        : "text-text-muted hover:text-text hover:bg-bg-surface"
                    }`}
                  >
                    {filter.label}
                  </Button>
                )}
              </For>
            </div>
            <Select
              id="repo-filter"
              aria-label="Filter by repository"
              compact
              value={repoFilter()}
              onChange={(e) => setSearchParams({ repo: e.currentTarget.value || undefined })}
              class={
                repoFilter()
                  ? "border-accent text-accent"
                  : "text-text-muted hover:border-text-faint"
              }
            >
              <option value="">All repos</option>
              <For each={uniqueRepos()}>{(repo) => <option value={repo}>{repo}</option>}</For>
            </Select>
          </div>

          {/* Loading state */}
          <Show when={prsQuery.isPending || (prsQuery.isFetching && filteredPrs().length === 0)}>
            <LoadingState label="Loading pull requests…" />
          </Show>

          {/* Error state */}
          <Show when={prsQuery.isError}>
            <Alert
              intent="danger"
              title="Could not load pull requests"
              actions={
                <Button
                  type="button"
                  size="sm"
                  onClick={() => prsQuery.refetch()}
                  disabled={prsQuery.isFetching}
                >
                  Try again
                </Button>
              }
            >
              {prsQuery.error?.message ?? "Please try again."}
            </Alert>
          </Show>

          {/* Empty state */}
          <Show
            when={
              prsQuery.isSuccess &&
              filteredPrs().length === 0 &&
              !(prsQuery.isPending || prsQuery.isFetching)
            }
          >
            <EmptyState
              title="No matching pull requests"
              description="Change or clear a filter to widen the queue."
            />
          </Show>

          {/* PR list */}
          <Show when={filteredPrs().length > 0}>
            <div class="border-t border-border">
              <For each={filteredPrs()}>
                {(pr) => (
                  <div class="flex items-center gap-2 border-b border-border pr-2 hover:bg-bg-surface">
                    <A
                      href={`/review?prUrl=${encodeURIComponent(pr.url)}&showChat=1`}
                      class="group block min-w-0 flex-1 transition-colors"
                      onMouseDown={() => handleMouseDown(pr.url)}
                    >
                      <div class="flex min-w-0 items-center gap-3 px-2 py-2">
                        <span class="hidden w-48 shrink-0 truncate font-mono text-xs text-text-muted sm:block lg:w-56">
                          {pr.repository.nameWithOwner}#{pr.number}
                        </span>
                        <div class="flex min-w-0 flex-1 items-center gap-2">
                          <span class="truncate text-sm text-text group-hover:text-accent">
                            {pr.title}
                          </span>
                          <Show when={pr.isDraft}>
                            <Badge variant="neutral">Draft</Badge>
                          </Show>
                          <Show when={pr.myReviewState === "APPROVED"}>
                            <Badge variant="success">Approved</Badge>
                          </Show>
                          <Show when={pr.myReviewState === "CHANGES_REQUESTED"}>
                            <Badge variant="danger">Changes requested</Badge>
                          </Show>
                        </div>
                        <span class="hidden w-28 shrink-0 truncate text-xs text-text-muted md:block">
                          @{pr.author.login}
                        </span>
                        <span class="hidden w-16 shrink-0 text-right text-xs text-text-faint sm:block">
                          {formatRelativeTime(pr.createdAt)}
                        </span>
                        <span class="w-4 shrink-0 text-center font-mono text-xs">
                          <CiStatusBadge prUrl={pr.url} ciStatuses={ciStatuses()} />
                        </span>
                      </div>
                    </A>
                    <div class="w-24 shrink-0 text-right">
                      <Show
                        when={reviewStatus(pr.url)}
                        fallback={
                          <span
                            class="text-xs text-text-faint"
                            title={
                              reviewStatuses.isError
                                ? "Could not load review status"
                                : "Loading review status"
                            }
                          >
                            {reviewStatuses.isError ? "Unavailable" : "…"}
                          </span>
                        }
                      >
                        {(status) => (
                          <Show
                            when={status().state === "none" || status().state === "failed"}
                            fallback={
                              <A
                                class={`inline-flex items-center gap-1.5 text-xs ${status().state === "completed" ? "text-success" : "text-text-muted"}`}
                                href={`/review?prUrl=${encodeURIComponent(pr.url)}&showChat=1`}
                              >
                                <Show when={status().state !== "completed"}>
                                  <SpinnerIcon size={12} class="animate-spin text-accent" />
                                </Show>
                                {status().state === "completed"
                                  ? "Review ready"
                                  : status().state === "starting"
                                    ? "Starting"
                                    : "Reviewing"}
                              </A>
                            }
                          >
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => void startReview(pr.url)}
                              title={status().error ?? "Start automatic review"}
                              aria-label={`${status().state === "failed" ? "Retry review" : "Review"} PR ${pr.number}`}
                            >
                              {status().state === "failed" ? "Retry review" : "Review"}
                            </Button>
                          </Show>
                        )}
                      </Show>
                    </div>
                  </div>
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
