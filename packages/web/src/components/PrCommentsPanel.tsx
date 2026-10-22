import { type Component, For, Show, createSignal, createMemo } from "solid-js";

import { Button, MessageForm, Textarea } from "../design-system";
import { ChevronDownIcon } from "../icons/chevron-down-icon";
import { CommentIcon } from "../icons/comment-icon";
import type { projectGithubComments } from "../lib/github-comment-views";
import { remoteCommentDetails } from "../lib/github-comment-views";
import {
  githubConversationReplyBody,
  groupGithubConversation,
} from "../lib/github-conversation-threads";
import { createGithubEditorDraft } from "../lib/github-editor-draft";
import { githubPrScope } from "../lib/github-writes";
import type { IssueComment } from "../lib/query";
import { createRecoverableDraft } from "../lib/recoverable-drafts";
import { CommentView } from "./CommentView";
import { GithubCommentCard } from "./GithubCommentCard";
import { GithubSyncStatus } from "./GithubSyncStatus";

interface PrCommentsPanelProps {
  githubView?: ReturnType<typeof projectGithubComments>;
  prUrl?: string | null;
  embedded?: boolean;
  comments: IssueComment[];
  loading?: boolean;
  unavailable?: boolean;
  repoOwner?: string | null;
  repoName?: string | null;
  onAddComment?: (body: string, draftKey?: string) => Promise<void>;
  onEditComment?: (
    commentId: number,
    body: string,
    draftKey?: string,
    expectedBody?: string,
  ) => Promise<void>;
  onDeleteComment?: (commentId: number) => Promise<void>;
}

