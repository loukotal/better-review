import { createMemo, createSignal, Show } from "solid-js";
import { render } from "solid-js/web";

import type { GithubPrScope, GithubWriteAction } from "@better-review/shared";

import { Button, MessageForm, Textarea } from "../design-system";
import { remoteCommentDetails } from "../lib/github-comment-views";
import { createGithubEditorDraft } from "../lib/github-editor-draft";
import type { BrowserGithubOperation } from "../lib/github-outbox";
import type { GithubCommentView, GithubThreadView } from "../lib/github-outbox-projection";
import { queueGithubWrite, refreshGithubActor } from "../lib/github-writes";
import { parseMarkdown } from "../lib/markdown";
import { GithubSyncStatus, githubSyncState } from "./GithubSyncStatus";

/** View-model wrapper: a local ref never masquerades as a GitHub numeric comment ID. */
export function createGithubCommentUiState() {
  const [mode, setMode] = createSignal<"edit" | "reply">();
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string>();
  return { mode, setMode, saving, setSaving, error, setError };
}
export function GithubCommentCard(props: {
  uiState?: ReturnType<typeof createGithubCommentUiState>;
  comment: GithubCommentView;
  scope: GithubPrScope;
  operations: BrowserGithubOperation[];
  thread?: GithubThreadView;
}) {
  const details = createMemo(() => remoteCommentDetails(props.comment));
  const { mode, setMode, saving, setSaving, error, setError } =
    props.uiState ?? createGithubCommentUiState();
  const editDraft = createGithubEditorDraft({
    slot: () => `${props.scope.url}:${props.comment.key}:edit`,
    url: () => props.scope.url,
    lazy: true,
  });
  const replyDraft = createGithubEditorDraft({
    slot: () => `${props.scope.url}:${props.comment.key}:reply`,
    url: () => props.scope.url,
    lazy: true,
  });
  const activeDraft = () => (mode() === "edit" ? editDraft : replyDraft);
  const dependencies = () =>
    [...new Set([...props.comment.operationIds, ...(props.thread?.operationIds ?? [])])].filter(
      (id) =>
        props.operations.some(
          (item) => item.command.operationId === id && item.status !== "cancelled",
        ),
    );
  const ref = () => props.comment.localRef ?? props.comment.ref;
  const syncState = () => {
    if (!props.comment.pending) return undefined;
    const items = props.operations.filter((item) =>
      props.comment.operationIds.includes(item.command.operationId),
    );
    return githubSyncState(items) ?? "local-pending";
  };
  const threadSyncState = () =>
    props.thread?.pending
      ? (githubSyncState(
          props.operations.filter((item) =>
            props.thread?.operationIds.includes(item.command.operationId),
          ),
        ) ?? "local-pending")
      : undefined;
  const submit = async (action: GithubWriteAction) => {
    if (saving()) return;
    setSaving(true);
    setError(undefined);
    try {
      if ("body" in action) {
        await activeDraft().submit((text, key, context) =>
          queueGithubWrite(
            props.scope.url,
            action.kind === "edit-comment"
              ? {
                  ...action,
                  body: text.trim(),
                  expectedBody: context.expectedBody ?? action.expectedBody,
                }
              : reply(text.trim(), context),
            key,
            dependencies(),
          ),
        );
      } else await queueGithubWrite(props.scope.url, action, undefined, dependencies());
      setMode(undefined);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save locally. Keep your draft and check your GitHub sign-in.",
      );
    } finally {
      setSaving(false);
    }
  };
  const reply = (text: string, context = replyDraft.context()): GithubWriteAction => {
    const target = ref();
    if (target.kind === "review-comment")
      return { kind: "reply", target: { ...target, kind: "review-comment" }, body: text };
    const quoted = (context.quotedBody ?? props.comment.body)
      .split("\n")
      .slice(0, 3)
      .map((line) => `> ${line}`)
      .join("\n");
    return {
      kind: "issue-comment",
      body: `${quoted}\n\n@${context.replyLogin ?? details().login} ${text}`,
    };
  };
  return (
    <article
      data-github-comment-key={props.comment.key}
      data-comment-deleted={props.comment.deleted ? "true" : undefined}
      class="bg-bg-elevated border border-border p-3"
    >
      <Show
        when={!props.comment.deleted}
        fallback={
          <>
            <p class="flex items-center gap-1">
              {props.comment.pending ? "Deletion" : "Comment deleted"}
              <Show when={syncState()}>{(status) => <GithubSyncStatus status={status()} />}</Show>
            </p>
            <details>
              <summary>Recover deleted content</summary>
              <pre class="whitespace-pre-wrap">{props.comment.body}</pre>
            </details>
            <Show when={editDraft.body() || replyDraft.body()}>
              <details>
                <summary>Recover unsent editor draft</summary>
                <pre class="whitespace-pre-wrap">{editDraft.body() || replyDraft.body()}</pre>
              </details>
            </Show>
          </>
        }
      >
        <div class="flex items-center gap-2 mb-1 text-sm">
          <Show when={details().avatar}>
            <img src={details().avatar} alt="" class="w-4 h-4 rounded-sm" />
          </Show>
          <span>{details().login}</span>
          <Show when={details().url}>
            <a href={details().url} target="_blank" rel="noreferrer" class="text-text-faint">
              {details().createdAt ? new Date(details().createdAt!).toLocaleDateString() : "GitHub"}
            </a>
          </Show>
          <Show when={syncState()}>{(status) => <GithubSyncStatus status={status()} />}</Show>
          <Show when={saving()}>
            <GithubSyncStatus status="saving-local" />
          </Show>
        </div>
        <Show
          when={
            props.thread?.ref.source === "local" &&
            props.comment.confirmed?.kind === "review-comment" &&
            !props.comment.confirmed.threadId
          }
        >
          <p class="text-xs text-text-muted">
            Comment synced; waiting to discover the GitHub thread. Thread actions are queued with
            that dependency.
          </p>
        </Show>
        <Show when={mode() !== "edit"}>
          <div
            data-comment-body
            class="typeset text-sm text-text-muted"
            innerHTML={parseMarkdown(props.comment.body, {
              owner: props.scope.owner,
              repo: props.scope.repo,
            })}
          />
        </Show>
        <Show
          when={!mode()}
          fallback={
            <MessageForm
              aria-label={mode() === "edit" ? "Edit comment" : "Reply to comment"}
              onSubmit={() =>
                submit(
                  mode() === "edit"
                    ? {
                        kind: "edit-comment",
                        target: ref(),
                        body: activeDraft().body().trim(),
                        expectedBody: editDraft.context().expectedBody ?? props.comment.body,
                      }
                    : reply(activeDraft().body().trim()),
                )
              }
            >
              <Textarea
                aria-label="Comment"
                value={activeDraft().body()}
                onInput={(event) => activeDraft().setBody(event.currentTarget.value)}
                disabled={saving() || !activeDraft().ready()}
              />
              <Button
                type="submit"
                size="sm"
                disabled={!activeDraft().body().trim() || saving() || !activeDraft().ready()}
              >
                Save locally
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setMode(undefined)}
                disabled={saving()}
              >
                Keep draft and close
              </Button>
            </MessageForm>
          }
        >
          <div class="flex gap-2 mt-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void replyDraft.open({
                  body: "",
                  context: { quotedBody: props.comment.body, replyLogin: details().login },
                });
                setMode("reply");
              }}
            >
              Reply
            </Button>
            <Show when={details().canEdit}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void editDraft.open({
                    body: props.comment.body,
                    context: { expectedBody: props.comment.body },
                  });
                  setMode("edit");
                }}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={saving()}
                onClick={() => {
                  if (confirm("Queue deletion? Content remains recoverable until confirmed."))
                    void submit({
                      kind: "delete-comment",
                      target: ref(),
                      expectedBody: props.comment.body,
                    });
                }}
              >
                Delete
              </Button>
            </Show>
            <Show when={props.thread}>
              <Button
                size="sm"
                variant="ghost"
                disabled={saving()}
                onClick={() => {
                  const thread = props.thread;
                  if (thread)
                    void submit({
                      kind: thread.resolved ? "unresolve-thread" : "resolve-thread",
                      target: thread.ref,
                    });
                }}
              >
                {props.thread?.resolved ? "Unresolve" : "Resolve"}
              </Button>
              <Show when={threadSyncState()}>
                {(status) => <GithubSyncStatus status={status()} />}
              </Show>
            </Show>
          </div>
        </Show>
      </Show>
      <Show when={error() || editDraft.error() || replyDraft.error()}>
        <p role="alert" class="text-error text-sm">
          {error() ?? editDraft.error() ?? replyDraft.error()}
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void refreshGithubActor()
              .then(() =>
                setError("Account checked. Your draft is retained; choose Save locally again."),
              )
              .catch(() =>
                setError(
                  "Cannot reach the local backend. Keep your draft and check gh auth login when it reconnects.",
                ),
              );
          }}
        >
          Check GitHub account
        </Button>
      </Show>
    </article>
  );
}
export function renderGithubCommentCard(
  container: HTMLElement,
  props: Parameters<typeof GithubCommentCard>[0],
) {
  return render(() => <GithubCommentCard {...props} />, container);
}
