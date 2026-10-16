import { type Component, Show, For, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";

import { Button, MessageForm, Textarea } from "../design-system";
import { GitHubIcon } from "../icons/github-icon";
import { createPendingCommentFormState } from "../lib/comment-save";
import { createGithubEditorDraft } from "../lib/github-editor-draft";
import { parseMarkdown } from "../lib/markdown";
import { createRecoverableDraft } from "../lib/recoverable-drafts";

// Shared comment data interface that works for both PRComment and IssueComment
export interface CommentData {
  id: number;
  body: string;
  html_url: string;
  user: { login: string; avatar_url: string };
  created_at: string;
  updated_at?: string;
  /** Whether the current user can edit/delete this comment */
  canEdit: boolean;
  /** Optional display body (with quote stripped for replies) */
  displayBody?: string;
}

export interface GitHubContext {
  owner: string;
  repo: string;
}

// Format date consistently
function formatCommentDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString();
}

export interface CommentViewProps {
  comment: CommentData;
  githubContext?: GitHubContext | null;
  showEdited?: boolean;
  isReply?: boolean;
  onEdit?: (
    commentId: number,
    body: string,
    draftKey?: string,
    expectedBody?: string,
  ) => Promise<void>;
  onDelete?: (commentId: number) => Promise<void>;
  /** For issue comments - creates a new comment with quote and mention */
  onReply?: (commentId: number, username: string, quotedBody: string) => void;
}

/**
 * Reusable comment component with view/edit modes and actions.
 * Used directly in SolidJS and rendered to DOM for diff annotations.
 */
