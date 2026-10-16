import { Show } from "solid-js";
import { render } from "solid-js/web";

import { createCachedCommentDraft } from "../lib/interaction-drafts";
export { createCachedCommentDraft } from "../lib/interaction-drafts";
import { PendingCommentForm, type PendingCommentFormProps } from "./CommentView";

export type CachedCommentDraft = ReturnType<typeof createCachedCommentDraft>;

/** Keep bodies and the in-flight lock outside diff annotation render lifetimes. */
export function CachedCommentForm(props: {
  draft: CachedCommentDraft;
  startLine: number;
  endLine: number;
  disabled?: () => boolean;
  onSubmit: (body: string, draftKey?: string) => Promise<void>;
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
      <fieldset
        disabled={props.disabled?.() || props.draft.submitting() || !props.draft.state.ready()}
      >
        <PendingCommentForm
          state={props.draft.state}
          startLine={props.startLine}
          endLine={props.endLine}
          initialBody={props.draft.body}
          onDraftChange={props.onDraftChange}
          onCancel={props.onCancel}
          onSubmit={async (body, key) => {
            await props.onSubmit(body, key);
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