export const PrCommentsPanel: Component<PrCommentsPanelProps> = (props) => {
  const [expanded, setExpanded] = createSignal(props.embedded ?? false);
  const [showNewCommentForm, setShowNewCommentForm] = createSignal(false);
  const draft = props.prUrl
    ? createGithubEditorDraft({
        slot: () => (props.prUrl ? `${props.prUrl}:conversation:new` : undefined),
        url: () => props.prUrl,
        initial: () => ({ body: "" }),
      })
    : undefined;
  const {
    body: newCommentBody,
    setBody: setNewCommentBody,
    storageError,
  } = draft
    ? { body: draft.body, setBody: draft.setBody, storageError: draft.error }
    : createRecoverableDraft(() => undefined);
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  // Track which comment ID we're replying to (null = new top-level comment)
  const [replyingToId, setReplyingToId] = createSignal<number | null>(null);
  const [replyingToUsername, setReplyingToUsername] = createSignal<string | null>(null);

  const views = createMemo(() =>
    props.githubView?.comments.filter((comment) => comment.ref.kind === "issue-comment"),
  );
  const hasComments = createMemo(() => (views()?.length ?? props.comments.length) > 0);
  const commentCount = createMemo(() => views()?.length ?? props.comments.length);
  const viewThreads = createMemo(() =>
    groupGithubConversation(views() ?? [], (comment) => remoteCommentDetails(comment).knownLogin),
  );

  // Group comments into threads
  const threads = createMemo(() =>
    groupGithubConversation(props.comments, (comment) => comment.user.login).map((thread) => ({
      root: { ...thread.root, displayBody: thread.root.body },
      replies: thread.replies.map((reply) => ({
        ...reply,
        displayBody: githubConversationReplyBody(reply.body),
      })),
    })),
  );

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
    setShowNewCommentForm(false);
  };

  const handleSubmitComment = async () => {
    const body = newCommentBody().trim();
    if (!body || !props.onAddComment || isSubmitting()) return;

    setIsSubmitting(true);
    setSaveError(null);
    try {
      if (draft) await draft.submit((text, key) => props.onAddComment!(text.trim(), key));
      else {
        await props.onAddComment(body);
        setNewCommentBody("");
      }
      cancelReply();
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "Could not save comment locally. Your draft is preserved.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.isComposing && !isSubmitting()) {
      e.preventDefault();
      e.stopPropagation();
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
      <MessageForm
        onSubmit={handleSubmitComment}
        aria-label="Conversation reply"
        class="bg-bg-surface border border-accent p-2 space-y-2"
      >
        <div class="text-xs text-accent">Replying to @{replyingToUsername()}</div>
        <Textarea
          value={newCommentBody()}
          onInput={(e) => setNewCommentBody(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Reply to @${replyingToUsername()}...`}
          aria-label="Comment reply"
          class="w-full min-h-20 resize-y"
          disabled={isSubmitting() || !(draft?.ready() ?? true)}
          autofocus
        />
        <div class="flex items-center justify-end gap-2">
          <Button
            type="button"
            onClick={cancelReply}
            variant="ghost"
            size="sm"
            disabled={isSubmitting()}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!newCommentBody().trim() || isSubmitting() || !(draft?.ready() ?? true)}
            variant="primary"
            size="sm"
            class="min-w-14"
            aria-label={isSubmitting() ? "Sending reply" : undefined}
          >
            <Show when={isSubmitting()} fallback="Reply">
              <GithubSyncStatus status="saving-local" iconOnly />
            </Show>
          </Button>
        </div>
      </MessageForm>
    </div>
  );

  return (
    <Show when={!props.loading}>
      <div class="border-t border-border">
        <Show when={props.unavailable}>
          <p role="alert" class="p-3 text-sm text-text-muted">
            GitHub conversation comments unavailable. Displayed comments may be cached.
          </p>
        </Show>
        <Show when={saveError()}>
          <p role="alert" class="text-xs text-error">
            {saveError()}
          </p>
        </Show>
        <Show when={storageError()}>
          <p role="alert">{storageError()}</p>
        </Show>
        <Show when={!props.embedded}>
          {/* Header */}
          <Button
            type="button"
            onClick={() => setExpanded(!expanded())}
            variant="ghost"
            size="sm"
            class="w-full justify-start"
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
          </Button>
        </Show>

        {/* Comments list */}
        <Show when={expanded()}>
          <div class="px-4 pb-3 space-y-3 max-h-[400px] overflow-y-auto">
            <Show
              when={hasComments()}
              fallback={
                <div class="text-sm text-text-faint py-2">
                  {props.unavailable
                    ? "Conversation could not be loaded."
                    : "No conversation comments yet"}
                </div>
              }
            >
              <Show
                when={views()}
                fallback={
                  <For each={threads()}>
                    {(thread) => (
                      <div
                        data-github-conversation-thread={`legacy:${thread.root.id}`}
                        class="bg-bg-elevated border border-border p-3"
                      >
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
                }
              >
                <For each={viewThreads().map((thread) => thread.root.key)}>
                  {(rootKey) => {
                    const thread = () => viewThreads().find((item) => item.root.key === rootKey)!;
                    return (
                      <div data-github-conversation-thread={rootKey} class="space-y-2">
                        <For
                          each={[thread().root, ...thread().replies].map((comment) => comment.key)}
                        >
                          {(key) => {
                            const comment = () => views()!.find((item) => item.key === key)!;
                            return (
                              <div
                                class={key === rootKey ? "" : "ml-3 border-l border-border pl-3"}
                              >
                                <GithubCommentCard
                                  comment={comment()}
                                  displayBody={
                                    key === rootKey
                                      ? undefined
                                      : githubConversationReplyBody(comment().body)
                                  }
                                  scope={githubPrScope(props.prUrl!)}
                                  operations={props.githubView?.operations ?? []}
                                />
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    );
                  }}
                </For>
              </Show>
            </Show>

            {/* New top-level comment form */}
            <Show when={props.onAddComment && !replyingToId()}>
              <Show
                when={showNewCommentForm() || !!newCommentBody()}
                fallback={
                  <Button
                    type="button"
                    onClick={() => setShowNewCommentForm(true)}
                    variant="ghost"
                    size="sm"
                    class="w-full"
                  >
                    + Add comment
                  </Button>
                }
              >
                <MessageForm
                  onSubmit={handleSubmitComment}
                  aria-label="New conversation comment"
                  class="bg-bg-elevated border border-border p-3 space-y-2"
                >
                  <Textarea
                    value={newCommentBody()}
                    onInput={(e) => setNewCommentBody(e.currentTarget.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Write a comment..."
                    aria-label="New conversation comment"
                    class="w-full min-h-20 resize-y"
                    disabled={isSubmitting() || !(draft?.ready() ?? true)}
                    autofocus
                  />
                  <div class="flex items-center justify-between">
                    <span class="text-xs text-text-faint">Markdown supported</span>
                    <div class="flex gap-2">
                      <Button
                        type="button"
                        onClick={cancelReply}
                        variant="ghost"
                        size="sm"
                        disabled={isSubmitting()}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        disabled={
                          !newCommentBody().trim() || isSubmitting() || !(draft?.ready() ?? true)
                        }
                        variant="primary"
                        size="sm"
                        class="min-w-20"
                        aria-label={isSubmitting() ? "Sending comment" : undefined}
                      >
                        <Show when={isSubmitting()} fallback="Comment">
                          <GithubSyncStatus status="saving-local" iconOnly />
                        </Show>
                      </Button>
                    </div>
                  </div>
                </MessageForm>
              </Show>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
};
