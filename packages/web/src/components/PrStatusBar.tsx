import { type Component, Show, createMemo } from "solid-js";

import type { PrState, PrStatus, CheckRun } from "@better-review/shared";

import { Badge, Popover, IconButton, Button } from "../design-system";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { CheckIcon } from "../icons/check-icon";
import { CloseIcon } from "../icons/close-icon";
import { CopyIcon } from "../icons/copy-icon";
import { ExternalLinkIcon } from "../icons/external-link-icon";
import { SpinnerIcon } from "../icons/spinner-icon";
import { parseMarkdown } from "../lib/markdown";
import { summarizePrChecks } from "../lib/pr-checks";
import { ReviewDecisionBadge } from "./ReviewDecisionBadge";

interface PrStatusBarProps {
  status: PrStatus | null;
  loading?: boolean;
  repoOwner?: string | null;
  repoName?: string | null;
  onOpenChecks?: () => void;
}

const stateStyles: Record<PrState, { variant: "success" | "neutral" | "merged"; label: string }> = {
  open: { variant: "success", label: "Open" },
  closed: { variant: "neutral", label: "Closed" },
  merged: { variant: "merged", label: "Merged" },
};

function ChecksIndicator(props: { checks: readonly CheckRun[]; onOpen?: () => void }) {
  const summary = createMemo(() => summarizePrChecks(props.checks));

  const status = createMemo(() => {
    const s = summary();
    if (s.failed > 0) return "failed";
    if (s.pending > 0) return "pending";
    if (s.total > 0 && s.passed === s.total) return "passed";
    return "neutral";
  });

  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={props.onOpen}
      disabled={!props.onOpen}
      aria-label="View pull request checks"
      title="View all check runs and status contexts"
      class="flex flex-wrap items-center gap-1.5"
    >
      <Show when={status() === "passed"}>
        <CheckIcon size={12} class="text-success" />
      </Show>
      <Show when={status() === "failed"}>
        <CloseIcon size={12} class="text-error" />
      </Show>
      <Show when={status() === "pending"}>
        <SpinnerIcon size={12} class="text-warning animate-spin" />
      </Show>
      <span class="text-sm text-text-muted">
        {summary().total ? `${summary().passed}/${summary().total} checks` : "Checks"}
      </span>
      <Show when={summary().failed}>
        <span class="text-xs text-error">{summary().failed} failed</span>
      </Show>
      <Show when={summary().pending}>
        <span class="text-xs text-warning">{summary().pending} running</span>
      </Show>
      <Show when={summary().unknown}>
        <span class="text-xs text-text-muted">{summary().unknown} unknown</span>
      </Show>
    </Button>
  );
}

export const PrStatusBar: Component<PrStatusBarProps> = (props) => {
  const { copied, copy } = useCopyToClipboard();

  const githubContext = createMemo(() => {
    if (props.repoOwner && props.repoName) {
      return { owner: props.repoOwner, repo: props.repoName };
    }
    return null;
  });

  return (
    <Show
      when={!props.loading && props.status}
      fallback={
        <Show when={props.loading}>
          <div class="flex items-center gap-2 text-sm text-text-faint">
            <span class="animate-pulse">Loading status...</span>
          </div>
        </Show>
      }
    >
      {(status) => {
        const style = () => stateStyles[status().state];
        const hasDescription = () => status().body.trim().length > 0;

        const prNumber = () => {
          const match = status().url.match(/\/pull\/(\d+)/);
          return match ? match[1] : null;
        };

        return (
          <div class="relative">
            {/* Line 1: PR Number + Full Title */}
            <div class="flex items-baseline gap-2 mb-1">
              <Show when={prNumber()}>
                <span class="text-text-faint text-sm font-mono flex-shrink-0">#{prNumber()}</span>
              </Show>
              <a
                href={status().url}
                target="_blank"
                rel="noopener noreferrer"
                class="text-sm font-medium text-text hover:text-accent inline-flex items-baseline gap-1.5 group leading-snug"
                title="Open PR in GitHub"
              >
                <span class="break-words">{status().title}</span>
                <span
                  class="text-text-faint group-hover:text-accent transition-colors flex-shrink-0"
                  aria-hidden="true"
                >
                  <ExternalLinkIcon size={11} />
                </span>
              </a>
            </div>

            {/* Line 2: State badge, author, branch, CI checks, mergeable, description toggle */}
            <div class="flex items-center gap-3 flex-wrap">
              {/* State badge */}
              <Badge variant={status().draft ? "neutral" : style().variant}>
                {status().draft ? "Draft" : style().label}
              </Badge>

              <ReviewDecisionBadge decision={status().reviewDecision} />

              {/* Author */}
              <span class="text-xs text-text-faint">by {status().author}</span>

              {/* Separator */}
              <span class="text-text-faint/30">•</span>

              {/* Branch name with copy button */}
              <div class="flex items-center gap-1 text-xs">
                <code title={status().headRef} class="max-w-48 truncate text-text-muted font-mono">
                  {status().headRef}
                </code>
                <IconButton
                  label={copied() ? "Branch copied" : "Copy branch name"}
                  onClick={() => copy(status().headRef)}
                  class="p-0.5 text-text-faint hover:text-text transition-colors"
                  title={copied() ? "Copied!" : "Copy branch name"}
                >
                  <Show when={copied()} fallback={<CopyIcon size={14} />}>
                    <CheckIcon size={14} class="text-success" />
                  </Show>
                </IconButton>
              </div>

              {/* CI Checks */}
              <ChecksIndicator checks={status().checks} onOpen={props.onOpenChecks} />

              {/* Mergeable status */}
              <Show when={status().state === "open" && status().mergeable !== null}>
                <div class="flex items-center gap-1">
                  <Show
                    when={status().mergeable}
                    fallback={<span class="text-xs text-error">Conflicts</span>}
                  >
                    <span class="text-xs text-success">Mergeable</span>
                  </Show>
                </div>
              </Show>

              <Show when={hasDescription()}>
                <Popover
                  label="PR description"
                  trigger={<span>Description</span>}
                  triggerSize="sm"
                  width={600}
                  align="left"
                >
                  <div
                    class="typeset text-sm text-text-muted"
                    innerHTML={parseMarkdown(status().body, githubContext())}
                  />
                </Popover>
              </Show>
            </div>
          </div>
        );
      }}
    </Show>
  );
};
