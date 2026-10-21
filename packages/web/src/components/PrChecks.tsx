import { createMemo, createSignal, For, Show } from "solid-js";

import type { PrDetailCheck, PrDetailSection } from "@better-review/shared";

import { Button } from "../design-system";
import {
  checkGroups,
  checkPresentation,
  checkUrl,
  summarizePrChecks,
  type CheckGroup,
} from "../lib/pr-checks";

export { checkPresentation } from "../lib/pr-checks";

export function PrChecks(props: {
  checks?: PrDetailSection<PrDetailCheck[]>;
  refreshing?: boolean;
  onRefresh?: () => void;
  loadError?: string;
}) {
  const checks = createMemo(() => (props.checks?.status === "available" ? props.checks.data : []));
  const summary = createMemo(() => summarizePrChecks(checks()));
  const [expanded, setExpanded] = createSignal<Partial<Record<CheckGroup, boolean>>>({});
  const onlyPassed = () => summary().total > 0 && summary().passed === summary().total;
  return (
    <section aria-label="Pull request checks" class="space-y-3">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-lg font-semibold">
          Checks{" "}
          <Show when={props.checks?.status === "available"}>
            <span class="ml-2 font-mono text-sm font-normal text-text-muted">
              {summary().total}
            </span>
          </Show>
        </h2>
        <Show when={props.onRefresh}>
          <Button
            size="sm"
            variant="ghost"
            disabled={props.refreshing}
            aria-busy={props.refreshing}
            onClick={props.onRefresh}
          >
            Refresh checks
          </Button>
        </Show>
      </div>
      <Show when={props.loadError && props.checks?.status === "available"}>
        <p role="alert" class="rounded border border-warning/30 p-3 text-sm text-text-muted">
          Could not refresh checks. Showing previous results. {props.loadError}
        </p>
      </Show>
      <Show
        when={props.checks || props.loadError}
        fallback={
          <p role="status" class="text-sm text-text-muted">
            Loading checks…
          </p>
        }
      >
        <Show
          when={props.checks?.status === "available"}
          fallback={
            <div role="alert" class="rounded border border-error/30 bg-bg-surface p-3 text-sm">
              <p class="font-medium">Checks unavailable</p>
              <p class="mt-1 text-text-muted">
                {props.checks?.status === "unavailable"
                  ? props.checks.message
                  : (props.loadError ?? "Check results could not be loaded.")}
              </p>
              <Show when={props.onRefresh}>
                <p class="mt-2 text-text-muted">
                  Use Refresh checks to try this read again. No GitHub action will be started.
                </p>
              </Show>
            </div>
          }
        >
          <Show when={props.checks?.status === "available" && !props.checks.complete}>
            <p role="status" class="rounded border border-warning/30 p-3 text-sm text-warning">
              Check results are incomplete. Missing results are unknown, not passed.
            </p>
          </Show>
          <Show
            when={checks().length}
            fallback={
              <p class="text-sm text-text-muted">
                {props.checks?.status === "available" && props.checks.complete
                  ? "No checks reported."
                  : "No check results loaded. Results are incomplete."}
              </p>
            }
          >
            <p
              aria-label="Check summary"
              role="status"
              class="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-muted"
            >
              <For each={checkGroups}>
                {(group) => (
                  <Show when={summary()[group.key]}>
                    <span
                      class={
                        group.key === "failed"
                          ? "text-error"
                          : group.key === "pending"
                            ? "text-warning"
                            : undefined
                      }
                    >
                      {summary()[group.key]}{" "}
                      {group.key === "other" ? "skipped / neutral / cancelled" : group.key}
                    </span>
                  </Show>
                )}
              </For>
            </p>
            <div class="overflow-hidden rounded border border-border divide-y divide-border">
              <For each={checkGroups}>
                {(group) => (
                  <Show when={summary()[group.key]}>
                    <details
                      open={expanded()[group.key] ?? (group.key !== "passed" || onlyPassed())}
                      onToggle={(event) => {
                        const open = event.currentTarget.open;
                        setExpanded((previous) =>
                          previous[group.key] === open
                            ? previous
                            : { ...previous, [group.key]: open },
                        );
                      }}
                    >
                      <summary class="cursor-pointer bg-bg-surface px-3 py-2 text-sm font-medium">
                        {group.label}{" "}
                        <span class="ml-1 font-mono text-xs text-text-muted">
                          ({summary()[group.key]})
                        </span>
                      </summary>
                      <ul class="divide-y divide-border">
                        <For
                          each={checks().filter(
                            (check) => checkPresentation(check).group === group.key,
                          )}
                        >
                          {(check) => (
                            <li
                              data-check-kind={check.kind}
                              class="flex min-w-0 items-start gap-3 px-3 py-2 text-sm"
                            >
                              <span
                                class={`${checkPresentation(check).tone} shrink-0`}
                                aria-hidden="true"
                              >
                                {checkPresentation(check).icon}
                              </span>
                              <Show
                                when={checkUrl(check.url)}
                                fallback={
                                  <span class="min-w-0 flex-1 break-words">{check.name}</span>
                                }
                              >
                                {(href) => (
                                  <a
                                    class="min-w-0 flex-1 break-words text-text hover:text-accent hover:underline"
                                    href={href()}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    {check.name}
                                  </a>
                                )}
                              </Show>
                              <span
                                class={`${checkPresentation(check).tone} shrink-0 text-right text-xs`}
                              >
                                {checkPresentation(check).label}
                              </span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </details>
                  </Show>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </section>
  );
}
