import { Component, createResource, For, Show } from "solid-js";
import { A, useSearchParams } from "@solidjs/router";

type ReviewState = "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | null;

interface SearchedPr {
  number: number;
  title: string;
  url: string;
  repository: {
    name: string;
    nameWithOwner: string;
  };
  author: {
    login: string;
  };
  createdAt: string;
  isDraft: boolean;
  myReviewState: ReviewState;
  isAuthor: boolean;
  reviewRequested: boolean;
}

const PR_CACHE_KEY = "prListCache";

function getCachedPrs(): SearchedPr[] | undefined {
  try {
    const cached = localStorage.getItem(PR_CACHE_KEY);
    return cached ? JSON.parse(cached) : undefined;
  } catch {
    return undefined;
  }
}

function setCachedPrs(prs: SearchedPr[]): void {
  localStorage.setItem(PR_CACHE_KEY, JSON.stringify(prs));
}

async function fetchPrs(): Promise<SearchedPr[]> {
  const res = await fetch("/api/prs");
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error);
  }
  const prs = data.prs ?? [];
  setCachedPrs(prs);
  return prs;
}

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
  const cachedPrs = getCachedPrs();
  const [prs, { refetch }] = createResource(fetchPrs, { initialValue: cachedPrs });

  // Filter state from URL params
  const [searchParams, setSearchParams] = useSearchParams();
  const showMyPrs = () => searchParams.mine === "1";
  const showDrafts = () => searchParams.drafts !== "0"; // default true
  const showNeedsReview = () => searchParams.needsReview === "1";
  const repoFilter = () => searchParams.repo ?? "";

  // Get unique repos from PR list
  const uniqueRepos = () => {
    const repos = (prs() ?? []).map(pr => pr.repository.nameWithOwner);
    return [...new Set(repos)].sort();
  };
  
  // Filtered PR list
  const filteredPrs = () => {
    let result = prs() ?? [];
    
    // "My PRs" filter - only show PRs authored by me
    if (showMyPrs()) {
      result = result.filter(pr => pr.isAuthor);
    }
    
    // "Drafts" filter - exclude drafts when off
    if (!showDrafts()) {
      result = result.filter(pr => !pr.isDraft);
    }
    
    // "Needs Review" filter - only show PRs where I need to review
    if (showNeedsReview()) {
      result = result.filter(pr =>
        pr.reviewRequested &&
        pr.myReviewState !== 'APPROVED' &&
        pr.myReviewState !== 'CHANGES_REQUESTED'
      );
    }

    // Repo filter
    if (repoFilter()) {
      result = result.filter(pr => pr.repository.nameWithOwner === repoFilter());
    }

    return result;
  };

  return (
    <div class="min-h-screen bg-bg text-text">
      {/* Header */}
      <header class="border-b border-border bg-bg-surface">
        <div class="px-6 py-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-accent text-xs">●</span>
              <h1 class="text-sm text-text">better-review</h1>
            </div>
            <A
              href="/"
              class="text-xs text-text-faint hover:text-text transition-colors"
            >
              Enter PR URL manually
            </A>
          </div>
        </div>
      </header>

      {/* Content */}
      <main class="max-w-4xl mx-auto px-6 py-8">
        <div class="flex items-center justify-between mb-6">
          <div>
            <h2 class="text-lg font-medium text-text">Review Requests</h2>
            <p class="text-xs text-text-faint mt-1">
              PRs where you're requested as a reviewer or have already reviewed
            </p>
          </div>
          <button
            onClick={() => refetch()}
            disabled={prs.loading}
            class="px-3 py-1.5 text-xs border border-border hover:border-text-faint transition-colors disabled:opacity-50"
          >
            {prs.loading ? "Loading..." : "Refresh"}
          </button>
        </div>

        {/* Filter chips */}
        <div class="flex items-center gap-2 mb-6">
          <span class="text-xs text-text-faint mr-1">Filters:</span>
          <button
            onClick={() => setSearchParams({ mine: showMyPrs() ? undefined : "1" })}
            class={`px-3 py-1 text-xs border transition-colors ${
              showMyPrs()
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-text-faint hover:border-text-faint"
            }`}
          >
            My PRs
          </button>
          <button
            onClick={() => setSearchParams({ drafts: showDrafts() ? "0" : undefined })}
            class={`px-3 py-1 text-xs border transition-colors ${
              showDrafts()
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-text-faint hover:border-text-faint"
            }`}
          >
            Drafts
          </button>
          <button
            onClick={() => setSearchParams({ needsReview: showNeedsReview() ? undefined : "1" })}
            class={`px-3 py-1 text-xs border transition-colors ${
              showNeedsReview()
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-text-faint hover:border-text-faint"
            }`}
          >
            Needs Review
          </button>
          <select
            value={repoFilter()}
            onChange={(e) => setSearchParams({ repo: e.currentTarget.value || undefined })}
            class={`px-3 py-1 text-xs border bg-bg transition-colors cursor-pointer ${
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
        <Show when={prs.loading && !prs()}>
          <div class="text-center py-12">
            <div class="text-text-faint text-sm">Loading PRs...</div>
          </div>
        </Show>

        {/* Error state */}
        <Show when={prs.error}>
          <div class="border border-error/50 bg-diff-remove-bg px-4 py-3 text-sm text-error">
            {prs.error?.message ?? "Failed to load PRs"}
          </div>
        </Show>

        {/* Empty state */}
        <Show when={!prs.loading && filteredPrs().length === 0}>
          <div class="text-center py-12 border border-border">
            <div class="text-text-faint text-sm">No PRs match your filters</div>
            <p class="text-xs text-text-faint mt-2">
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
                  class={`block border border-border hover:border-text-faint transition-colors ${
                    pr.isDraft ? "opacity-50" : ""
                  }`}
                >
                  <div class="px-4 py-3">
                    <div class="flex items-start justify-between gap-4">
                      <div class="flex-1 min-w-0">
                        {/* Repo name */}
                        <div class="text-xs text-text-faint mb-1">
                          {pr.repository.nameWithOwner}
                        </div>
                        {/* PR title */}
                        <div class="flex items-center gap-2">
                          <span class="text-sm text-text truncate">
                            {pr.title}
                          </span>
                          <Show when={pr.isDraft}>
                            <span class="px-1.5 py-0.5 text-[10px] border border-border text-text-faint">
                              DRAFT
                            </span>
                          </Show>
                          <Show when={pr.myReviewState === "APPROVED"}>
                            <span class="px-1.5 py-0.5 text-[10px] border border-accent/50 text-accent">
                              APPROVED
                            </span>
                          </Show>
                          <Show when={pr.myReviewState === "CHANGES_REQUESTED"}>
                            <span class="px-1.5 py-0.5 text-[10px] border border-error/50 text-error">
                              CHANGES REQUESTED
                            </span>
                          </Show>
                        </div>
                        {/* Meta */}
                        <div class="text-xs text-text-faint mt-1.5">
                          #{pr.number} opened {formatRelativeTime(pr.createdAt)}{" "}
                          by {pr.author.login}
                        </div>
                      </div>
                      {/* Arrow indicator */}
                      <div class="text-text-faint text-sm mt-1">→</div>
                    </div>
                  </div>
                </A>
              )}
            </For>
          </div>
        </Show>
      </main>
    </div>
  );
};

export default PrListPage;
