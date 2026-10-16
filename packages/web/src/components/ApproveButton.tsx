import { createEffect, createSignal, on, Show } from "solid-js";

import { usePrContext } from "../context/PrContext";
import { Alert, Button, Field, MessageForm, Popover, Textarea } from "../design-system";
import { CheckIcon } from "../icons/check-icon";
import { createGithubEditorDraft } from "../lib/github-editor-draft";
import { queueGithubWrite } from "../lib/github-writes";
import { GithubSyncStatus, type GithubSyncState } from "./GithubSyncStatus";

export function ApproveButton(props: {
  expectedHeadSha?: string | null;
  canSubmit?: boolean;
  approvalState?: "pending" | "synced";
  approvalSyncState?: GithubSyncState;
}) {
  const { prUrl } = usePrContext();
  const [open, setOpen] = createSignal(false);
  const draft = createGithubEditorDraft({
    slot: () => (prUrl() ? `${prUrl()}:approve` : undefined),
    url: prUrl,
    lazy: true,
  });
  const { body: comment, setBody: setComment, error: storageError } = draft;
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(
    on(prUrl, () => {
      setOpen(false);
      setError(null);
    }),
  );
  const handleApprove = async () => {
    const url = prUrl();
    if (!url || submitting() || props.approvalState) return;
    setSubmitting(true);
    setError(null);
    try {
      if (props.canSubmit === false)
        throw new Error("Wait for the selected PR to load. Your draft is preserved.");
      const expectedHeadSha = draft.context().expectedHeadSha;
      if (!expectedHeadSha)
        throw new Error("Load the current PR head before approving. Your draft is preserved.");
      await draft.submit((text, key) =>
        queueGithubWrite(url, { kind: "approve", expectedHeadSha, body: text.trim() }, key),
      );
      if (prUrl() === url) {
        setOpen(false);
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
      onOpenChange={(next) => {
        if (next)
          void draft.open({
            body: "",
            context: props.expectedHeadSha ? { expectedHeadSha: props.expectedHeadSha } : {},
          });
        setOpen(next);
      }}
      width={320}
      trigger={
        <>
          <Show when={props.approvalState || submitting()} fallback={<CheckIcon size={12} />}>
            <GithubSyncStatus
              status={
                submitting()
                  ? "saving-local"
                  : (props.approvalSyncState ??
                    (props.approvalState === "synced" ? "synced" : "queued"))
              }
              iconOnly
              showSynced
            />
          </Show>
          <span>
            {props.approvalState === "synced"
              ? "Approved"
              : props.approvalState === "pending"
                ? "Approval pending"
                : "Approve"}
          </span>
        </>
      }
      triggerSize="sm"
      triggerVariant={props.approvalState === "synced" ? "success-subtle" : "success"}
      disabled={!prUrl() || !!props.approvalState || submitting() || props.canSubmit === false}
    >
      {(close) => (
        <MessageForm class="space-y-3" onSubmit={handleApprove} aria-label="Approve PR">
          <Field label="Approval comment (optional)">
            {(id) => (
              <Textarea
                id={id}
                value={comment()}
                disabled={submitting() || !draft.ready() || !draft.context().expectedHeadSha}
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
          <Show when={storageError()}>
            <p role="alert">{storageError()}</p>
          </Show>
          <div class="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="success"
              size="sm"
              disabled={submitting() || !draft.ready() || !draft.context().expectedHeadSha}
            >
              <Show when={submitting()}>
                <GithubSyncStatus status="saving-local" iconOnly />
              </Show>
              {submitting() ? "Saving locally…" : "Approve PR"}
            </Button>
          </div>
        </MessageForm>
      )}
    </Popover>
  );
}
