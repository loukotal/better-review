import { For } from "solid-js";

import { Popover } from "../design-system";

export function ReviewActions(props: {
  disabled: boolean;
  canPull: boolean;
  onReview: () => void;
  onSummarize: () => void;
  onSecurity: () => void;
  onPull: () => void;
  onCompact: () => void;
  onCopy: () => void;
  canCopy: boolean;
}) {
  const actions = () => [
    { label: "Run review", description: "Review again in this conversation.", run: props.onReview },
    {
      label: "Summarize changes",
      description: "Explain what changed in this PR.",
      run: props.onSummarize,
    },
    {
      label: "Run security review",
      description: "Check these changes for security concerns.",
      run: props.onSecurity,
    },
    ...(props.canPull
      ? [
          {
            label: "Pull latest & continue",
            description: "Fetch new commits and recheck findings. Keeps your history and notes.",
            run: props.onPull,
          },
        ]
      : []),
    {
      label: "Compact context",
      description: "Summarize older model context. The full transcript stays visible.",
      run: props.onCompact,
    },
    ...(props.canCopy
      ? [
          {
            label: "Copy feedback",
            description: "Copy the review feedback to your clipboard.",
            run: props.onCopy,
          },
        ]
      : []),
  ];
  return (
    <Popover label="Review actions" trigger="Actions" triggerSize="sm" width={320}>
      {(close) => (
        <div class="space-y-1">
          <For each={actions()}>
            {(action) => (
              <button
                type="button"
                class="w-full rounded-md px-3 py-2 text-left hover:bg-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={props.disabled}
                onClick={() => {
                  close();
                  action.run();
                }}
              >
                <span class="block text-sm font-medium">{action.label}</span>
                <span class="mt-0.5 block text-xs text-text-muted">{action.description}</span>
              </button>
            )}
          </For>
        </div>
      )}
    </Popover>
  );
}
