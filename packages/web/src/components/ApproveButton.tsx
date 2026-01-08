import { createSignal, Show } from "solid-js";
import { usePrContext } from "../context/PrContext";
import { trpc } from "../lib/trpc";

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}

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
      <button
        type="button"
        onClick={() => setOpen(!open())}
        disabled={!prUrl() || approved()}
        class="flex items-center gap-1.5 px-2.5 py-1 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        classList={{
          "bg-green-600 text-white hover:bg-green-500": !approved(),
          "bg-green-600/20 text-green-400 border border-green-600/50": approved(),
        }}
        title={approved() ? "PR approved" : "Approve this PR"}
      >
        <CheckIcon />
        <span>{approved() ? "Approved" : "Approve"}</span>
      </button>

      <Show when={open()}>
        {/* Backdrop */}
        <div class="fixed inset-0 z-40" onClick={() => setOpen(false)} />

        {/* Popover */}
        <div class="absolute top-full right-0 mt-1 z-50 w-[300px] border border-border bg-bg-surface shadow-lg shadow-black/50">
          {/* Header */}
          <div class="px-3 py-2 border-b border-border flex items-center justify-between">
            <span class="text-sm text-text">Approve PR</span>
            <button
              onClick={() => setOpen(false)}
              class="text-text-faint hover:text-text text-base leading-none"
            >
              ×
            </button>
          </div>

          <div class="p-3">
            <textarea
              value={comment()}
              onInput={(e) => setComment(e.currentTarget.value)}
              placeholder="Leave a comment (optional)..."
              class="w-full px-2 py-1.5 bg-bg border border-border text-sm text-text placeholder:text-text-faint resize-y min-h-[80px] focus:border-accent focus:outline-none"
            />

            <Show when={error()}>
              <div class="mt-2 px-2 py-1.5 border border-red-500/50 bg-red-500/10 text-red-400 text-base">
                {error()}
              </div>
            </Show>

            <div class="flex gap-2 mt-3">
              <button
                type="button"
                onClick={handleApprove}
                disabled={submitting()}
                class="flex-1 px-3 py-1.5 bg-green-600 text-white text-sm hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submitting() ? "Approving..." : "Submit approval"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                class="px-3 py-1.5 text-text-faint text-sm hover:text-text transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
