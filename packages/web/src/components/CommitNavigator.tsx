import { For, Show, type Component } from "solid-js";
import type { PrCommit } from "../diff/types";

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
        class="px-2 py-1 text-[11px] text-text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Previous commit"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06z"/>
        </svg>
      </button>

      {/* Commit selector */}
      <select
        value={props.currentIndex}
        onChange={(e) => props.onSelectCommit(Number(e.target.value))}
        disabled={props.loading}
        class="flex-1 min-w-0 px-2 py-1 bg-bg border border-border text-[11px] text-text disabled:opacity-50 cursor-pointer"
      >
        <For each={props.commits}>
          {(commit, i) => (
            <option value={i()}>
              {i() + 1}/{props.commits.length}: {commit.sha.slice(0, 7)} - {truncateMessage(commit.message)}
            </option>
          )}
        </For>
      </select>

      {/* Next button */}
      <button
        type="button"
        onClick={props.onNext}
        disabled={!canNext()}
        class="px-2 py-1 text-[11px] text-text-muted hover:text-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Next commit"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z"/>
        </svg>
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
