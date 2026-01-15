import { type Component, For, Show, createSignal, createMemo } from "solid-js";

import { ChevronDownIcon } from "../icons/chevron-down-icon";
import { CommentIcon } from "../icons/comment-icon";
import type { IssueComment } from "../lib/query";
import { CommentView } from "./CommentView";

interface PrCommentsPanelProps {
  comments: IssueComment[];
  loading?: boolean;
  repoOwner?: string | null;
  repoName?: string | null;
  onAddComment?: (body: string) => Promise<void>;
  onEditComment?: (commentId: number, body: string) => Promise<void>;
  onDeleteComment?: (commentId: number) => Promise<void>;
}

interface DisplayComment extends IssueComment {
  /** Body with quote block stripped (for replies) */
  displayBody: string;
}

interface CommentThread {
  root: DisplayComment;
  replies: DisplayComment[];
}

/**
 * Extract quoted text from a comment body (lines starting with >)
 */
function extractQuotedText(body: string): string | null {
  const lines = body.trim().split("\n");
  if (!lines[0]?.startsWith(">")) return null;

  const quoteLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(">")) {
      // Remove the > prefix and trim
      quoteLines.push(line.slice(1).trim());
    } else if (line.trim() === "") {
      // Preserve empty lines within quote block
      quoteLines.push("");
    } else {
      // End of quote block
      break;
    }
  }

  return quoteLines.join("\n").trim() || null;
}

/**
 * Find which comment is being replied to by matching quoted text.
 * Returns the comment ID being replied to, or null if not found.
 */
function findReplyTarget(comment: IssueComment, previousComments: IssueComment[]): number | null {
  const quotedText = extractQuotedText(comment.body);
  if (!quotedText) return null;

  // Search backwards through previous comments to find a match
  for (let i = previousComments.length - 1; i >= 0; i--) {
    const candidate = previousComments[i];

    // Check against stripped body (for replies that quoted the displayed text)
    const strippedBody = stripQuoteBlock(candidate.body).trim();
    if (strippedBody && strippedBody.startsWith(quotedText)) {
      return candidate.id;
    }

    // Check against original body (for root comments or replies that quoted the original)
    const originalBody = candidate.body.trim();
    if (originalBody.startsWith(quotedText)) {
      return candidate.id;
    }
  }

  return null;
}

/**
 * Strip the quote block and @mention from the beginning of a reply body.
 */
function stripQuoteBlock(body: string): string {
  const lines = body.split("\n");
  let contentStartIndex = 0;

  // Skip quote lines
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith(">") || line === "") {
      contentStartIndex = i + 1;
    } else {
      break;
    }
  }

  // Get the remaining content
  let remaining = lines.slice(contentStartIndex).join("\n").trim();

  // Strip leading @mention if present
  remaining = remaining.replace(/^@[\w-]+\s*/, "").trim();

  return remaining;
}

/**
 * Convert IssueComment to DisplayComment
 */
function toDisplayComment(comment: IssueComment, isReply: boolean): DisplayComment {
  return {
    ...comment,
    displayBody: isReply ? stripQuoteBlock(comment.body) : comment.body,
  };
}

/**
 * Group comments into threads based on quote matching.
 * A reply to any comment in a thread gets added to that thread.
 */
function groupIntoThreads(comments: IssueComment[]): CommentThread[] {
  if (comments.length === 0) return [];

  const threads: CommentThread[] = [];
  const commentToThread = new Map<number, number>(); // comment id -> thread index

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i];
    const previousComments = comments.slice(0, i);
    const replyTargetId = findReplyTarget(comment, previousComments);

    if (replyTargetId !== null && commentToThread.has(replyTargetId)) {
      // This is a reply to an existing comment - add to its thread
      const threadIndex = commentToThread.get(replyTargetId)!;
      threads[threadIndex].replies.push(toDisplayComment(comment, true));
      // Map this comment to the same thread so replies to it also go here
      commentToThread.set(comment.id, threadIndex);
    } else {
      // This is a root comment - start a new thread
      const threadIndex = threads.length;
      threads.push({ root: toDisplayComment(comment, false), replies: [] });
      commentToThread.set(comment.id, threadIndex);
    }
  }

  return threads;
}

