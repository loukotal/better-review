import { Show } from "solid-js";

import type { SearchedPr } from "@better-review/shared";

import { Badge } from "../design-system";
import type { PrListLayout } from "../lib/pr-list-layout";
import { ReviewDecisionBadge } from "./ReviewDecisionBadge";

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const diffMs = Date.now() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function ReviewBadges(props: { pr: SearchedPr }) {
  return (
    <>
      <Show when={props.pr.isDraft}>
        <Badge variant="neutral">Draft</Badge>
      </Show>
      <ReviewDecisionBadge decision={props.pr.reviewDecision} />
      <Show when={props.pr.myReviewState === "CHANGES_REQUESTED"}>
        <Badge variant="danger">Changes requested</Badge>
      </Show>
    </>
  );
}

function ChangeCounts(props: { pr: SearchedPr; class?: string }) {
  return (
    <span
      class={`inline-flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums ${props.class ?? ""}`}
      title={`${props.pr.additions} added, ${props.pr.deletions} removed`}
      aria-label={`${props.pr.additions} lines added, ${props.pr.deletions} lines removed`}
    >
      <span class="text-success">+{props.pr.additions}</span>
      <span class="text-error">−{props.pr.deletions}</span>
    </span>
  );
}

/** Layout changes only presentation; the parent retains PR links, filters, and review actions. */
export function PrListSummary(props: { pr: SearchedPr; layout: PrListLayout }) {
  const repo = () => `${props.pr.repository.nameWithOwner}#${props.pr.number}`;
  return (
    <Show
      when={props.layout === "table"}
      fallback={
        <div class="min-w-0 space-y-1 px-2 py-2" data-pr-summary-layout="title-first">
          <span class="block break-words text-sm font-medium leading-5 text-text group-hover:text-accent">
            {props.pr.title}
          </span>
          <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
            <span class="max-w-full truncate font-mono">{repo()}</span>
            <ReviewBadges pr={props.pr} />
            <span class="max-w-full truncate">@{props.pr.author.login}</span>
            <span class="shrink-0 text-text-faint">{formatRelativeTime(props.pr.createdAt)}</span>
            <ChangeCounts pr={props.pr} class="sm:ml-auto" />
          </div>
        </div>
      }
    >
      <div class="flex min-w-0 items-center gap-3 px-2 py-2" data-pr-summary-layout="table">
        <span
          class="hidden w-32 shrink-0 truncate font-mono text-xs text-text-muted sm:block lg:w-56"
          title={repo()}
        >
          {repo()}
        </span>
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1 sm:flex-nowrap sm:gap-2">
          <span class="w-full truncate font-mono text-xs text-text-muted sm:hidden">{repo()}</span>
          <span
            class="min-w-0 flex-1 truncate text-sm text-text group-hover:text-accent"
            title={props.pr.title}
          >
            {props.pr.title}
          </span>
          <ReviewBadges pr={props.pr} />
        </div>
        <span
          class="hidden w-28 shrink-0 truncate text-xs text-text-muted lg:block"
          title={`@${props.pr.author.login}`}
        >
          @{props.pr.author.login}
        </span>
        <ChangeCounts pr={props.pr} class="w-20 justify-end" />
        <span class="hidden w-16 shrink-0 text-right text-xs text-text-faint lg:block">
          {formatRelativeTime(props.pr.createdAt)}
        </span>
      </div>
    </Show>
  );
}
