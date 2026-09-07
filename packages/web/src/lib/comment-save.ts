import { createSignal } from "solid-js";

import type { PendingCommentFormProps } from "../components/CommentView";
import type { DiffCommentDraft } from "../DiffViewer";
import type { trpc } from "./trpc";

type AddComment = typeof trpc.pr.addComment.mutate;

export async function savePrComment(
  { filePath, line, side, body, startLine, endLine }: DiffCommentDraft,
  options: {
    loadedPrUrl: () => string | null;
    mutate: (input: Parameters<AddComment>[0]) => ReturnType<AddComment>;
    onSaved: (url: string, data: Awaited<ReturnType<AddComment>>) => void;
  },
) {
  const url = options.loadedPrUrl();
  if (!url) throw new Error("No PR loaded");
  const data = await options.mutate({
    prUrl: url,
    filePath,
    line: endLine ?? line,
    side,
    body,
    ...(startLine !== undefined && startLine !== (endLine ?? line)
      ? { startLine, startSide: side }
      : {}),
  });
  if (options.loadedPrUrl() === url) options.onSaved(url, data);
  return data;
}

export function createPendingCommentFormState(props: PendingCommentFormProps) {
  const [body, setBody] = createSignal(props.initialBody ?? "");
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);

  const submit = async () => {
    if (isSubmitting()) return;
    const text = body().trim();
    if (!text) return;

    setSaveError(null);
    setIsSubmitting(true);
    try {
      await props.onSubmit(text);
      setBody("");
      props.onDraftChange?.(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to add comment");
    } finally {
      setIsSubmitting(false);
    }
  };

  return { body, setBody, isSubmitting, saveError, submit };
}