export const CommentView: Component<CommentViewProps> = (props) => {
  const [isEditing, setIsEditing] = createSignal(false);
  const prUrl = () =>
    props.comment.html_url.match(
      /^(https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+)(?:[#/?]|$)/,
    )?.[1];
  const durableEdit = prUrl()
    ? createGithubEditorDraft({
        slot: () => `${props.comment.html_url}:edit`,
        url: prUrl,
        lazy: true,
      })
    : undefined;
  const {
    body: editBody,
    setBody: setEditBody,
    storageError,
  } = durableEdit
    ? { body: durableEdit.body, setBody: durableEdit.setBody, storageError: durableEdit.error }
    : createRecoverableDraft(() => `${props.comment.html_url}:edit:${props.comment.id}`);
  const [editError, setEditError] = createSignal<string | null>(null);
  const [isSubmitting, setIsSubmitting] = createSignal(false);

  const isEdited = () =>
    props.showEdited &&
    props.comment.updated_at &&
    props.comment.updated_at !== props.comment.created_at;

  const showActions = () =>
    props.comment.canEdit && !!(props.onEdit || props.onDelete) && !isEditing();

  const indentClass = () => (props.isReply ? "ml-3 pl-3 border-l border-border" : "");

  const startEditing = () => {
    if (durableEdit)
      void durableEdit.open({
        body: props.comment.body,
        context: { expectedBody: props.comment.body },
      });
    else if (!editBody()) setEditBody(props.comment.body);
    setEditError(null);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditError(null);
  };

  const submitEdit = async () => {
    if (!props.onEdit || isSubmitting()) return;
    const body = editBody().trim();
    if (!body) {
      setEditError("Comment cannot be empty");
      return;
    }
    if (body === props.comment.body) {
      cancelEditing();
      return;
    }

    setIsSubmitting(true);
    setEditError(null);
    try {
      if (durableEdit)
        await durableEdit.submit((text, key, context) =>
          props.onEdit!(props.comment.id, text.trim(), key, context.expectedBody),
        );
      else await props.onEdit(props.comment.id, body);
      setIsEditing(false);
      setEditBody("");
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to edit comment");
    } finally {
      setIsSubmitting(false);
    }
  };

  const [deleteError, setDeleteError] = createSignal<string | null>(null);

  const handleDelete = async () => {
    if (!props.onDelete || isSubmitting()) return;
    if (!confirm("Delete this comment?")) return;
    setIsSubmitting(true);
    setDeleteError(null);
    try {
      await props.onDelete(props.comment.id);
    } catch (err) {
      console.error("Failed to delete comment:", err);
      setDeleteError("Failed to delete comment");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.isComposing && !isSubmitting()) {
      e.preventDefault();
      e.stopPropagation();
      cancelEditing();
    }
  };

  return (
    <div class={indentClass()} id={`comment-${props.comment.id}`}>
      <Show
        when={!isEditing()}
        fallback={
          /* Editing mode */
          <MessageForm onSubmit={submitEdit} aria-label="Edit comment">
            <div class="flex items-center gap-2 mb-1">
              <img
                src={props.comment.user.avatar_url}
                alt={props.comment.user.login}
                class="w-4 h-4 rounded-sm"
              />
              <span class="text-sm text-text">{props.comment.user.login}</span>
              <span class="text-sm text-accent">editing</span>
            </div>
            <Textarea
              aria-label="Comment"
              ref={(el) => setTimeout(() => el.focus(), 0)}
              value={editBody()}
              onInput={(e) => setEditBody(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              class="w-full min-h-20 resize-y"
              disabled={isSubmitting() || !(durableEdit?.ready() ?? true)}
            />
            <div class="flex gap-2 mt-1.5">
              <Button type="submit" disabled={isSubmitting()} variant="primary" size="sm">
                {isSubmitting() ? "Saving..." : "Save"}
              </Button>
              <Button
                type="button"
                onClick={cancelEditing}
                disabled={isSubmitting()}
                variant="ghost"
                size="sm"
              >
                Cancel
              </Button>
            </div>
            <Show when={editError()}>
              <div class="mt-2 px-2 py-1.5 border border-error/50 bg-error/10 text-error text-sm">
                {editError()}
              </div>
            </Show>
            <Show when={storageError()}>
              <p role="alert">{storageError()}</p>
            </Show>
          </MessageForm>
        }
      >
        {/* View mode */}
        <div class="flex items-center gap-2 mb-1">
          <img
            src={props.comment.user.avatar_url}
            alt={props.comment.user.login}
            class="w-4 h-4 rounded-sm"
          />
          <span class="text-sm text-text">{props.comment.user.login}</span>
          <a
            href={`#comment-${props.comment.id}`}
            class="text-sm text-text-faint hover:text-accent transition-colors"
            title="Link to comment"
          >
            {formatCommentDate(props.comment.created_at)}
          </a>
          <a
            href={props.comment.html_url}
            target="_blank"
            rel="noopener noreferrer"
            class="text-text-faint hover:text-accent transition-colors"
            title="View on GitHub"
          >
            <GitHubIcon size={12} />
          </a>
          <Show when={isEdited()}>
            <span class="text-sm text-text-faint italic">(edited)</span>
          </Show>
          {/* Actions - reply is always visible, edit/delete only for own comments */}
          <Show when={props.onReply || showActions()}>
            <div class="flex items-center gap-2 ml-auto text-xs">
              <Show when={props.onReply}>
                <Button
                  type="button"
                  onClick={() =>
                    props.onReply?.(
                      props.comment.id,
                      props.comment.user.login,
                      props.comment.displayBody ?? props.comment.body,
                    )
                  }
                  variant="ghost"
                  size="sm"
                >
                  Reply
                </Button>
              </Show>
              <Show when={showActions() && props.onEdit}>
                <Button type="button" onClick={startEditing} variant="ghost" size="sm">
                  Edit
                </Button>
              </Show>
              <Show when={showActions() && props.onDelete}>
                <Button
                  type="button"
                  onClick={handleDelete}
                  disabled={isSubmitting()}
                  variant="ghost"
                  size="sm"
                >
                  Delete
                </Button>
              </Show>
            </div>
          </Show>
        </div>

        {/* Delete error message */}
        <Show when={deleteError()}>
          <div class="text-xs text-error mb-1">{deleteError()}</div>
        </Show>

        {/* Comment body - markdown rendered */}
        <div
          class="typeset text-sm text-text-muted"
          innerHTML={parseMarkdown(
            props.comment.displayBody ?? props.comment.body,
            props.githubContext,
          )}
        />
      </Show>
    </div>
  );
};

/**
 * Render CommentView into a DOM element. Returns dispose function.
 */
export function renderCommentView(container: HTMLElement, props: CommentViewProps): () => void {
  return render(() => <CommentView {...props} />, container);
}

// ============================================================================
// CommentThread - for rendering a thread of comments with replies
// ============================================================================

interface ReplyFormProps {
  prUrl?: string;
  draftKey?: string;
  onSubmit: (body: string, draftKey?: string) => Promise<void>;
  onCancel: () => void;
}

const ReplyForm: Component<ReplyFormProps> = (props) => {
  const durable = props.prUrl
    ? createGithubEditorDraft({
        slot: () => props.draftKey,
        url: () => props.prUrl,
        initial: () => ({ body: "" }),
      })
    : undefined;
  const { body, setBody, storageError } = durable
    ? { body: durable.body, setBody: durable.setBody, storageError: durable.error }
    : createRecoverableDraft(() => props.draftKey);
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const submit = async () => {
    if (isSubmitting()) return;
    const text = body().trim();
    if (!text) return;

    setIsSubmitting(true);
    setError(null);
    try {
      if (durable) await durable.submit((text, key) => props.onSubmit(text.trim(), key));
      else {
        await props.onSubmit(text);
        setBody("");
      }
    } catch (err) {
      console.error("Failed to reply:", err);
      setError(err instanceof Error ? err.message : "Failed to reply");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.isComposing && !isSubmitting()) {
      e.preventDefault();
      e.stopPropagation();
      props.onCancel();
    }
  };

  return (
    <MessageForm
      onSubmit={submit}
      aria-label="Reply to comment"
      class="ml-3 pl-3 border-l border-accent mt-2"
    >
      <Textarea
        aria-label="Comment"
        ref={(el) => setTimeout(() => el.focus(), 0)}
        value={body()}
        onInput={(e) => setBody(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder="Write a reply..."
        class="w-full min-h-20 resize-y"
        disabled={isSubmitting() || !(durable?.ready() ?? true)}
      />
      <Show when={error()}>
        <div class="mt-1 text-xs text-error" role="alert">
          {error()}
        </div>
      </Show>
      <Show when={storageError()}>
        <p role="alert">{storageError()}</p>
      </Show>
      <div class="flex gap-2 mt-1.5">
        <Button
          type="submit"
          disabled={!body().trim() || isSubmitting()}
          variant="primary"
          size="sm"
        >
          {isSubmitting() ? "Replying..." : "Reply"}
        </Button>
        <Button
          type="button"
          onClick={props.onCancel}
          disabled={isSubmitting()}
          variant="ghost"
          size="sm"
        >
          Cancel
        </Button>
      </div>
    </MessageForm>
  );
};

export interface CommentThreadProps {
  rootComment: CommentData;
  replies: CommentData[];
  githubContext?: GitHubContext | null;
  onEdit: (
    commentId: number,
    body: string,
    draftKey?: string,
    expectedBody?: string,
  ) => Promise<void>;
  onDelete: (commentId: number) => Promise<void>;
  onReply: (body: string, draftKey?: string) => Promise<void>;
  /** Whether this thread is resolved */
  isResolved?: boolean;
  /** Callback to resolve or unresolve the thread */
  onResolve?: (resolved: boolean) => Promise<void>;
}

/**
 * A thread of comments with collapsible replies and reply form.
 */
export const CommentThread: Component<CommentThreadProps> = (props) => {
  const [showAllReplies, setShowAllReplies] = createSignal(false);
  const [isReplying, setIsReplying] = createSignal(false);
  const [isResolving, setIsResolving] = createSignal(false);
  const [resolveError, setResolveError] = createSignal<string | null>(null);

  const shouldCollapse = () => props.replies.length >= 3;
  const hiddenCount = () => props.replies.length - 2;

  const handleResolveToggle = async () => {
    if (!props.onResolve || isResolving()) return;
    setIsResolving(true);
    setResolveError(null);
    try {
      await props.onResolve(!props.isResolved);
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "Could not save thread change locally.");
    } finally {
      setIsResolving(false);
    }
  };

  return (
    <div class="space-y-2" classList={{ "opacity-60": props.isResolved }}>
      {/* Root comment */}
      <CommentView
        comment={props.rootComment}
        githubContext={props.githubContext}
        onEdit={props.onEdit}
        onDelete={props.onDelete}
      />

      {/* Replies - collapsed view */}
      <Show when={shouldCollapse() && !showAllReplies() && props.replies.length > 0}>
        {/* First reply */}
        <div class="mt-2">
          <CommentView
            comment={props.replies[0]}
            githubContext={props.githubContext}
            onEdit={props.onEdit}
            onDelete={props.onDelete}
            isReply
          />
        </div>

        {/* Expand button */}
        <Show when={hiddenCount() > 0}>
          <Button
            type="button"
            onClick={() => setShowAllReplies(true)}
            variant="ghost"
            size="sm"
            class="ml-3"
          >
            +{hiddenCount()} more
          </Button>
        </Show>

        {/* Last reply */}
        <Show when={props.replies.length > 1}>
          <div class="mt-2">
            <CommentView
              comment={props.replies[props.replies.length - 1]}
              githubContext={props.githubContext}
              onEdit={props.onEdit}
              onDelete={props.onDelete}
              isReply
            />
          </div>
        </Show>
      </Show>

      {/* Replies - expanded view */}
      <Show when={!shouldCollapse() || showAllReplies()}>
        <For each={props.replies}>
          {(reply) => (
            <div class="mt-2">
              <CommentView
                comment={reply}
                githubContext={props.githubContext}
                onEdit={props.onEdit}
                onDelete={props.onDelete}
                isReply
              />
            </div>
          )}
        </For>
      </Show>

      <Show when={resolveError()}>
        <p role="alert" class="text-xs text-error">
          {resolveError()}
        </p>
      </Show>
      {/* Thread actions: reply + resolve */}
      <div class="flex items-center gap-3 mt-2">
        <Show
          when={isReplying()}
          fallback={
            <Button type="button" onClick={() => setIsReplying(true)} variant="ghost" size="sm">
              Reply
            </Button>
          }
        >
          <ReplyForm
            prUrl={
              props.rootComment.html_url.match(
                /^(https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+)(?:[#/?]|$)/,
              )?.[1]
            }
            draftKey={`${props.rootComment.html_url}:reply:${props.rootComment.id}`}
            onSubmit={async (body, key) => {
              await props.onReply(body, key);
              setIsReplying(false);
            }}
            onCancel={() => setIsReplying(false)}
          />
        </Show>

        <Show when={props.onResolve && !isReplying()}>
          <Button
            type="button"
            onClick={handleResolveToggle}
            disabled={isResolving()}
            variant="ghost"
            size="sm"
            classList={{
              "text-success hover:text-text-faint": props.isResolved,
              "text-text-faint hover:text-success": !props.isResolved,
            }}
          >
            {isResolving() ? "..." : props.isResolved ? "Unresolve" : "Resolve"}
          </Button>
        </Show>
      </div>
    </div>
  );
};

/**
 * Render CommentThread into a DOM element. Returns dispose function.
 */
export function renderCommentThread(container: HTMLElement, props: CommentThreadProps): () => void {
  return render(() => <CommentThread {...props} />, container);
}

// ============================================================================
// PendingCommentForm - for new comment on a line
// ============================================================================

export interface PendingCommentFormProps {
  prUrl?: string | null;
  draftKey?: string;
  /** Optional owner-held state survives diff annotation re-renders and finding switches. */
  state?: ReturnType<typeof createPendingCommentFormState>;
  startLine: number;
  endLine: number;
  initialBody?: string;
  onSubmit: (body: string, draftKey?: string) => Promise<void>;
  onCancel: () => void;
  onDraftChange?: (hasDraft: boolean) => void;
}

/**
 * Form for adding a new comment on a line selection.
 */
export const PendingCommentForm: Component<PendingCommentFormProps> = (props) => {
  const { body, setBody, ready, isSubmitting, saveError, storageError, submit } =
    props.state ?? createPendingCommentFormState(props);

  onMount(() => props.onDraftChange?.(body().trim().length > 0));
  onCleanup(() => props.onDraftChange?.(false));

  const lineLabel = () =>
    props.startLine === props.endLine
      ? `Line ${props.startLine}`
      : `Lines ${props.startLine}-${props.endLine}`;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.isComposing && !isSubmitting()) {
      e.preventDefault();
      e.stopPropagation();
      props.onCancel();
    }
  };

  return (
    <MessageForm onSubmit={submit} aria-label="New inline comment">
      <div class="text-sm text-accent mb-2">{lineLabel()}</div>
      <Show when={ready()} fallback={<p role="status">Loading durable draft…</p>}>
        <Textarea
          aria-label="Comment"
          ref={(el) => setTimeout(() => el.focus(), 0)}
          value={body()}
          onInput={(e) => {
            const value = e.currentTarget.value;
            setBody(value);
            props.onDraftChange?.(value.trim().length > 0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Write a comment..."
          class="w-full min-h-20 resize-y"
          disabled={isSubmitting() || !ready()}
        />
      </Show>
      <Show when={saveError()}>
        <div role="alert" class="text-sm text-error mt-2">
          {saveError()}
        </div>
      </Show>
      <Show when={storageError()}>
        <p role="alert">{storageError()}</p>
      </Show>
      <div class="flex gap-2 mt-2">
        <Button
          type="submit"
          disabled={!body().trim() || isSubmitting() || !ready()}
          variant="primary"
          size="sm"
        >
          {isSubmitting() ? "Commenting..." : "Comment"}
        </Button>
        <Button
          type="button"
          onClick={props.onCancel}
          disabled={isSubmitting()}
          variant="ghost"
          size="sm"
        >
          Cancel
        </Button>
      </div>
    </MessageForm>
  );
};

/**
 * Render PendingCommentForm into a DOM element. Returns dispose function.
 */
export function renderPendingCommentForm(
  container: HTMLElement,
  props: PendingCommentFormProps,
): () => void {
  return render(() => <PendingCommentForm {...props} />, container);
}
