import type { GithubWriteAction } from "@better-review/shared";

const labels: Record<Exclude<GithubWriteAction["kind"], "set-draft">, string> = {
  approve: "Approve",
  "request-changes": "Request changes",
  "review-comment": "Review comment",
  "issue-comment": "Comment",
  "inline-comment": "Inline comment",
  reply: "Reply",
  "edit-comment": "Edit comment",
  "delete-comment": "Delete comment",
  "resolve-thread": "Resolve thread",
  "unresolve-thread": "Reopen thread",
};

export function githubActionLabel(action: GithubWriteAction): string {
  return action.kind === "set-draft"
    ? action.draft
      ? "Convert to draft"
      : "Ready for review"
    : labels[action.kind];
}
