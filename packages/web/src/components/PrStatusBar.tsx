import { type Component, Show, createMemo, createSignal, createEffect, onCleanup } from "solid-js";

import type { PrState, PrStatus, CheckRun } from "@better-review/shared";

import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { CheckIcon } from "../icons/check-icon";
import { ChevronDownIcon } from "../icons/chevron-down-icon";
import { CloseIcon } from "../icons/close-icon";
import { CopyIcon } from "../icons/copy-icon";
import { ExternalLinkIcon } from "../icons/external-link-icon";
import { SpinnerIcon } from "../icons/spinner-icon";
import { parseMarkdown } from "../lib/markdown";

interface PrStatusBarProps {
  status: PrStatus | null;
  loading?: boolean;
  repoOwner?: string | null;
  repoName?: string | null;
}

const stateStyles: Record<PrState, { bg: string; text: string; label: string }> = {
  open: { bg: "bg-success/20", text: "text-success", label: "Open" },
  closed: { bg: "bg-error/20", text: "text-error", label: "Closed" },
  merged: { bg: "bg-merged/20", text: "text-merged", label: "Merged" },
};

function ChecksIndicator(props: { checks: readonly CheckRun[] }) {
  const summary = createMemo(() => {
    const checks = props.checks;
    if (checks.length === 0) return null;

    const completed = checks.filter((c) => c.status === "completed");
    const inProgress = checks.filter((c) => c.status === "in_progress" || c.status === "queued");
    const failed = completed.filter(
      (c) => c.conclusion === "failure" || c.conclusion === "timed_out",
    );
    const passed = completed.filter(
      (c) => c.conclusion === "success" || c.conclusion === "skipped" || c.conclusion === "neutral",
    );

    return {
      total: checks.length,
      completed: completed.length,
      inProgress: inProgress.length,
      failed: failed.length,
      passed: passed.length,
    };
  });

  const status = createMemo(() => {
    const s = summary();
    if (!s) return null;
    if (s.failed > 0) return "failed";
    if (s.inProgress > 0) return "pending";
    if (s.passed === s.total) return "passed";
    return "pending";
  });

  return (
    <Show when={summary()}>
      {(s) => (
        <div class="flex items-center gap-1.5">
          <Show when={status() === "passed"}>
            <CheckIcon size={12} class="text-success" />
          </Show>
          <Show when={status() === "failed"}>
            <CloseIcon size={12} class="text-error" />
          </Show>
          <Show when={status() === "pending"}>
            <SpinnerIcon size={12} class="text-yellow-500 animate-spin" />
          </Show>
          <span class="text-sm text-text-muted">
            {s().passed}/{s().total} checks
          </span>
        </div>
      )}
    </Show>
  );
}

export const PrStatusBar: Component<PrStatusBarProps> = (props) => {
  const [showDescription, setShowDescription] = createSignal(false);
  const { copied, copy } = useCopyToClipboard();

  const githubContext = createMemo(() => {
    if (props.repoOwner && props.repoName) {
      return { owner: props.repoOwner, repo: props.repoName };
    }
    return null;
  });

  // Close description panel on Escape key
  createEffect(() => {
    if (showDescription()) {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          setShowDescription(false);
        }
      };
      document.addEventListener("keydown", handleKeyDown);
      onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
    }
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
                title="Open in GitHub"
              >
                <span class="break-words">{status().title}</span>
                <span class="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  <ExternalLinkIcon size={10} />
                </span>
              </a>
            </div>

            {/* Line 2: State badge, author, branch, CI checks, mergeable, description toggle */}
            <div class="flex items-center gap-3 flex-wrap">
              {/* State badge */}
              <div class={`flex items-center gap-1.5 px-1.5 py-0.5 ${style().bg}`}>
                <span class={`text-xs font-medium ${style().text}`}>
                  {status().draft ? "Draft" : style().label}
                </span>
              </div>

              {/* Author */}
              <span class="text-xs text-text-faint">by {status().author}</span>

              {/* Separator */}
              <span class="text-text-faint/30">•</span>

              {/* Branch name with copy button */}
              <div class="flex items-center gap-1 text-xs">
                <code class="px-1.5 py-0.5 bg-bg-elevated text-text-muted font-mono">
                  {status().headRef}
                </code>
                <button
                  type="button"
                  onClick={() => copy(status().headRef)}
                  class="p-0.5 text-text-faint hover:text-text transition-colors"
                  title={copied() ? "Copied!" : "Copy branch name"}
                >
                  <Show when={copied()} fallback={<CopyIcon size={14} />}>
                    <CheckIcon size={14} class="text-success" />
                  </Show>
                </button>
              </div>

              {/* CI Checks */}
              <ChecksIndicator checks={status().checks} />

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

              {/* Description toggle */}
              <Show when={hasDescription()}>
                <button
                  type="button"
                  onClick={() => setShowDescription(!showDescription())}
                  class={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors ${
                    showDescription()
                      ? "text-text bg-bg-elevated"
                      : "text-text-faint hover:text-text hover:bg-bg-elevated/50"
                  }`}
                  title={showDescription() ? "Hide description" : "Show description"}
                >
                  <span
                    class={`transform transition-transform duration-150 ${showDescription() ? "rotate-180" : ""}`}
                  >
                    <ChevronDownIcon size={12} />
                  </span>
                  <span>Description</span>
                </button>
              </Show>
            </div>

            {/* Description panel - positioned absolutely to overlay without pushing controls */}
            <Show when={showDescription() && hasDescription()}>
              {/* Backdrop for click-outside-to-close */}
              <div class="fixed inset-0 z-40" onClick={() => setShowDescription(false)} />
              {/* Panel */}
              <div
                class="absolute left-0 top-full mt-2 z-50 bg-bg-elevated border border-border shadow-xl rounded overflow-hidden"
                style={{
                  width: "min(600px, calc(100vw - 32px))",
                  "max-height": "min(400px, 50vh)",
                }}
              >
                <div class="flex items-center justify-between px-4 py-2 border-b border-border bg-bg sticky top-0">
                  <div class="flex items-center gap-2">
                    <span class="text-xs text-text-faint font-medium uppercase tracking-wide">
                      PR Description
                    </span>
                    <Show when={prNumber()}>
                      <span class="text-xs text-text-faint/60">#{prNumber()}</span>
                    </Show>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowDescription(false)}
                    class="flex items-center gap-1.5 px-2 py-1 text-xs text-text-faint hover:text-text hover:bg-bg-elevated rounded transition-colors"
                    title="Close (Esc)"
                  >
                    <span class="hidden sm:inline">Close</span>
                    <CloseIcon size={14} />
                  </button>
                </div>
                <div
                  class="text-sm text-text-muted p-4 leading-relaxed overflow-y-auto markdown-content"
                  style={{ "max-height": "calc(min(400px, 50vh) - 48px)" }}
                  innerHTML={parseMarkdown(status().body, githubContext())}
                />
              </div>
            </Show>
          </div>
        );
      }}
    </Show>
  );
};
