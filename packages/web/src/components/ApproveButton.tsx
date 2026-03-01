import { createSignal, Show } from "solid-js";

import { usePrContext } from "../context/PrContext";
import { Button, Textarea } from "../design-system";
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

  const handleApprove = async () => {
    const url = prUrl();
    if (!url) return;

    setSubmitting(true);
    setError(null);

    try {
      await trpc.pr.approve.mutate({
        prUrl: url,
        body: comment().trim() || undefined,
      });

      setOpen(false);
      setComment("");
      setApproved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="relative">
      <Button
        type="button"
        onClick={() => setOpen(!open())}
        disabled={!prUrl() || approved()}
        variant={approved() ? "success-subtle" : "success"}
        size="sm"
        title={approved() ? "PR approved" : "Approve this PR"}
      >
        <CheckIcon size={12} />
        <span>{approved() ? "Approved" : "Approve"}</span>
      </Button>

      <Show when={open()}>
        {/* Backdrop */}
        <div class="fixed inset-0 z-40" onClick={() => setOpen(false)} />

        {/* Popover */}
        <div class="absolute top-full right-0 mt-1 z-50 w-75 border border-border bg-bg-surface shadow-lg shadow-black/50">
          {/* Header */}
          <div class="px-3 py-2 border-b border-border flex items-center justify-between">
            <span class="text-sm text-text">Approve PR</span>
            <Button onClick={() => setOpen(false)} variant="ghost" size="xs" class="leading-none">
              ×
            </Button>
          </div>

          <div class="p-3">
            <Textarea
              value={comment()}
              onInput={(e) => setComment(e.currentTarget.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !submitting()) {
                  e.preventDefault();
                  handleApprove();
                }
              }}
              placeholder="Leave a comment (optional)..."
              class="min-h-20"
            />

            <Show when={error()}>
              <div class="mt-2 px-2 py-1.5 border border-red-500/50 bg-red-500/10 text-red-400 text-base">
                {error()}
              </div>
            </Show>

            <div class="flex gap-2 mt-3">
              <Button
                type="button"
                onClick={handleApprove}
                disabled={submitting()}
                variant="success"
                size="md"
                fullWidth
              >
                <Show when={submitting()}>
                  <SpinnerIcon size={12} class="animate-spin" />
                </Show>
                {submitting() ? "Approving..." : "Approve"}
              </Button>
              <Button type="button" onClick={() => setOpen(false)} variant="ghost" size="md">
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
