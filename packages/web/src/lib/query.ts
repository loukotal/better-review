import { QueryClient } from "@tanstack/solid-query";
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import { get, set, del, createStore } from "idb-keyval";
import type { PrCommit, PRComment } from "../diff/types";
import type { PrStatus } from "../components/PrStatusBar";

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

// Query key factories for type-safe keys
export const queryKeys = {
  pr: {
    all: ["pr"] as const,
    diff: (url: string) => ["pr", "diff", url] as const,
    info: (url: string) => ["pr", "info", url] as const,
    commits: (url: string) => ["pr", "commits", url] as const,
    commitDiff: (url: string, sha: string) => ["pr", "commitDiff", url, sha] as const,
    comments: (url: string) => ["pr", "comments", url] as const,
    status: (url: string) => ["pr", "status", url] as const,
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

  async fetchCurrentUser(signal?: AbortSignal): Promise<string | null> {
    const res = await fetch("/api/user", { signal });
    const data = await res.json();
    return data.login ?? null;
  },
};

// Prefetch a full PR (all related data)
export async function prefetchPr(url: string): Promise<void> {
  await Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.pr.diff(url),
      queryFn: ({ signal }) => api.fetchDiff(url, signal),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.pr.info(url),
      queryFn: ({ signal }) => api.fetchInfo(url, signal),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.pr.commits(url),
      queryFn: ({ signal }) => api.fetchCommits(url, signal),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.pr.comments(url),
      queryFn: ({ signal }) => api.fetchComments(url, signal),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.pr.status(url),
      queryFn: ({ signal }) => api.fetchStatus(url, signal),
    }),
  ]);

  // After fetching commits, prefetch all commit diffs
  const commits = queryClient.getQueryData<PrCommit[]>(queryKeys.pr.commits(url));
  if (commits && commits.length > 0) {
    // Prefetch commit diffs in background (don't await)
    prefetchCommitDiffs(url, commits);
  }
}

// Prefetch all commit diffs for a PR (runs sequentially to avoid overwhelming server)
export async function prefetchCommitDiffs(url: string, commits: PrCommit[]): Promise<void> {
  for (const commit of commits) {
    await queryClient.prefetchQuery({
      queryKey: queryKeys.pr.commitDiff(url, commit.sha),
      queryFn: ({ signal }) => api.fetchCommitDiff(url, commit.sha, signal),
    });
  }
}

// Types for PR list
export interface CiStatus {
  passed: number;
  total: number;
  state: "SUCCESS" | "FAILURE" | "PENDING" | "EXPECTED" | "ERROR" | "NEUTRAL";
}

export interface SearchedPr {
  number: number;
  title: string;
  url: string;
  repository: { name: string; nameWithOwner: string };
  author: { login: string };
  createdAt: string;
  isDraft: boolean;
  myReviewState: string | null;
  isAuthor: boolean;
  reviewRequested: boolean;
  additions: number;
  deletions: number;
  ciStatus: CiStatus | null;
}
