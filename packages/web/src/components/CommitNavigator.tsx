import { For, Show, type Component } from "solid-js";

import type { PrCommit } from "../diff/types";
import { ChevronLeftIcon } from "../icons/chevron-left-icon";
import { ChevronRightIcon } from "../icons/chevron-right-icon";

interface CommitNavigatorProps {
  commits: PrCommit[];
  currentIndex: number;
  onSelectCommit: (index: number) => void;
  onPrev: () => void;
  onNext: () => void;
  loading?: boolean;
}

export const CommitNavigator: Component<CommitNavigatorProps> = (props) => {
  const current = () => props.commits[props.currentIndex];
  const canPrev = () => props.currentIndex > 0 && !props.loading;
  const canNext = () => props.currentIndex < props.commits.length - 1 && !props.loading;

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const truncateMessage = (msg: string, maxLen = 60) => {
    const firstLine = msg.split("\n")[0];
    if (firstLine.length <= maxLen) return firstLine;
    return firstLine.slice(0, maxLen) + "...";
  };

  return (
    <div class="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-surface">
      {/* Prev button */}
      <button
        type="button"
        onClick={props.onPrev}
        disabled={!canPrev()}
        class="px-2 py-1 text-sm text-text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Previous commit"
      >
        <ChevronLeftIcon size={12} />
      </button>

      {/* Commit selector */}
      <select
        value={props.currentIndex}
        onChange={(e) => props.onSelectCommit(Number(e.target.value))}
        disabled={props.loading}
        class="flex-1 min-w-0 px-2 py-1 bg-bg border border-border text-sm text-text disabled:opacity-50 cursor-pointer"
      >
        <For each={props.commits}>
          {(commit, i) => (
            <option value={i()}>
              {i() + 1}/{props.commits.length}: {commit.sha.slice(0, 7)} -{" "}
              {truncateMessage(commit.message)}
            </option>
          )}
        </For>
      </select>

      {/* Next button */}
      <button
        type="button"
        onClick={props.onNext}
        disabled={!canNext()}
        class="px-2 py-1 text-sm text-text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Next commit"
      >
        <ChevronRightIcon size={12} />
      </button>

      {/* Loading indicator */}
      <Show when={props.loading}>
        <span class="text-base text-accent animate-pulse">Loading...</span>
      </Show>

      {/* Commit info */}
      <Show when={!props.loading && current()}>
        <div class="hidden sm:flex items-center gap-2 text-base text-text-faint border-l border-border pl-2 ml-1">
          <Show when={current()?.author.avatar_url}>
            <img
              src={current()!.author.avatar_url}
              alt={current()!.author.login}
              class="w-4 h-4 rounded-sm"
            />
          </Show>
          <span>{current()!.author.login}</span>
          <span class="opacity-50">·</span>
          <span>{formatDate(current()!.date)}</span>
        </div>
      </Show>
    </div>
  );
};
