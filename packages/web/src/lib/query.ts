import { QueryClient } from "@tanstack/solid-query";
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import { get, set, del, createStore } from "idb-keyval";
import type { PrCommit, PRComment, PrStatus, CiStatus, SearchedPr } from "@better-review/shared";
import { trpc } from "./trpc";

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

// API fetch functions using tRPC
export const api = {
  async fetchDiff(url: string, _signal?: AbortSignal): Promise<string> {
    const result = await trpc.pr.diff.query({ url });
    return result.diff;
  },

  async fetchInfo(url: string, _signal?: AbortSignal): Promise<{ owner: string; repo: string; number: string } | null> {
    const result = await trpc.pr.info.query({ url });
    if (result.owner && result.repo && result.number) {
      return { owner: result.owner, repo: result.repo, number: result.number };
    }
    return null;
  },

  async fetchCommits(url: string, _signal?: AbortSignal): Promise<PrCommit[]> {
    const result = await trpc.pr.commits.query({ url });
    return [...(result.commits ?? [])];
  },

  async fetchCommitDiff(url: string, sha: string, _signal?: AbortSignal): Promise<string> {
    const result = await trpc.pr.commitDiff.query({ url, sha });
    return result.diff;
  },

  async fetchComments(url: string, _signal?: AbortSignal): Promise<PRComment[]> {
    const result = await trpc.pr.comments.query({ url });
    return [...(result.comments ?? [])];
  },

  async fetchIssueComments(url: string, _signal?: AbortSignal): Promise<IssueComment[]> {
    const result = await trpc.pr.issueComments.query({ url });
    return [...(result.comments ?? [])] as IssueComment[];
  },

  async fetchStatus(url: string, _signal?: AbortSignal): Promise<PrStatus> {
    const result = await trpc.pr.status.query({ url });
    return result;
  },

  async fetchPrList(_signal?: AbortSignal): Promise<SearchedPr[]> {
    const result = await trpc.prs.list.query();
    return [...(result.prs ?? [])];
  },

  async fetchPrCiStatus(prUrl: string, _signal?: AbortSignal): Promise<CiStatus | null> {
    const result = await trpc.prs.ciStatus.query({ url: prUrl });
    return result.ciStatus ?? null;
  },

  async fetchCiStatusBatch(urls: string[], _signal?: AbortSignal): Promise<Record<string, CiStatus | null>> {
    const result = await trpc.prs.ciStatusBatch.query({ urls });
    return result.statuses ?? {};
  },

  async fetchCommitDiffsBatch(url: string, _signal?: AbortSignal): Promise<Record<string, string | null>> {
    const result = await trpc.pr.commitDiffsBatch.query({ url });
    return result.diffs ?? {};
  },

  async fetchCurrentUser(_signal?: AbortSignal): Promise<string | null> {
    const result = await trpc.user.current.query();
    return result.login ?? null;
  },

  async fetchPrBatch(
    url: string,
    _signal?: AbortSignal,
  ): Promise<{
    diff: string;
    info: { owner: string; repo: string; number: string };
    commits: PrCommit[];
    comments: PRComment[];
    issueComments: IssueComment[];
    status: PrStatus;
  }> {
    const result = await trpc.pr.batch.query({ url });
    return {
      diff: result.diff,
      info: result.info,
      commits: [...result.commits],
      comments: [...result.comments],
      issueComments: [...result.issueComments] as IssueComment[],
      status: result.status,
    };
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
