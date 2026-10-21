import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";

import { usePrContext } from "../context/PrContext";
import { Alert, Button, Field, MessageForm, Popover, Textarea } from "../design-system";
import { CheckIcon } from "../icons/check-icon";
import { createGithubEditorDraft } from "../lib/github-editor-draft";
import type { BrowserGithubOperation } from "../lib/github-outbox";
import {
  currentGithubActor,
  githubPrScope,
  githubWrites,
  queueGithubWrite,
} from "../lib/github-writes";
import { GithubSyncStatus, githubSyncState } from "./GithubSyncStatus";

export function ApproveButton(props: {
  expectedHeadSha?: string | null;
  canSubmit?: boolean;
  approvalState?: "pending" | "synced";
  approvalOperations?: readonly BrowserGithubOperation[];
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
  const cooldown = () =>
    props.approvalOperations?.find((item) => !!item.admissionRetryAt && !item.backendOwned);
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!cooldown()?.admissionRetryAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    onCleanup(() => clearInterval(timer));
  });
  const cooldownSeconds = () =>
    Math.max(0, Math.ceil((Date.parse(cooldown()?.admissionRetryAt ?? "") - now()) / 1000));
  const retryApproval = async () => {
    const item = cooldown(),
      url = prUrl();
    if (
      !item ||
      !url ||
      submitting() ||
      cooldownSeconds() > 0 ||
      props.canSubmit === false ||
      item.command.expectedActor.id !== currentGithubActor()?.id ||
      item.command.action.kind !== "approve" ||
      item.command.action.expectedHeadSha !== props.expectedHeadSha
    )
      return;
    setSubmitting(true);
    setError(null);
    try {
      await githubWrites.retryAdmission(githubPrScope(url), item.command.operationId);
      if (prUrl() === url) setOpen(false);
    } catch {
      if (prUrl() === url) setError("Retry not acknowledged. Your saved approval is retained.");
    } finally {
      setSubmitting(false);
    }
  };
  createEffect(
    on(prUrl, () => {
      setOpen(false);
      setError(null);
    }),
  );
  const cooldownBody = () => {
    const action = cooldown()?.command.action;
    return action?.kind === "approve" ? action.body : "";
  };
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
      label={
        props.approvalState === "pending"
          ? "Approval pending"
          : props.approvalState === "synced"
            ? "You approved"
            : "Approve PR"
      }
      open={open()}
      onOpenChange={(next) => {
        if (next && !props.approvalState)
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
                  : (githubSyncState(props.approvalOperations ?? []) ??
                    (props.approvalState === "synced" ? "synced" : "queued"))
              }
              iconOnly
              operations={props.approvalOperations}
              showSynced
            />
          </Show>
          <span>
            {cooldown()
              ? "Approval pending"
              : props.approvalState === "synced"
                ? "You approved"
                : "Approve"}
          </span>
        </>
      }
      triggerSize="sm"
      triggerVariant={props.approvalState === "synced" ? "success-subtle" : "success"}
      disabled={
        !prUrl() ||
        (!!props.approvalState && !cooldown()) ||
        submitting() ||
        props.canSubmit === false
      }
    >
      {(close) => (
        <Show
          when={cooldown()}
          fallback={
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
          }
        >
          {(_item) => (
            <div class="space-y-3" aria-label="Saved approval cooldown">
              <p role="status">
                {cooldownSeconds() > 0
                  ? `Can approve again in ${cooldownSeconds()}s`
                  : "Can approve again now"}
              </p>
              <p class="text-xs text-text-muted">
                Saved locally, not sent to GitHub. Retry this saved approval when ready.
              </p>
              <Field label="Saved approval comment">
                {(id) => <Textarea id={id} readOnly value={cooldownBody()} />}
              </Field>
              <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
              <Button
                variant="success"
                size="sm"
                disabled={submitting() || cooldownSeconds() > 0}
                onClick={retryApproval}
              >
                Retry approval
              </Button>
            </div>
          )}
        </Show>
      )}
    </Popover>
  );
}
