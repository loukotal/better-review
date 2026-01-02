import { Component, For, Show } from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import {
  queryKeys,
  api,
  prefetchPr,
  type SearchedPr,
  type CiStatus,
} from "../lib/query";

// CI status indicator component
const CiStatusBadge: Component<{ status: CiStatus | null }> = (props) => {
  const statusColor = () => {
    if (!props.status) return "text-text-faint";
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
    if (!props.status) return "○";
    const { state, passed, total } = props.status;
    if (state === "SUCCESS" || passed === total) return "✓";
    if (state === "FAILURE" || state === "ERROR") return "✗";
    if (state === "PENDING" || state === "EXPECTED") return "◷";
    return "○";
  };

  return (
    <Show when={props.status} fallback={null}>
      {(status) => (
        <span
          class={`${statusColor()}`}
          title={`CI: ${status().passed}/${status().total} passed`}
        >
          {statusIcon()} {status().passed}/{status().total}
        </span>
      )}
    </Show>
  );
};

// Lines changed indicator
const LinesChanged: Component<{ additions: number; deletions: number }> = (
  props,
) => {
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
  const prsQuery = useQuery(() => ({
    queryKey: queryKeys.prs.list,
    queryFn: ({ signal }) => api.fetchPrList(signal),
    staleTime: 0,
  }));

  // Prefetch on mousedown (user intent to click)
  const handleMouseDown = (prUrl: string) => {
    prefetchPr(prUrl);
  };

  // Filter state from URL params
  const [searchParams, setSearchParams] = useSearchParams();
  const showMyPrs = () => searchParams.mine === "1";
  const showDrafts = () => searchParams.drafts !== "0";
  const showNeedsReview = () => searchParams.needsReview === "1";
  const repoFilter = () => searchParams.repo ?? "";

  // Get unique repos from PR list
  const uniqueRepos = () => {
    const repos = (prsQuery.data ?? []).map(
      (pr: SearchedPr) => pr.repository.nameWithOwner,
    );
    return [...new Set(repos)].sort();
  };

  // Filtered PR list
  const filteredPrs = () => {
    let result = prsQuery.data ?? [];

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
      result = result.filter(
        (pr: SearchedPr) => pr.repository.nameWithOwner === repoFilter(),
      );
    }

    return result;
  };

  return (
    <div class="h-screen bg-bg text-text flex flex-col">
      {/* Header */}
      <header class="border-b border-border bg-bg-surface flex-shrink-0">
        <div class="px-6 py-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-accent text-base">●</span>
              <h1 class="text-base text-text">better-review</h1>
            </div>
            <A
              href="/"
              class="text-base text-text-faint hover:text-text transition-colors"
            >
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
          <button
            onClick={() => prsQuery.refetch()}
            disabled={prsQuery.isFetching}
            class="px-3 py-1.5 text-base border border-border hover:border-text-faint transition-colors disabled:opacity-50"
          >
            {prsQuery.isFetching ? "Loading..." : "Refresh"}
          </button>
        </div>

        {/* Filter chips */}
        <div class="flex items-center gap-2 mb-6 text-sm">
          <span class="text-text-faint mr-1">Filters:</span>
          <button
            onClick={() =>
              setSearchParams({ mine: showMyPrs() ? undefined : "1" })
            }
            class={`px-3 py-1 border transition-colors ${
              showMyPrs()
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-text-faint hover:border-text-faint"
            }`}
          >
            My PRs
          </button>
          <button
            onClick={() =>
              setSearchParams({ drafts: showDrafts() ? "0" : undefined })
            }
            class={`px-3 py-1 border transition-colors ${
              showDrafts()
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-text-faint hover:border-text-faint"
            }`}
          >
            Drafts
          </button>
          <button
            onClick={() =>
              setSearchParams({
                needsReview: showNeedsReview() ? undefined : "1",
              })
            }
            class={`px-3 py-1 border transition-colors ${
              showNeedsReview()
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-text-faint hover:border-text-faint"
            }`}
          >
            Needs Review
          </button>
          <select
            id="repo-filter"
            value={repoFilter()}
            onChange={(e) =>
              setSearchParams({ repo: e.currentTarget.value || undefined })
            }
            class={`px-3 py-1 border bg-bg transition-colors cursor-pointer ${
              repoFilter()
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-text-faint hover:border-text-faint"
            }`}
          >
            <option value="">All repos</option>
            <For each={uniqueRepos()}>
              {(repo) => <option value={repo}>{repo}</option>}
            </For>
          </select>
        </div>

        {/* Loading state */}
        <Show when={prsQuery.isPending}>
          <div class="text-center py-12">
            <div class="text-text-faint text-base">Loading PRs...</div>
          </div>
        </Show>

        {/* Error state */}
        <Show when={prsQuery.isError}>
          <div class="border border-error/50 bg-diff-remove-bg px-4 py-3 text-base text-error">
            {prsQuery.error?.message ?? "Failed to load PRs"}
          </div>
        </Show>

        {/* Empty state */}
        <Show when={prsQuery.isSuccess && filteredPrs().length === 0}>
          <div class="text-center py-12 border border-border">
            <div class="text-text-faint text-base">No PRs match your filters</div>
            <p class="text-base text-text-faint mt-2">
              Try adjusting your filter settings
            </p>
          </div>
        </Show>

        {/* PR list */}
        <Show when={filteredPrs().length > 0}>
          <div class="space-y-2">
            <For each={filteredPrs()}>
              {(pr) => (
                <A
                  href={`/?prUrl=${encodeURIComponent(pr.url)}`}
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
                          <span class="text-sm text-text truncate">
                            {pr.title}
                          </span>
                          <Show when={pr.isDraft}>
                            <span class="px-1.5 py-0.5 text-sm border border-text-faint/50 bg-text-faint/10 text-text-muted">
                              DRAFT
                            </span>
                          </Show>
                          <Show when={pr.myReviewState === "APPROVED"}>
                            <span class="px-1.5 py-0.5 text-sm border border-accent/50 text-accent">
                              APPROVED
                            </span>
                          </Show>
                          <Show when={pr.myReviewState === "CHANGES_REQUESTED"}>
                            <span class="px-1.5 py-0.5 text-sm border border-error/50 text-error">
                              CHANGES REQUESTED
                            </span>
                          </Show>
                        </div>
                        <div class="text-sm text-text-faint mt-1.5 flex items-center justify-between">
                          <span>
                            #{pr.number} opened{" "}
                            {formatRelativeTime(pr.createdAt)} by{" "}
                            {pr.author.login}
                          </span>
                          <span class="flex items-center gap-3 text-sm">
                            <LinesChanged
                              additions={pr.additions}
                              deletions={pr.deletions}
                            />
                            <CiStatusBadge status={pr.ciStatus} />
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
