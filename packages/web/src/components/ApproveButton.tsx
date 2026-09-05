import { createEffect, createSignal, on, Show } from "solid-js";

import { usePrContext } from "../context/PrContext";
import { Alert, Button, Field, Popover, Textarea } from "../design-system";
import { CheckIcon } from "../icons/check-icon";
import { SpinnerIcon } from "../icons/spinner-icon";
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
      await trpc.pr.approve.mutate({ prUrl: url, body: comment().trim() || undefined });
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
        <div class="space-y-3">
          <Field label="Approval comment (optional)">
            {(id) => (
              <Textarea
                id={id}
                value={comment()}
                disabled={submitting()}
                onInput={(e) => setComment(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void handleApprove();
                  }
                }}
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
            <Button
              type="button"
              variant="success"
              size="sm"
              onClick={() => void handleApprove()}
              disabled={submitting()}
            >
              <Show when={submitting()}>
                <SpinnerIcon size={12} class="animate-spin" />
              </Show>
              {submitting() ? "Approving…" : "Approve PR"}
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}
