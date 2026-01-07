import { QueryClient } from "@tanstack/solid-query";
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import { get, set, del, createStore } from "idb-keyval";
import type { PrCommit, PRComment, PrStatus, CiStatus, SearchedPr } from "@better-review/shared";

// Create a dedicated IndexedDB store for query cache
const queryStore = createStore("better-review-query", "cache");
const CACHE_KEY = "tanstack-query-cache";

// Create QueryClient with sensible defaults
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Keep data fresh for 5 minutes
      staleTime: 5 * 60 * 1000,
      // Cache for 24 hours
      gcTime: 24 * 60 * 60 * 1000,
      // Retry failed requests 2 times
      retry: 2,
      // Don't refetch on window focus (can be annoying for code review)
      refetchOnWindowFocus: false,
    },
  },
});

// Set up persistence to IndexedDB
export function restoreCache(): void {
  persistQueryClient({
    queryClient,
    persister: {
      persistClient: async (client) => {
        await set(CACHE_KEY, client, queryStore);
      },
      restoreClient: async () => {
        return await get(CACHE_KEY, queryStore);
      },
      removeClient: async () => {
        await del(CACHE_KEY, queryStore);
      },
    },
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  });
}

// Issue comment type (top-level PR conversation comments)
export interface IssueComment {
  id: number;
  body: string;
  html_url: string;
  user: { login: string; avatar_url: string };
  created_at: string;
  updated_at: string;
}

// Query key factories for type-safe keys
export const queryKeys = {
  pr: {
    all: ["pr"] as const,
    batch: (url: string) => ["pr", "batch", url] as const,
    diff: (url: string) => ["pr", "diff", url] as const,
    info: (url: string) => ["pr", "info", url] as const,
    commits: (url: string) => ["pr", "commits", url] as const,
    commitDiff: (url: string, sha: string) => ["pr", "commitDiff", url, sha] as const,
    commitDiffsBatch: (url: string) => ["pr", "commitDiffsBatch", url] as const,
    comments: (url: string) => ["pr", "comments", url] as const,
    issueComments: (url: string) => ["pr", "issueComments", url] as const,
    status: (url: string) => ["pr", "status", url] as const,
    ciStatus: (url: string) => ["pr", "ci-status", url] as const,
    ciStatusBatch: (urls: string[]) => ["pr", "ci-status-batch", urls.toSorted().join(",")] as const,
  },
  prs: {
    list: ["prs", "list"] as const,
  },
  user: {
    current: ["user", "current"] as const,
  },
};

// API fetch functions
export const api = {
  async fetchDiff(url: string, signal?: AbortSignal): Promise<string> {
    const res = await fetch(`/api/pr/diff?url=${encodeURIComponent(url)}`, { signal });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.diff;
  },

  async fetchInfo(url: string, signal?: AbortSignal): Promise<{ owner: string; repo: string; number: string } | null> {
    const res = await fetch(`/api/pr/info?url=${encodeURIComponent(url)}`, { signal });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.owner && data.repo && data.number) {
      return { owner: data.owner, repo: data.repo, number: data.number };
    }
    return null;
  },

  async fetchCommits(url: string, signal?: AbortSignal): Promise<PrCommit[]> {
    const res = await fetch(`/api/pr/commits?url=${encodeURIComponent(url)}`, { signal });
    const data = await res.json();
    return data.commits ?? [];
  },

  async fetchCommitDiff(url: string, sha: string, signal?: AbortSignal): Promise<string> {
    const res = await fetch(`/api/pr/commit-diff?url=${encodeURIComponent(url)}&sha=${sha}`, { signal });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.diff;
  },

  async fetchComments(url: string, signal?: AbortSignal): Promise<PRComment[]> {
    const res = await fetch(`/api/pr/comments?url=${encodeURIComponent(url)}`, { signal });
    const data = await res.json();
    return data.comments ?? [];
  },

  async fetchIssueComments(url: string, signal?: AbortSignal): Promise<IssueComment[]> {
    const res = await fetch(`/api/pr/issue-comments?url=${encodeURIComponent(url)}`, { signal });
    const data = await res.json();
    return data.comments ?? [];
  },

  async fetchStatus(url: string, signal?: AbortSignal): Promise<PrStatus> {
    const res = await fetch(`/api/pr/status?url=${encodeURIComponent(url)}`, { signal });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  },

  async fetchPrList(signal?: AbortSignal): Promise<SearchedPr[]> {
    const res = await fetch("/api/prs", { signal });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.prs ?? [];
  },

  async fetchPrCiStatus(prUrl: string, signal?: AbortSignal): Promise<CiStatus | null> {
    const res = await fetch(`/api/prs/ci-status?url=${encodeURIComponent(prUrl)}`, { signal });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.ciStatus ?? null;
  },

  async fetchCiStatusBatch(urls: string[], signal?: AbortSignal): Promise<Record<string, CiStatus | null>> {
    const res = await fetch("/api/prs/ci-status/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
      signal,
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.statuses ?? {};
  },

  async fetchCommitDiffsBatch(url: string, signal?: AbortSignal): Promise<Record<string, string | null>> {
    const res = await fetch(`/api/pr/commit-diffs/batch?url=${encodeURIComponent(url)}`, { signal });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.diffs ?? {};
  },

  async fetchCurrentUser(signal?: AbortSignal): Promise<string | null> {
    const res = await fetch("/api/user", { signal });
    const data = await res.json();
    return data.login ?? null;
  },

  async fetchPrBatch(
    url: string,
    signal?: AbortSignal,
  ): Promise<{
    diff: string;
    info: { owner: string; repo: string; number: string };
    commits: PrCommit[];
    comments: PRComment[];
    issueComments: IssueComment[];
    status: PrStatus;
  }> {
    const res = await fetch(`/api/pr/batch?url=${encodeURIComponent(url)}`, { signal });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  },
};

