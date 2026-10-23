import { createSignal, createEffect, createMemo, onCleanup, For, Show } from "solid-js";

import type { GithubPrScope } from "@better-review/shared";

import { useGithubQueue } from "../context/GithubQueueContext";
import { Button } from "../design-system";
import { githubActionLabel } from "../lib/github-action-label";
import type { BrowserGithubOperation } from "../lib/github-outbox";
import { revealGithubQueueContent } from "../lib/github-queue-layout";
import { getGithubSyncTimeoutMs } from "../lib/github-queue-settings";
import { githubWrites } from "../lib/github-writes";
import {
  GithubSyncIndicator as GithubSyncStatus,
  githubOperationSyncState,
} from "./GithubSyncIndicator";

function operationErrorMessage(item: BrowserGithubOperation): string | undefined {
  const error = item.operation?.error;
  return error
    ? `${error.message}${error.httpStatus ? ` (HTTP ${error.httpStatus})` : ""}`
    : item.admissionError;
}

/** Uncertain writes may be checked, never blindly resent. */
export function GithubOperationDetails(props: {
  scope: GithubPrScope;
  operations: readonly BrowserGithubOperation[];
  ancestors?: readonly string[];
  compact?: boolean;
  onRevealBlocker?: (operationId: string) => boolean;
}) {
  const [error, setError] = createSignal<string>();
  const decisions = githubWrites.createDecisions();
  const [decisionState, setDecisionState] = createSignal(decisions.getState());
  onCleanup(decisions.subscribe(() => setDecisionState(decisions.getState())));
  onCleanup(() => decisions.dispose());
  const checkingDelivery = () => decisionState().checkingDelivery;
  const deliveryChecks = () => decisionState().deliveryChecks;
  const retries = () => decisionState().retries;
  const retryErrorMessage = (id: string) => {
    const facts = retries()[id];
    const error = facts?.backendError;
    return error
      ? `${error.message}${error.httpStatus ? ` (HTTP ${error.httpStatus})` : ""}`
      : facts?.admissionError;
  };
  const [version, setVersion] = createSignal(0);
  const [revealed, setRevealed] = createSignal<string>();
  const [confirmation, setConfirmation] = createSignal<{
    item: BrowserGithubOperation;
    scope: GithubPrScope;
  }>();
  const [now, setNow] = createSignal(Date.now());
  const queue = useGithubQueue();
  const busy = () => !!decisionState().busyKind || !!queue?.batchBusy?.();
  if (!queue) onCleanup(githubWrites.subscribe(() => setVersion((value) => value + 1)));
  const all = () =>
    queue?.states().find((state) => state.scope.url === props.scope.url)?.operations ??
    githubWrites.getState(props.scope).operations;
  const operations = createMemo(() =>
    props.operations.map(
      (item) =>
        all().find((entry) => entry.command.operationId === item.command.operationId) ?? item,
    ),
  );
  createEffect(() => {
    if (!props.operations.some((item) => item.admissionRetryAt)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const blocker = (item: BrowserGithubOperation) => {
    version();
    const id = item.blockedByOperationId;
    if (!id || id === item.command.operationId || props.ancestors?.includes(id)) return;
    return all().find((entry) => entry.command.operationId === id);
  };
  const checkAdmission = async (item: BrowserGithubOperation) => {
    if (busy()) return;
    setError(undefined);
    const result = await decisions.run({
      kind: "retry-admission",
      scope: props.scope,
      operationId: item.command.operationId,
      timeoutMs: getGithubSyncTimeoutMs(),
    });
    if (result.kind === "unavailable" || result.kind === "rejected")
      setError("Admission could not be checked. Saved content is retained.");
  };
  const control = async (
    item: BrowserGithubOperation,
    kind: "retry" | "reconcile" | "cancel" | "allow-manual-retry",
    scope = props.scope,
  ) => {
    if (!item.operation || busy()) return;
    setError(undefined);
    const result = await decisions.run({
      kind,
      scope,
      operation: item,
      ...(kind === "retry" ? { timeoutMs: getGithubSyncTimeoutMs() } : {}),
    });
    if (result.kind === "disposed" || result.kind === "ignored") return;
    if (result.kind === "rejected") setError(result.message);
    if (result.kind === "unavailable")
      setError(
        kind === "reconcile"
          ? "Delivery check status is unavailable. No completed GitHub check is confirmed."
          : "Control not acknowledged. Saved work is retained; reconnect to check again.",
      );
    if (kind === "allow-manual-retry") setConfirmation(undefined);
  };
  return (
    <div class="space-y-3 text-xs">
      <For each={operations()}>
        {(item, index) => (
          <div class="space-y-2" data-operation-id={item.command.operationId}>
            <Show
              when={
                !(
                  props.compact &&
                  confirmation()?.item.command.operationId === item.command.operationId
                )
              }
            >
              <Show when={!props.compact}>
                <p class="flex items-center gap-2">
                  <span>{githubActionLabel(item.command.action)}</span>
                  <GithubSyncStatus status={githubOperationSyncState(item)} iconOnly />
                </p>
              </Show>
              <div class="flex flex-wrap gap-2" data-github-primary-controls>
                <Show when={item.blockedByOperationId && props.onRevealBlocker}>
                  <Button
                    size="sm"
                    onClick={() => {
                      if (item.blockedByOperationId)
                        props.onRevealBlocker?.(item.blockedByOperationId);
                    }}
                  >
                    View blocking action
                  </Button>
                </Show>
                <Show when={!item.backendOwned && !item.blockedByOperationId}>
                  <Button
                    size="sm"
                    disabled={
                      busy() ||
                      (!!item.admissionRetryAt && Date.parse(item.admissionRetryAt) > now())
                    }
                    onClick={() => void checkAdmission(item)}
                  >
                    {item.admissionRetryable
                      ? "Verify account again"
                      : item.admissionError
                        ? "Retry saved admission"
                        : "Check admission again"}
                  </Button>
                </Show>
                <Show
                  when={
                    item.status === "retry-failed" &&
                    item.backendOwned &&
                    !item.blockedByOperationId
                  }
                >
                  <Button size="sm" disabled={busy()} onClick={() => void control(item, "retry")}>
                    Retry
                  </Button>
                </Show>
                <Show when={item.status === "uncertain"}>
                  <Button
                    size="sm"
                    disabled={busy()}
                    onClick={() => void control(item, "reconcile")}
                  >
                    {checkingDelivery() === item.command.operationId ||
                    deliveryChecks()[item.command.operationId]?.outcome === "pending"
                      ? "Checking…"
                      : props.compact
                        ? "Check GitHub"
                        : "Check GitHub again (no resend)"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy()}
                    onClick={(event) => {
                      const row = event.currentTarget.closest<HTMLElement>("[data-operation-id]");
                      setConfirmation({
                        item: structuredClone(item),
                        scope: structuredClone(props.scope),
                      });
                      requestAnimationFrame(() => {
                        const consent = row?.querySelector<HTMLElement>(
                          '[aria-label="Allow manual retry confirmation"]',
                        );
                        if (consent) revealGithubQueueContent(consent);
                      });
                    }}
                  >
                    Allow manual retry…
                  </Button>
                </Show>
                <Show
                  when={
                    item.backendOwned &&
                    (item.status === "queued" || item.status === "retry-failed")
                  }
                >
                  <Button size="sm" disabled={busy()} onClick={() => void control(item, "cancel")}>
                    Cancel queued write
                  </Button>
                </Show>
              </div>
              <Show when={retries()[item.command.operationId]}>
                <p role="status" class="text-text-muted">
                  {!retries()[item.command.operationId]!.advanced
                    ? "Retry requested. Waiting for GitHub."
                    : retries()[item.command.operationId]!.status === "inflight" ||
                        retries()[item.command.operationId]!.status === "queued"
                      ? "Retrying on GitHub…"
                      : retries()[item.command.operationId]!.status === "retry-failed"
                        ? `Retry failed: ${retryErrorMessage(item.command.operationId) ?? "GitHub rejected this attempt."}`
                        : retries()[item.command.operationId]!.status === "uncertain"
                          ? "Retry delivery unknown. Do not resend without resolving it."
                          : retries()[item.command.operationId]!.status === "synced"
                            ? "Retry confirmed on GitHub."
                            : "Retry state changed. Refresh its status."}
                </p>
              </Show>
              <Show when={index() === 0 && error()}>
                {(message) => <p role="alert">{message()}</p>}
              </Show>
              <Show when={item.blockedByOperationId && !props.onRevealBlocker}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setRevealed(
                      revealed() === item.command.operationId
                        ? undefined
                        : item.command.operationId,
                    )
                  }
                >
                  Waiting for earlier action
                </Button>
                <Show when={revealed() === item.command.operationId}>
                  <div class="border-l border-warning/40 pl-3" aria-label="Earlier blocking action">
                    <Show
                      when={blocker(item)}
                      fallback={
                        <p>
                          Earlier action is not loaded. Check the pending panel for its current
                          status.
                        </p>
                      }
                    >
                      {(earlier) => (
                        <GithubOperationDetails
                          scope={props.scope}
                          operations={[earlier()]}
                          ancestors={[...(props.ancestors ?? []), item.command.operationId]}
                        />
                      )}
                    </Show>
                  </div>
                </Show>
              </Show>
              <Show
                when={
                  item.status === "uncertain" &&
                  !checkingDelivery() &&
                  deliveryChecks()[item.command.operationId]?.outcome === "unconfirmed"
                }
              >
                <p role="status" class="text-text-muted">
                  Delivery checked{" "}
                  {new Date(deliveryChecks()[item.command.operationId]!.at!).toLocaleTimeString(
                    [],
                    { hour: "2-digit", minute: "2-digit" },
                  )}{" "}
                  · GitHub cannot confirm delivery.
                </p>
              </Show>
              <Show
                when={
                  item.status === "uncertain" &&
                  deliveryChecks()[item.command.operationId]?.outcome === "pending"
                }
              >
                <p role="status" class="text-text-muted">
                  Check requested. Still waiting for GitHub confirmation; use Refresh to check its
                  status.
                </p>
              </Show>
              <Show
                when={
                  item.status === "uncertain" &&
                  deliveryChecks()[item.command.operationId]?.outcome === "failed"
                }
              >
                <p role="status" class="text-warning">
                  Delivery could not be checked. No successful GitHub check is confirmed.
                </p>
              </Show>
              <Show when={item.admissionError && item.admissionRetryable}>
                <p>
                  Waiting for account verification. This action is saved locally, not sent to
                  GitHub.
                </p>
              </Show>
              <Show
                when={
                  item.admissionError && item.admissionRetryable === false && !item.admissionRetryAt
                }
              >
                <p>Admission rejected. The saved action needs your attention.</p>
              </Show>
              <Show when={item.operation?.error || item.admissionError}>
                <Show
                  when={props.compact}
                  fallback={<p role="alert">{operationErrorMessage(item)}</p>}
                >
                  <details>
                    <summary class="cursor-pointer text-text-muted">Diagnostic details</summary>
                    <p role="alert" class="mt-1 break-words">
                      {operationErrorMessage(item)}
                    </p>
                  </details>
                </Show>
              </Show>
              <Show when={item.status === "uncertain"}>
                <p>
                  {item.operation?.timedOutAt
                    ? "Timed out with delivery unknown. Confirmation is required before retrying."
                    : props.compact
                      ? "Delivery is unknown. Checking never resends."
                      : "GitHub may already have this change. Check again; do not resend."}
                </p>
              </Show>
            </Show>
            <Show
              when={
                item.status === "uncertain" &&
                confirmation()?.item.command.operationId === item.command.operationId
              }
            >
              <div
                class="space-y-2 rounded border border-warning/40 p-2"
                aria-label="Allow manual retry confirmation"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setConfirmation(undefined);
                  }
                }}
              >
                <p>GitHub may still have applied this. Retrying can duplicate it.</p>
                <Show when={!props.compact}>
                  <p>This only unlocks Retry or Cancel. It does not send the action.</p>
                </Show>
                <div class="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busy()}
                    onClick={() => {
                      const captured = confirmation();
                      if (captured)
                        void control(captured.item, "allow-manual-retry", captured.scope);
                    }}
                  >
                    I checked GitHub — allow retry
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy()}
                    onClick={() => setConfirmation(undefined)}
                  >
                    Keep delivery unknown
                  </Button>
                </div>
              </div>
            </Show>
            <Show
              when={
                !(
                  props.compact &&
                  confirmation()?.item.command.operationId === item.command.operationId
                )
              }
            >
              <Show
                when={
                  (item.status === "queued" || item.status === "retry-failed") &&
                  all().some((entry) => entry.blockedByOperationId === item.command.operationId)
                }
              >
                <p class="text-text-muted">
                  Cancelling this action automatically unblocks the following queued writes.
                </p>
              </Show>
              <Show when={"body" in item.command.action || "expectedBody" in item.command.action}>
                <details>
                  <summary>Recover saved content</summary>
                  <pre class="whitespace-pre-wrap break-words">
                    {"body" in item.command.action
                      ? item.command.action.body
                      : "expectedBody" in item.command.action
                        ? item.command.action.expectedBody
                        : ""}
                  </pre>
                </details>
              </Show>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
