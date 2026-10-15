import { createEffect, createSignal, on, Show } from "solid-js";

import { usePrContext } from "../context/PrContext";
import { Alert, Button, Field, MessageForm, Popover, Textarea } from "../design-system";
import { CheckIcon } from "../icons/check-icon";
import { SpinnerIcon } from "../icons/spinner-icon";
import { submitPrReview } from "../lib/pr-review-action";
import { refreshPrListAfterReview } from "../lib/query";
import { trpc } from "../lib/trpc";

export function ApproveButton() {
  const { prUrl } = usePrContext();
  const [open, setOpen] = createSignal(false);
  const [comment, setComment] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [approved, setApproved] = createSignal(false);
  createEffect(
    on(prUrl, () => {
      setOpen(false);
      setComment("");
      setError(null);
      setApproved(false);
    }),
  );
  const handleApprove = async () => {
    const url = prUrl();
    if (!url || submitting() || approved()) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitPrReview(
        () => trpc.pr.approve.mutate({ prUrl: url, body: comment().trim() || undefined }),
        refreshPrListAfterReview,
      );
      if (prUrl() === url) {
        setOpen(false);
        setComment("");
        setApproved(true);
      }
    } catch (err) {
      if (prUrl() === url) setError(err instanceof Error ? err.message : "Failed to approve");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Popover
      label="Approve PR"
      open={open()}
      onOpenChange={setOpen}
      width={320}
      trigger={
        <>
          <CheckIcon size={12} />
          <span>{approved() ? "Approved" : "Approve"}</span>
        </>
      }
      triggerSize="sm"
      triggerVariant={approved() ? "success-subtle" : "success"}
      disabled={!prUrl() || approved() || submitting()}
    >
      {(close) => (
        <MessageForm class="space-y-3" onSubmit={handleApprove} aria-label="Approve PR">
          <Field label="Approval comment (optional)">
            {(id) => (
              <Textarea
                id={id}
                value={comment()}
                disabled={submitting()}
                onInput={(e) => setComment(e.currentTarget.value)}
                placeholder="Leave a comment…"
                class="min-h-20"
              />
            )}
          </Field>
          <Show when={error()}>
            {(message) => (
              <Alert intent="danger" title="Approval failed">
                {message()}
              </Alert>
            )}
          </Show>
          <div class="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="success" size="sm" disabled={submitting()}>
              <Show when={submitting()}>
                <SpinnerIcon size={12} class="animate-spin" />
              </Show>
              {submitting() ? "Approving…" : "Approve PR"}
            </Button>
          </div>
        </MessageForm>
      )}
    </Popover>
  );
}
