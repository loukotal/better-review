import { createSignal } from "solid-js";

import { createPendingCommentFormState } from "./comment-save";

/** Retained independently of editor and portal lifetimes. */
export function createSelectionQuestionState() {
  const [question, setQuestion] = createSignal("");
  const [target, setTarget] = createSignal("current");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [collapsed, setCollapsed] = createSignal(false);
  return {
    question,
    setQuestion,
    target,
    setTarget,
    sending,
    setSending,
    error,
    setError,
    collapsed,
    setCollapsed,
  };
}

export function createCachedCommentDraft(body: string, draftKey?: string, prUrl?: string | null) {
  const delegates: {
    onSubmit?: (body: string, draftKey?: string) => Promise<void>;
    disabled?: () => boolean;
    onDraftChange?: (hasDraft: boolean) => void;
  } = {};
  const state = createPendingCommentFormState({
    initialBody: body,
    draftKey,
    prUrl,
    startLine: 1,
    endLine: 1,
    onCancel: () => {},
    onSubmit: async (text, key) => {
      if (delegates.disabled?.() || !delegates.onSubmit)
        throw new Error("This comment is not ready to submit. Your draft is preserved.");
      await delegates.onSubmit(text, key);
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
