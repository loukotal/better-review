import { type Component, For, Show, createSignal, createMemo } from "solid-js";

import { parseMarkdown } from "../lib/markdown";
import type { IssueComment } from "../lib/query";

interface PrCommentsPanelProps {
  comments: IssueComment[];
  loading?: boolean;
  repoOwner?: string | null;
  repoName?: string | null;
}

function ChevronDownIcon() {
  return (
    <svg class="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
      <path
        d="M4.5 5.5L8 9l3.5-3.5"
        stroke="currentColor"
        stroke-width="1.5"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg class="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1 2.75A.75.75 0 0 1 1.75 2h12.5a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-.75.75h-8.5L2.5 14.5V12H1.75a.75.75 0 0 1-.75-.75v-8.5z" />
    </svg>
  );
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours === 0) {
      const diffMins = Math.floor(diffMs / (1000 * 60));
      return diffMins <= 1 ? "just now" : `${diffMins}m ago`;
    }
    return `${diffHours}h ago`;
  }
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

export const PrCommentsPanel: Component<PrCommentsPanelProps> = (props) => {
  const [expanded, setExpanded] = createSignal(false);

  const hasComments = createMemo(() => props.comments.length > 0);
  const commentCount = createMemo(() => props.comments.length);

  const githubContext = createMemo(() => {
    if (props.repoOwner && props.repoName) {
      return { owner: props.repoOwner, repo: props.repoName };
    }
    return null;
  });

  return (
    <Show when={!props.loading}>
      <div class="border-t border-border">
        {/* Header */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded())}
          class="w-full flex items-center gap-2 px-4 py-2 hover:bg-bg-surface transition-colors text-left"
        >
          <span
            class={`transform transition-transform text-text-faint ${expanded() ? "" : "-rotate-90"}`}
          >
            <ChevronDownIcon />
          </span>
          <span class="text-text-muted">
            <CommentIcon />
          </span>
          <span class="text-sm text-text-muted">Comments</span>
          <Show when={hasComments()}>
            <span class="px-1.5 py-0.5 text-xs bg-accent/20 text-accent rounded-full">
              {commentCount()}
            </span>
          </Show>
        </button>

        {/* Comments list */}
        <Show when={expanded()}>
          <div class="px-4 pb-3 space-y-3 max-h-[400px] overflow-y-auto">
            <Show
              when={hasComments()}
              fallback={
                <div class="text-sm text-text-faint py-2">No conversation comments yet</div>
              }
            >
              <For each={props.comments}>
                {(comment) => (
                  <div class="bg-bg-elevated border border-border p-3">
                    {/* Comment header */}
                    <div class="flex items-center gap-2 mb-2">
                      <img
                        src={comment.user.avatar_url}
                        alt={comment.user.login}
                        class="w-5 h-5 rounded-sm"
                      />
                      <a
                        href={comment.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-sm text-text hover:text-accent transition-colors"
                      >
                        {comment.user.login}
                      </a>
                      <span class="text-sm text-text-faint">{formatDate(comment.created_at)}</span>
                      <Show when={comment.updated_at !== comment.created_at}>
                        <span class="text-sm text-text-faint italic">(edited)</span>
                      </Show>
                    </div>

                    {/* Comment body - markdown rendered */}
                    <div
                      class="text-sm text-text-muted leading-relaxed markdown-content"
                      innerHTML={parseMarkdown(comment.body, githubContext())}
                    />
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
};
