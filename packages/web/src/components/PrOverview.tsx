import { createSignal, For, Show } from "solid-js";

import type { PrDetail } from "@better-review/shared";

import { Button } from "../design-system";
import type { projectGithubComments } from "../lib/github-comment-views";
import {
  githubCommentLocation,
  githubThreadForComment,
  githubReviewThreadRoot,
  groupGithubReviewComments,
} from "../lib/github-comment-views";
import type { BrowserGithubOperation } from "../lib/github-outbox";
import { githubPrScope } from "../lib/github-writes";
import { parseMarkdown } from "../lib/markdown";
import type { PrExtrasData } from "../lib/query";
import { GithubCommentCard } from "./GithubCommentCard";
import { GithubSyncStatus, githubSyncState } from "./GithubSyncStatus";
import { ReviewDecisionBadge } from "./ReviewDecisionBadge";

export type PrDiscussionLocation = NonNullable<ReturnType<typeof githubCommentLocation>> & {
  /** GitHub's review head. LEFT coordinates still require its immutable comparison revision. */
  sourceRef?: string;
  historical: boolean;
};

export function PrOverview(props: {
  detail?: PrDetail;
  githubView?: ReturnType<typeof projectGithubComments>;
  operations: BrowserGithubOperation[];
  url: string;
  onSource: (location: PrDiscussionLocation) => void;
  discussionsState: "loading" | "available" | "unavailable";
  threadEvidence?: PrExtrasData["reviewThreads"];
}) {
  const [unresolved, setUnresolved] = createSignal(false);
  const githubContext = () => ({
    owner: githubPrScope(props.url).owner,
    repo: githubPrScope(props.url).repo,
  });
  const metadata = () =>
    props.detail?.metadata.status === "available" ? props.detail.metadata.data : undefined;
  const reviewComments = () =>
    props.githubView?.comments.filter((comment) => {
      if (comment.ref.kind !== "review-comment" || comment.deleted) return false;
      const thread = githubThreadForComment(
        comment,
        props.githubView?.threads ?? [],
        props.operations,
        props.githubView?.comments,
      );
      return !unresolved() || resolution(comment, thread) === false;
    }) ?? [];
  function resolution(
    comment: NonNullable<typeof props.githubView>["comments"][number],
    thread = githubThreadForComment(
      comment,
      props.githubView?.threads ?? [],
      props.operations,
      props.githubView?.comments,
    ),
  ) {
    const raw = githubReviewThreadRoot(
      comment,
      props.githubView?.comments ?? [],
      props.operations,
    ).raw;
    const known =
      typeof raw === "object" &&
      raw !== null &&
      "isResolved" in raw &&
      typeof raw.isResolved === "boolean";
    return thread && (known || thread.pending || thread.operationIds.length)
      ? thread.resolved
      : undefined;
  }
  const requirementsSection = () =>
    props.detail?.mergeCapabilities.status === "available"
      ? props.detail.mergeCapabilities.data.branchRequirements
      : undefined;
  const requirements = () => {
    const section = requirementsSection();
    return section?.status === "available" ? section.data : undefined;
  };
  const requirementsIncomplete = () => {
    const section = requirementsSection();
    return section?.status === "available" && !section.complete;
  };
  return (
    <div class="space-y-5" data-pr-overview>
      <Show
        when={metadata()}
        fallback={
          <p role="status">
            {props.detail?.metadata.status === "unavailable"
              ? props.detail.metadata.message
              : "Loading pull request…"}
          </p>
        }
      >
        {(pr) => (
          <>
            <div>
              <h1 class="text-2xl font-semibold">
                {pr().title} <span class="text-text-muted">#{pr().number}</span>
              </h1>
              <p class="mt-2 text-sm text-text-muted">
                {pr().draft ? "Draft" : pr().state.toLowerCase()} ·{" "}
                {pr().author ?? "Unknown author"} wants to merge <code>{pr().head.name}</code> into{" "}
                <code>{pr().base.name}</code>
              </p>
              <Show when={pr().mergedAt}>
                <p>
                  Merged {pr().mergedAt} by {pr().mergedBy ?? "unknown"}
                </p>
              </Show>
            </div>
            <article
              aria-label="Pull request description"
              class="prose prose-invert max-w-none border border-border p-4"
              innerHTML={parseMarkdown(pr().body || "No description provided.", githubContext())}
            />
          </>
        )}
      </Show>
      <section aria-label="Labels">
        <h2 class="font-semibold">Labels</h2>
        <Show when={props.detail?.labels.status === "available" && !props.detail.labels.complete}>
          <p class="text-warning">Labels are incomplete.</p>
        </Show>
        <Show
          when={props.detail?.labels.status === "available"}
          fallback={<p class="text-text-muted">Labels unavailable</p>}
        >
          <For
            each={props.detail?.labels.status === "available" ? props.detail.labels.data : []}
            fallback={<span class="text-text-muted">No labels</span>}
          >
            {(label) => (
              <span
                class="mr-2 inline-block rounded border border-border px-2 py-1 text-xs"
                title={label.description ?? undefined}
              >
                {label.name}
              </span>
            )}
          </For>
        </Show>
      </section>
      <section aria-label="Review requirements" class="space-y-2">
        <h2 class="font-semibold">Reviews</h2>
        <Show
          when={
            props.detail?.reviewRequests.status === "available" &&
            !props.detail.reviewRequests.complete
          }
        >
          <p class="text-warning">Requested reviewers are incomplete.</p>
        </Show>
        <p>
          GitHub decision:{" "}
          {props.detail?.mergeCapabilities.status === "available"
            ? (props.detail.mergeCapabilities.data.reviewDecision ?? "Unknown")
            : "Unavailable"}
        </p>
        <ReviewDecisionBadge
          decision={
            props.detail?.mergeCapabilities.status === "available" &&
            props.detail.mergeCapabilities.data.reviewDecision === "APPROVED"
              ? "APPROVED"
              : undefined
          }
        />
        <Show
          when={props.detail?.reviewRequests.status === "available"}
          fallback={<p>Requested reviewers unavailable</p>}
        >
          <For
            each={
              props.detail?.reviewRequests.status === "available"
                ? props.detail.reviewRequests.data
                : []
            }
            fallback={<p class="text-text-muted">No requested reviewers</p>}
          >
            {(request) => (
              <p>
                {request.kind === "team" ? "Team " : ""}
                {request.name} · review requested
              </p>
            )}
          </For>
        </Show>
        <Show
          when={
            props.detail?.mergeCapabilities.status === "available" &&
            props.detail.mergeCapabilities.data.branchRequirements.status === "available"
          }
          fallback={<p class="text-text-muted">Branch review requirements unavailable</p>}
        >
          <Show when={requirementsIncomplete()}>
            <p class="text-warning">
              Branch requirements are incomplete. Do not assume all merge rules are listed.
            </p>
          </Show>
          <Show when={requirements()} fallback={<p>No branch protection requirements reported.</p>}>
            {(value) => (
              <ul class="text-sm text-text-muted">
                <li>
                  Approving reviews:{" "}
                  {value().requiresApprovingReviews ? "Required" : "Not required"}
                  {value().requiredApprovingReviewCount !== undefined
                    ? ` (${value().requiredApprovingReviewCount})`
                    : ""}
                </li>
                <li>
                  Code owner reviews:{" "}
                  {value().requiresCodeOwnerReviews ? "Required" : "Not required"}
                </li>
                <li>
                  Resolved conversations:{" "}
                  {value().requiresConversationResolution ? "Required" : "Not required"}
                </li>
                <li>
                  Required checks:{" "}
                  {value().requiredStatusCheckContexts.join(", ") || "None reported"}
                </li>
                <Show when={value().unsupportedRules?.length}>
                  <li>
                    Additional rules require GitHub evaluation:{" "}
                    {value().unsupportedRules?.join(", ")}
                  </li>
                </Show>
              </ul>
            )}
          </Show>
        </Show>
      </section>
      <section aria-label="Review events" class="space-y-2">
        <h2 class="font-semibold">Review activity</h2>
        <Show when={props.detail?.reviews.status === "available" && !props.detail.reviews.complete}>
          <p class="text-warning">Review activity is incomplete.</p>
        </Show>
        <For
          each={
            props.githubView?.reviews.filter(
              (review) =>
                review.pending ||
                !(
                  props.detail?.reviews.status === "available" &&
                  props.detail.reviews.data.some((remote) => remote.url === review.url)
                ),
            ) ?? []
          }
        >
          {(review) => (
            <article class="border border-border p-3">
              <div class="flex items-center gap-2">
                <Show when={review.pending}>
                  <GithubSyncStatus
                    iconOnly
                    status={
                      githubSyncState(
                        props.operations.filter((item) =>
                          review.operationIds.includes(item.command.operationId),
                        ),
                      ) ?? "queued"
                    }
                  />
                </Show>
                <span>
                  {review.author?.login ?? "You"} ·{" "}
                  {review.pending
                    ? `${review.state === "CHANGES_REQUESTED" ? "Request changes" : "Comment review"} pending`
                    : review.state.toLowerCase().replaceAll("_", " ")}
                </span>
              </div>
              <div
                class="prose prose-invert max-w-none"
                innerHTML={parseMarkdown(review.body, githubContext())}
              />
            </article>
          )}
        </For>
        <Show
          when={props.detail?.reviews.status === "available"}
          fallback={<p>Review activity unavailable</p>}
        >
          <For
            each={props.detail?.reviews.status === "available" ? props.detail.reviews.data : []}
            fallback={<p class="text-text-muted">No reviews yet</p>}
          >
            {(review) => (
              <article class="border border-border p-3">
                <a href={review.url} target="_blank" rel="noopener noreferrer" class="text-accent">
                  {review.author ?? "Unknown"} · {review.state.toLowerCase().replaceAll("_", " ")}
                </a>
                <span class="ml-2 text-xs text-text-muted">{review.submittedAt}</span>
                <div
                  class="prose prose-invert max-w-none"
                  innerHTML={parseMarkdown(review.body, githubContext())}
                />
              </article>
            )}
          </For>
        </Show>
      </section>
      <section aria-label="Review discussions" class="space-y-3">
        <Show when={props.threadEvidence?.status === "unavailable"}>
          <p role="alert" class="text-text-muted">
            {props.threadEvidence?.status === "unavailable" ? props.threadEvidence.message : ""}
          </p>
        </Show>
        <Show when={props.threadEvidence?.status === "available" && !props.threadEvidence.complete}>
          <p class="text-warning">
            Review thread metadata is incomplete. Missing resolution status is unknown.
          </p>
        </Show>
        <div class="flex items-center gap-3">
          <h2 class="font-semibold">Review discussions</h2>
          <Button size="xs" aria-pressed={!unresolved()} onClick={() => setUnresolved(false)}>
            All
          </Button>
          <Button size="xs" aria-pressed={unresolved()} onClick={() => setUnresolved(true)}>
            Unresolved
          </Button>
        </div>
        <Show when={props.discussionsState !== "available"}>
          <p role="status">
            {props.discussionsState === "loading"
              ? "Loading discussions…"
              : "GitHub review discussions unavailable. Displayed comments may be cached."}
          </p>
        </Show>
        <Show when={unresolved()}>
          <p class="text-xs text-text-muted">
            Only known unresolved discussions are included. Unknown resolution status is not treated
            as resolved.
          </p>
        </Show>
        <For
          each={groupGithubReviewComments(reviewComments(), props.operations).map(
            (group) => group.root.key,
          )}
          fallback={
            <Show when={props.discussionsState === "available"}>
              <p class="text-text-muted">
                No {unresolved() ? "known unresolved " : ""}review comments.
              </p>
            </Show>
          }
        >
          {(rootKey) => (
            <div data-github-review-thread={rootKey} class="space-y-2">
              <For
                each={groupGithubReviewComments(reviewComments(), props.operations)
                  .find((group) => group.root.key === rootKey)
                  ?.comments.map((comment) => comment.key)}
              >
                {(key) => {
                  const comment = () => reviewComments().find((entry) => entry.key === key)!;
                  const location = () =>
                    githubCommentLocation(comment(), props.operations, props.githubView?.comments);
                  const source = (): PrDiscussionLocation | undefined => {
                    const target = location();
                    if (!target) return;
                    const raw = comment().raw;
                    const record =
                      typeof raw === "object" && raw !== null
                        ? (raw as Record<string, unknown>)
                        : undefined;
                    const historical = record?.line === null;
                    const sha = historical ? record?.original_commit_id : record?.commit_id;
                    const confirmed = comment().confirmed;
                    return {
                      ...target,
                      historical,
                      sourceRef:
                        typeof sha === "string"
                          ? sha
                          : confirmed?.kind === "review-comment"
                            ? confirmed.location.commitSha
                            : target.expectedHeadSha,
                    };
                  };
                  return (
                    <div class="space-y-1">
                      <Show when={resolution(comment()) === undefined}>
                        <p class="text-xs text-text-muted">Thread resolution unknown</p>
                      </Show>
                      <Show when={source()}>
                        {(target) => (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => props.onSource(target())}
                          >
                            {target().path}:{target().line} · {target().side} ·{" "}
                            {target().sourceRef?.slice(0, 7) ?? "revision unavailable"}
                            {target().historical ? " (original location)" : ""}
                          </Button>
                        )}
                      </Show>
                      <GithubCommentCard
                        comment={comment()}
                        scope={githubPrScope(props.url)}
                        operations={props.operations}
                        thread={githubThreadForComment(
                          comment(),
                          props.githubView?.threads ?? [],
                          props.operations,
                          props.githubView?.comments,
                        )}
                      />
                    </div>
                  );
                }}
              </For>
            </div>
          )}
        </For>
      </section>
    </div>
  );
}