export const PrCommentsPanel: Component<PrCommentsPanelProps> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  const [showNewCommentForm, setShowNewCommentForm] = createSignal(false);
  const [newCommentBody, setNewCommentBody] = createSignal("");
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  // Track which comment ID we're replying to (null = new top-level comment)
  const [replyingToId, setReplyingToId] = createSignal<number | null>(null);
  const [replyingToUsername, setReplyingToUsername] = createSignal<string | null>(null);

  const hasComments = createMemo(() => props.comments.length > 0);
  const commentCount = createMemo(() => props.comments.length);

  // Group comments into threads
  const threads = createMemo(() => groupIntoThreads(props.comments));

  const handleReply = (commentId: number, username: string, quotedBody: string) => {
    setReplyingToId(commentId);
    setReplyingToUsername(username);
    // Quote the original comment (limit to first 3 lines to keep it concise)
    const lines = quotedBody.split("\n").slice(0, 3);
    const quoted = lines.map((line) => `> ${line}`).join("\n");
    const suffix = quotedBody.split("\n").length > 3 ? "\n> ..." : "";
    setNewCommentBody(`${quoted}${suffix}\n\n@${username} `);
  };

  const cancelReply = () => {
    setReplyingToId(null);
    setReplyingToUsername(null);
    setNewCommentBody("");
    setShowNewCommentForm(false);
  };

  const handleSubmitComment = async () => {
    const body = newCommentBody().trim();
    if (!body || !props.onAddComment || isSubmitting()) return;

    setIsSubmitting(true);
    try {
      await props.onAddComment(body);
      cancelReply();
    } catch (error) {
      console.error("Failed to add comment:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      handleSubmitComment();
    }
    if (e.key === "Escape") {
      cancelReply();
    }
  };

  const githubContext = createMemo(() => {
    if (props.repoOwner && props.repoName) {
      return { owner: props.repoOwner, repo: props.repoName };
    }
    return null;
  });

  const renderReplyForm = () => (
    <div class="mt-2 ml-3 pl-3 border-l border-border">
      <div class="bg-bg-surface border border-accent p-2 space-y-2">
        <div class="text-xs text-accent">Replying to @{replyingToUsername()}</div>
        <textarea
          value={newCommentBody()}
          onInput={(e) => setNewCommentBody(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Reply to @${replyingToUsername()}...`}
          class="w-full min-h-[80px] bg-bg-base border border-border p-2 text-sm text-text resize-y focus:outline-none focus:border-accent"
          disabled={isSubmitting()}
          autofocus
        />
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={cancelReply}
            class="px-2 py-1 text-xs text-text-muted hover:text-text transition-colors"
            disabled={isSubmitting()}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmitComment}
            disabled={!newCommentBody().trim() || isSubmitting()}
            class="px-2 py-1 text-xs bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting() ? "Posting..." : "Reply"}
          </button>
        </div>
      </div>
    </div>
  );

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
            <ChevronDownIcon size={12} />
          </span>
          <span class="text-text-muted">
            <CommentIcon size={16} />
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
              <For each={threads()}>
                {(thread) => (
                  <div class="bg-bg-elevated border border-border p-3">
                    {/* Root comment */}
                    <CommentView
                      comment={thread.root}
                      githubContext={githubContext()}
                      showEdited
                      onEdit={props.onEditComment}
                      onDelete={props.onDeleteComment}
                      onReply={props.onAddComment ? handleReply : undefined}
                    />
                    {/* Reply form after root (if replying to root) */}
                    <Show when={replyingToId() === thread.root.id}>{renderReplyForm()}</Show>
                    {/* Replies */}
                    <For each={thread.replies}>
                      {(reply) => (
                        <>
                          <div class="mt-2">
                            <CommentView
                              comment={reply}
                              githubContext={githubContext()}
                              showEdited
                              isReply
                              onEdit={props.onEditComment}
                              onDelete={props.onDeleteComment}
                              onReply={props.onAddComment ? handleReply : undefined}
                            />
                          </div>
                          {/* Reply form after this reply (if replying to it) */}
                          <Show when={replyingToId() === reply.id}>{renderReplyForm()}</Show>
                        </>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>

            {/* New top-level comment form */}
            <Show when={props.onAddComment && !replyingToId()}>
              <Show
                when={showNewCommentForm()}
                fallback={
                  <button
                    type="button"
                    onClick={() => setShowNewCommentForm(true)}
                    class="w-full py-2 px-3 text-sm text-text-muted border border-dashed border-border hover:border-accent hover:text-accent transition-colors"
                  >
                    + Add comment
                  </button>
                }
              >
                <div class="bg-bg-elevated border border-border p-3 space-y-2">
                  <textarea
                    value={newCommentBody()}
                    onInput={(e) => setNewCommentBody(e.currentTarget.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Write a comment..."
                    class="w-full min-h-[80px] bg-bg-base border border-border p-2 text-sm text-text resize-y focus:outline-none focus:border-accent"
                    disabled={isSubmitting()}
                    autofocus
                  />
                  <div class="flex items-center justify-between">
                    <span class="text-xs text-text-faint">Markdown supported</span>
                    <div class="flex gap-2">
                      <button
                        type="button"
                        onClick={cancelReply}
                        class="px-3 py-1 text-sm text-text-muted hover:text-text transition-colors"
                        disabled={isSubmitting()}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleSubmitComment}
                        disabled={!newCommentBody().trim() || isSubmitting()}
                        class="px-3 py-1 text-sm bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isSubmitting() ? "Posting..." : "Comment"}
                      </button>
                    </div>
                  </div>
                </div>
              </Show>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
};