// Prefetch a full PR using batch endpoint (single request)
export async function prefetchPr(url: string): Promise<void> {
  // Check if batch is already cached
  const existingBatch = queryClient.getQueryData(queryKeys.pr.batch(url));
  if (existingBatch) return;

  try {
    // Use prefetchQuery so it respects staleTime and doesn't duplicate requests
    await queryClient.prefetchQuery({
      queryKey: queryKeys.pr.batch(url),
      queryFn: () => api.fetchPrBatch(url),
      staleTime: 5 * 60 * 1000, // 5 minutes
    });

    // Get the fetched data and populate individual caches
    const data = queryClient.getQueryData<Awaited<ReturnType<typeof api.fetchPrBatch>>>(queryKeys.pr.batch(url));
    if (data) {
      queryClient.setQueryData(queryKeys.pr.diff(url), data.diff);
      queryClient.setQueryData(queryKeys.pr.info(url), data.info);
      queryClient.setQueryData(queryKeys.pr.commits(url), data.commits);
      queryClient.setQueryData(queryKeys.pr.comments(url), data.comments);
      queryClient.setQueryData(queryKeys.pr.issueComments(url), data.issueComments);
      queryClient.setQueryData(queryKeys.pr.status(url), data.status);

      // Prefetch commit diffs in background
      if (data.commits.length > 0) {
        prefetchCommitDiffs(url, data.commits);
      }
    }
  } catch (e) {
    console.error("Failed to prefetch PR:", e);
  }
}

// Prefetch all commit diffs for a PR using batch endpoint
export async function prefetchCommitDiffs(url: string, commits: PrCommit[]): Promise<void> {
  if (commits.length === 0) return;

  // Check if already cached
  const existingBatch = queryClient.getQueryData(queryKeys.pr.commitDiffsBatch(url));
  if (existingBatch) return;

  try {
    const diffs = await api.fetchCommitDiffsBatch(url);

    // Populate individual query caches
    for (const [sha, diff] of Object.entries(diffs)) {
      if (diff) {
        queryClient.setQueryData(queryKeys.pr.commitDiff(url, sha), diff);
      }
    }

    // Mark batch as complete
    queryClient.setQueryData(queryKeys.pr.commitDiffsBatch(url), diffs);
  } catch (e) {
    console.error("Failed to prefetch commit diffs:", e);
  }
}

// Prefetch CI statuses for multiple PRs using batch endpoint
export async function prefetchCiStatuses(urls: string[]): Promise<void> {
  if (urls.length === 0) return;

  // Filter out already cached URLs
  const uncachedUrls = urls.filter(
    (url) => !queryClient.getQueryData(queryKeys.pr.ciStatus(url))
  );

  if (uncachedUrls.length === 0) return;

  try {
    const statuses = await api.fetchCiStatusBatch(uncachedUrls);

    // Populate individual query caches
    for (const [url, status] of Object.entries(statuses)) {
      queryClient.setQueryData(queryKeys.pr.ciStatus(url), status);
    }
  } catch (e) {
    console.error("Failed to prefetch CI statuses:", e);
  }
}

// Re-export shared types for convenience
export type { CiStatus, SearchedPr, PrStatus, PrCommit, PRComment };
