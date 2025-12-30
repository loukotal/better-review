import { Component, createSignal, createResource, For, Show } from "solid-js";
import { A } from "@solidjs/router";

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
}

async function fetchPrs(): Promise<SearchedPr[]> {
  const res = await fetch("/api/prs");
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error);
  }
  return data.prs ?? [];
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
  const [prs, { refetch }] = createResource(fetchPrs);

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
        <Show when={!prs.loading && prs()?.length === 0}>
          <div class="text-center py-12 border border-border">
            <div class="text-text-faint text-sm">No review requests</div>
            <p class="text-xs text-text-faint mt-2">
              You're not requested as a reviewer on any open PRs
            </p>
          </div>
        </Show>

        {/* PR list */}
        <Show when={prs()?.length}>
          <div class="space-y-2">
            <For each={prs()}>
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
