import { Show } from "solid-js";
import { render } from "solid-js/web";

import { createPendingCommentFormState } from "../lib/comment-save";
import { PendingCommentForm, type PendingCommentFormProps } from "./CommentView";

export function createCachedCommentDraft(body: string) {
  const delegates: {
    onSubmit?: (body: string) => Promise<void>;
    disabled?: () => boolean;
    onDraftChange?: PendingCommentFormProps["onDraftChange"];
  } = {};
  const state = createPendingCommentFormState({
    initialBody: body,
    startLine: 1,
    endLine: 1,
    onCancel: () => {},
    onSubmit: async (text) => {
      if (delegates.disabled?.() || !delegates.onSubmit)
        throw new Error("This comment is not ready to submit. Your draft is preserved.");
      await delegates.onSubmit(text);
    },
    onDraftChange: (hasDraft) => delegates.onDraftChange?.(hasDraft),
  });
  return {
    state,
    delegates,
    submitting: state.isSubmitting,
    get body() {
      return state.body();
    },
    set body(value: string) {
      state.setBody(value);
    },
  };
}
export type CachedCommentDraft = ReturnType<typeof createCachedCommentDraft>;

/** Keep bodies and the in-flight lock outside diff annotation render lifetimes. */
export function CachedCommentForm(props: {
  draft: CachedCommentDraft;
  startLine: number;
  endLine: number;
  disabled?: () => boolean;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  onDraftChange?: PendingCommentFormProps["onDraftChange"];
}) {
  props.draft.delegates.onSubmit = props.onSubmit;
  props.draft.delegates.disabled = props.disabled;
  props.draft.delegates.onDraftChange = props.onDraftChange;
  return (
    <>
      <Show when={props.disabled?.()}>
        <p role="status" class="mb-2 text-xs text-text-muted">
          This comment cannot be submitted until its current source revision is verified. Your draft
          is preserved.
        </p>
      </Show>
      <fieldset disabled={props.disabled?.() || props.draft.submitting()}>
        <PendingCommentForm
          state={props.draft.state}
          startLine={props.startLine}
          endLine={props.endLine}
          initialBody={props.draft.body}
          onDraftChange={props.onDraftChange}
          onCancel={props.onCancel}
          onSubmit={async (body) => {
            await props.onSubmit(body);
          }}
        />
      </fieldset>
    </>
  );
}

export function renderCachedCommentForm(
  container: HTMLElement,
  props: Parameters<typeof CachedCommentForm>[0],
) {
  return render(() => <CachedCommentForm {...props} />, container);
}
