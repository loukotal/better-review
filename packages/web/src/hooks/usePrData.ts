import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { createMemo, createEffect } from "solid-js";
import { queryKeys, api, prefetchCommitDiffs, type PrCommit, type PRComment } from "../lib/query";

/**
 * Custom hook that manages all PR data fetching using TanStack Query.
 * Provides unified access to diff, info, commits, comments, status, and commit diffs.
 */
export function usePrData(prUrl: () => string | null) {
  const queryClient = useQueryClient();

  // Main PR diff query
  const diffQuery = useQuery(() => ({
    queryKey: queryKeys.pr.diff(prUrl() ?? ""),
    queryFn: ({ signal }) => api.fetchDiff(prUrl()!, signal),
    enabled: !!prUrl(),
  }));

  // PR info query
  const infoQuery = useQuery(() => ({
    queryKey: queryKeys.pr.info(prUrl() ?? ""),
    queryFn: ({ signal }) => api.fetchInfo(prUrl()!, signal),
    enabled: !!prUrl(),
  }));

  // Commits list query
  const commitsQuery = useQuery(() => ({
    queryKey: queryKeys.pr.commits(prUrl() ?? ""),
    queryFn: ({ signal }) => api.fetchCommits(prUrl()!, signal),
    enabled: !!prUrl(),
  }));

  // Comments query
  const commentsQuery = useQuery(() => ({
    queryKey: queryKeys.pr.comments(prUrl() ?? ""),
    queryFn: ({ signal }) => api.fetchComments(prUrl()!, signal),
    enabled: !!prUrl(),
  }));

  // Status query
  const statusQuery = useQuery(() => ({
    queryKey: queryKeys.pr.status(prUrl() ?? ""),
    queryFn: ({ signal }) => api.fetchStatus(prUrl()!, signal),
    enabled: !!prUrl(),
  }));

  // Prefetch commit diffs when commits are loaded
  createEffect(() => {
    const url = prUrl();
    const commits = commitsQuery.data;
    if (url && commits && commits.length > 0) {
      prefetchCommitDiffs(url, commits);
    }
  });

  // Commit diff query factory (for individual commits)
  const createCommitDiffQuery = (sha: () => string | null) => {
    return useQuery(() => ({
      queryKey: queryKeys.pr.commitDiff(prUrl() ?? "", sha() ?? ""),
      queryFn: ({ signal }) => api.fetchCommitDiff(prUrl()!, sha()!, signal),
      enabled: !!prUrl() && !!sha(),
    }));
  };

  // Combined loading state
  const isLoading = createMemo(() =>
    diffQuery.isPending || infoQuery.isPending
  );

  const isLoadingComments = createMemo(() => commentsQuery.isPending);
  const isLoadingStatus = createMemo(() => statusQuery.isPending);

  // Combined error state
  const error = createMemo(() =>
    diffQuery.error?.message || infoQuery.error?.message || null
  );

  // Refetch all data
  const refetchAll = async () => {
    await Promise.all([
      diffQuery.refetch(),
      infoQuery.refetch(),
      commitsQuery.refetch(),
      commentsQuery.refetch(),
      statusQuery.refetch(),
    ]);
  };

  // Update comments in cache (for optimistic updates after add/edit/delete)
  const updateComments = (updater: (prev: PRComment[]) => PRComment[]) => {
    const url = prUrl();
    if (!url) return;
    queryClient.setQueryData<PRComment[]>(
      queryKeys.pr.comments(url),
      (old) => updater(old ?? [])
    );
  };

  // Add a comment to the cache
  const addCommentToCache = (comment: PRComment) => {
    updateComments((prev) => [...prev, comment]);
  };

  // Update a comment in the cache
  const updateCommentInCache = (commentId: number, body: string) => {
    updateComments((prev) =>
      prev.map((c) => (c.id === commentId ? { ...c, body } : c))
    );
  };

  // Remove a comment from the cache
  const removeCommentFromCache = (commentId: number) => {
    updateComments((prev) => prev.filter((c) => c.id !== commentId));
  };

  return {
    // Data
    diff: () => diffQuery.data ?? null,
    info: () => infoQuery.data ?? null,
    commits: () => commitsQuery.data ?? [],
    comments: () => commentsQuery.data ?? [],
    status: () => statusQuery.data ?? null,

    // Loading states
    isLoading,
    isLoadingComments,
    isLoadingStatus,
    isFetching: () => diffQuery.isFetching,

    // Error state
    error,

    // Actions
    refetchAll,
    createCommitDiffQuery,

    // Cache updates for comments
    addCommentToCache,
    updateCommentInCache,
    removeCommentFromCache,

    // Raw queries (for advanced use)
    queries: {
      diff: diffQuery,
      info: infoQuery,
      commits: commitsQuery,
      comments: commentsQuery,
      status: statusQuery,
    },
  };
}

/**
 * Hook for fetching current user
 */
export function useCurrentUser() {
  const userQuery = useQuery(() => ({
    queryKey: queryKeys.user.current,
    queryFn: ({ signal }) => api.fetchCurrentUser(signal),
    staleTime: Infinity, // User doesn't change during session
  }));

  return {
    user: () => userQuery.data ?? null,
    isLoading: () => userQuery.isPending,
  };
}
