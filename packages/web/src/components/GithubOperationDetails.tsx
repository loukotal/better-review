import { createSignal, For, Show } from "solid-js";

import type { GithubPrScope } from "@better-review/shared";

import { Button } from "../design-system";
import type { BrowserGithubOperation } from "../lib/github-outbox";
import { githubWrites } from "../lib/github-writes";

/** Uncertain writes may be checked, never blindly resent. */
export function GithubOperationDetails(props: {
  scope: GithubPrScope;
  operations: readonly BrowserGithubOperation[];
}) {
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const checkAdmission = async (item: BrowserGithubOperation) => {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      await githubWrites.retryAdmission(props.scope, item.command.operationId);
    } catch {
      setError("Admission could not be checked. Saved content is retained.");
    } finally {
      setBusy(false);
    }
  };
  const control = async (item: BrowserGithubOperation, kind: "retry" | "reconcile" | "cancel") => {
    if (!item.operation || busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      const receipt = await githubWrites.control(props.scope, {
        kind,
        requestId: crypto.randomUUID(),
        operationId: item.command.operationId,
        expectedRevision: item.operation.revision,
      });
      if (receipt?.outcome === "rejected") setError(receipt.error.message);
    } catch {
      setError("Control not acknowledged. Saved work is retained; reconnect to check again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="space-y-3 text-xs">
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
      <For each={props.operations}>
        {(item) => (
          <div class="space-y-2" data-operation-id={item.command.operationId}>
            <p>
              {item.command.action.kind} · {item.status}
            </p>
            <Show when={item.operation?.error || item.admissionError}>
              <p role="alert">{item.operation?.error?.message ?? item.admissionError}</p>
            </Show>
            <Show when={item.status === "uncertain"}>
              <p>GitHub may already have this change. Check again; do not resend.</p>
            </Show>
            <div class="flex flex-wrap gap-2">
              <Show when={!item.backendOwned}>
                <Button size="sm" disabled={busy()} onClick={() => void checkAdmission(item)}>
                  Check admission again
                </Button>
              </Show>
              <Show when={item.status === "retry-failed"}>
                <Button size="sm" disabled={busy()} onClick={() => void control(item, "retry")}>
                  Retry
                </Button>
              </Show>
              <Show when={item.status === "uncertain"}>
                <Button size="sm" disabled={busy()} onClick={() => void control(item, "reconcile")}>
                  Check GitHub again (no resend)
                </Button>
              </Show>
              <Show when={item.status === "queued" || item.status === "retry-failed"}>
                <Button size="sm" disabled={busy()} onClick={() => void control(item, "cancel")}>
                  Cancel queued write
                </Button>
              </Show>
            </div>
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
          </div>
        )}
      </For>
    </div>
  );
}
