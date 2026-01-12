import { type Component, Show, For, createSignal } from "solid-js";
import { render } from "solid-js/web";

import { parseMarkdown } from "../lib/markdown";

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

function GitHubIcon() {
  return (
    <svg class="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export interface CommentViewProps {
  comment: CommentData;
  githubContext?: GitHubContext | null;
  showEdited?: boolean;
  isReply?: boolean;
  onEdit?: (commentId: number, body: string) => Promise<void>;
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
  const [editBody, setEditBody] = createSignal("");
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
    setEditBody(props.comment.body);
    setEditError(null);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditBody("");
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
      await props.onEdit(props.comment.id, body);
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
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      submitEdit();
    }
    if (e.key === "Escape") {
      cancelEditing();
    }
  };

  return (
    <div class={indentClass()} id={`comment-${props.comment.id}`}>
      <Show
        when={!isEditing()}
        fallback={
          /* Editing mode */
          <div>
            <div class="flex items-center gap-2 mb-1">
              <img
                src={props.comment.user.avatar_url}
                alt={props.comment.user.login}
                class="w-4 h-4 rounded-sm"
              />
              <span class="text-sm text-text">{props.comment.user.login}</span>
              <span class="text-sm text-accent">editing</span>
            </div>
            <textarea
              value={editBody()}
              onInput={(e) => setEditBody(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              class="w-full px-2 py-1.5 bg-bg border border-accent text-text focus:border-accent resize-y min-h-[60px] text-sm"
              disabled={isSubmitting()}
              autofocus
            />
            <div class="flex gap-2 mt-1.5">
              <button
                type="button"
                onClick={submitEdit}
                disabled={isSubmitting()}
                class="px-2.5 py-1 bg-accent text-black text-sm hover:bg-accent-bright disabled:opacity-50 transition-colors"
              >
                {isSubmitting() ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                onClick={cancelEditing}
                disabled={isSubmitting()}
                class="px-2.5 py-1 text-text-faint text-sm hover:text-text transition-colors"
              >
                Cancel
              </button>
            </div>
            <Show when={editError()}>
              <div class="mt-2 px-2 py-1.5 border border-red-500/50 bg-red-500/10 text-red-400 text-sm">
                {editError()}
              </div>
            </Show>
          </div>
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
            <GitHubIcon />
          </a>
          <Show when={isEdited()}>
            <span class="text-sm text-text-faint italic">(edited)</span>
          </Show>
          {/* Actions - reply is always visible, edit/delete only for own comments */}
          <Show when={props.onReply || showActions()}>
            <div class="flex items-center gap-2 ml-auto text-xs">
              <Show when={props.onReply}>
                <button
                  type="button"
                  onClick={() =>
                    props.onReply?.(
                      props.comment.id,
                      props.comment.user.login,
                      props.comment.displayBody ?? props.comment.body,
                    )
                  }
                  class="text-text-faint hover:text-accent transition-colors"
                >
                  Reply
                </button>
              </Show>
              <Show when={showActions() && props.onEdit}>
                <button
                  type="button"
                  onClick={startEditing}
                  class="text-text-faint hover:text-accent transition-colors"
                >
                  Edit
                </button>
              </Show>
              <Show when={showActions() && props.onDelete}>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={isSubmitting()}
                  class="text-text-faint hover:text-red-400 transition-colors"
                >
                  Delete
                </button>
              </Show>
            </div>
          </Show>
        </div>

        {/* Delete error message */}
        <Show when={deleteError()}>
          <div class="text-xs text-red-400 mb-1">{deleteError()}</div>
        </Show>

        {/* Comment body - markdown rendered */}
        <div
          class="text-sm text-text-muted leading-relaxed markdown-content"
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
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}

const ReplyForm: Component<ReplyFormProps> = (props) => {
  const [body, setBody] = createSignal("");
  const [isSubmitting, setIsSubmitting] = createSignal(false);

  const submit = async () => {
    if (isSubmitting()) return;
    const text = body().trim();
    if (!text) return;

    setIsSubmitting(true);
    try {
      await props.onSubmit(text);
      setBody("");
    } catch (err) {
      console.error("Failed to reply:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") {
      props.onCancel();
    }
  };

  return (
    <div class="ml-3 pl-3 border-l border-accent mt-2">
      <textarea
        value={body()}
        onInput={(e) => setBody(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder="Write a reply..."
        class="w-full px-2 py-1.5 bg-bg border border-border text-text placeholder:text-text-faint focus:border-accent resize-y min-h-[50px] text-sm"
        disabled={isSubmitting()}
        autofocus
      />
      <div class="flex gap-2 mt-1.5">
        <button
          type="button"
          onClick={submit}
          disabled={!body().trim() || isSubmitting()}
          class="px-2.5 py-1 bg-accent text-black text-xs hover:bg-accent-bright disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSubmitting() ? "Replying..." : "Reply"}
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          disabled={isSubmitting()}
          class="px-2.5 py-1 text-text-faint text-xs hover:text-text transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

export interface CommentThreadProps {
  rootComment: CommentData;
  replies: CommentData[];
  githubContext?: GitHubContext | null;
  onEdit: (commentId: number, body: string) => Promise<void>;
  onDelete: (commentId: number) => Promise<void>;
  onReply: (body: string) => Promise<void>;
}

/**
 * A thread of comments with collapsible replies and reply form.
 */
export const CommentThread: Component<CommentThreadProps> = (props) => {
  const [showAllReplies, setShowAllReplies] = createSignal(false);
  const [isReplying, setIsReplying] = createSignal(false);

  const shouldCollapse = () => props.replies.length >= 3;
  const hiddenCount = () => props.replies.length - 2;

  return (
    <div class="space-y-2">
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
          <button
            type="button"
            onClick={() => setShowAllReplies(true)}
            class="ml-3 text-sm text-accent hover:text-accent-bright cursor-pointer"
          >
            +{hiddenCount()} more
          </button>
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

      {/* Reply form or button */}
      <Show
        when={isReplying()}
        fallback={
          <button
            type="button"
            onClick={() => setIsReplying(true)}
            class="mt-2 text-xs text-text-faint hover:text-accent transition-colors cursor-pointer"
          >
            Reply
          </button>
        }
      >
        <ReplyForm
          onSubmit={async (body) => {
            await props.onReply(body);
            setIsReplying(false);
          }}
          onCancel={() => setIsReplying(false)}
        />
      </Show>
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
  startLine: number;
  endLine: number;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * Form for adding a new comment on a line selection.
 */
export const PendingCommentForm: Component<PendingCommentFormProps> = (props) => {
  const [body, setBody] = createSignal("");
  const [isSubmitting, setIsSubmitting] = createSignal(false);

  const lineLabel = () =>
    props.startLine === props.endLine
      ? `Line ${props.startLine}`
      : `Lines ${props.startLine}-${props.endLine}`;

  const submit = async () => {
    if (isSubmitting()) return;
    const text = body().trim();
    if (!text) return;

    setIsSubmitting(true);
    try {
      await props.onSubmit(text);
      setBody("");
    } catch (err) {
      console.error("Failed to add comment:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") {
      props.onCancel();
    }
  };

  return (
    <div>
      <div class="text-sm text-accent mb-2">{lineLabel()}</div>
      <textarea
        value={body()}
        onInput={(e) => setBody(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder="Write a comment..."
        class="w-full px-2 py-1.5 bg-bg border border-border text-text placeholder:text-text-faint focus:border-accent resize-y min-h-[60px] text-sm"
        disabled={isSubmitting()}
        autofocus
      />
      <div class="flex gap-2 mt-2">
        <button
          type="button"
          onClick={submit}
          disabled={!body().trim() || isSubmitting()}
          class="px-2.5 py-1 bg-accent text-black text-sm hover:bg-accent-bright disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSubmitting() ? "Commenting..." : "Comment"}
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          disabled={isSubmitting()}
          class="px-2.5 py-1 text-text-faint text-sm hover:text-text transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
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
