import { createEffect, createMemo, createSignal, on, Show } from "solid-js";

import type { PrDetail } from "@better-review/shared";

import { Button } from "../design-system";
import { githubDraftConfirmation } from "../lib/github-comment-views";
import type { BrowserGithubOperation } from "../lib/github-outbox";
import { currentGithubActor, githubPrScope, queueGithubWrite } from "../lib/github-writes";
import { GithubSyncStatus, githubSyncState } from "./GithubSyncStatus";

/** Detail is live evidence, never the retained display snapshot. */
export function PrDraftControl(props: {
  url: string;
  detail?: PrDetail;
  canSubmit: boolean;
  operations: readonly BrowserGithubOperation[];
}) {
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string>();
  createEffect(
    on(
      () => props.url,
      () => setError(undefined),
    ),
  );
  const canonicalUrl = () => githubPrScope(props.url).url;
  const samePr = (url?: string) => {
    try {
      return !!url && githubPrScope(url).url === canonicalUrl();
    } catch {
      return false;
    }
  };
  const confirmed = () => githubDraftConfirmation(canonicalUrl(), props.detail, props.operations);
  const operations = createMemo(() =>
    props.operations.filter(
      (item) =>
        item.command.scope.url === canonicalUrl() && item.command.action.kind === "set-draft",
    ),
  );
  const pending = () =>
    operations().filter(
      (item) =>
        !item.operation?.archivedAt && item.status !== "synced" && item.status !== "cancelled",
    );
  const metadata = () => {
    const section = props.detail?.metadata;
    return section?.status === "available" ? section.data : undefined;
  };
  const waitingForDetail = () => !!confirmed();
  const allowed = () => {
    const detail = props.detail,
      caps = detail?.stageCapabilities;
    return (
      props.canSubmit &&
      samePr(detail?.url) &&
      samePr(metadata()?.url) &&
      detail?.metadata.status === "available" &&
      detail.metadata.complete &&
      detail?.actor.status === "available" &&
      detail.actor.complete &&
      detail.actor.data.databaseId === currentGithubActor()?.id &&
      !!currentGithubActor() &&
      caps?.status === "available" &&
      caps.complete &&
      caps.data.canSetDraft &&
      metadata()?.state === "OPEN"
    );
  };
  const submit = async () => {
    const meta = metadata(),
      url = props.url;
    if (!meta || !allowed() || saving() || pending().length || waitingForDetail()) return;
    // Freeze identity and desired state before any await. Never toggle remotely.
    const action = { kind: "set-draft" as const, pullRequestId: meta.id, draft: !meta.draft };
    setSaving(true);
    setError(undefined);
    try {
      await queueGithubWrite(url, action);
    } catch (cause) {
      if (props.url === url)
        setError(cause instanceof Error ? cause.message : "Draft status could not be saved.");
    } finally {
      setSaving(false);
    }
  };
  const reason = () => {
    const section = props.detail?.stageCapabilities;
    return section?.status === "available"
      ? section.data.reason
      : (section?.message ?? "Refresh PR details to verify draft permissions.");
  };
  return (
    <div class="space-y-1" title={!allowed() ? (reason() ?? undefined) : undefined}>
      <div class="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!allowed() || saving() || pending().length > 0 || waitingForDetail()}
          onClick={() => void submit()}
        >
          {waitingForDetail()
            ? confirmed()?.draft
              ? "Converted to draft"
              : "Ready for review"
            : metadata()?.draft
              ? "Ready for review"
              : "Convert to draft"}
        </Button>
        <Show when={saving() || pending().length}>
          <GithubSyncStatus
            status={saving() ? "saving-local" : (githubSyncState(pending()) ?? "queued")}
            scope={githubPrScope(props.url)}
            operations={pending()}
          />
        </Show>
      </div>
      <Show when={waitingForDetail()}>
        <p role="status" class="text-xs text-text-muted">
          GitHub confirmed. Refresh PR details before changing status again.
        </p>
      </Show>
      <Show when={error()}>
        <p role="alert" class="text-xs text-danger">
          {error()}
        </p>
      </Show>
    </div>
  );
}
