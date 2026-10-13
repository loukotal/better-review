import { For, Show } from "solid-js";

import type { ReviewSession, ReviewSessionDiffVariant } from "@better-review/shared";

import { getVariantCommits } from "../lib/agent-review-context";

interface AgentReviewContextProps {
  session: ReviewSession;
  variant?: ReviewSessionDiffVariant | null;
  hideDiffContext?: boolean;
}

export function AgentReviewContext(props: AgentReviewContextProps) {
  const variant = () => {
    if (props.hideDiffContext) return null;
    if (props.variant) return props.variant;
    const payload = props.session.payload;
    if (payload.kind !== "diff") return null;
    return (
      payload.variants?.find((item) => item.id === payload.selectedVariantId) ??
      payload.variants?.[0]
    );
  };

  return (
    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-faint">
      <Show when={props.session.branch !== undefined}>
        <span class="break-all font-mono" title="Branch at review creation">
          {props.session.branch ?? "Detached HEAD"}
        </span>
      </Show>
      <Show when={variant()?.baseRef}>
        {(base) => (
          <span class="break-all">
            vs <span class="font-mono">{base()}</span>
          </span>
        )}
      </Show>
      <Show when={getVariantCommits(variant()).length > 0}>
        <div class="w-full max-h-24 overflow-y-auto space-y-1" aria-label="Commits in review">
          <For each={getVariantCommits(variant())}>
            {(commit) => (
              <div class="truncate" title={`${commit.sha}\n${commit.message}`}>
                <span class="font-mono">{commit.sha.slice(0, 7)}</span> —{" "}
                {commit.message.split("\n")[0]}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
