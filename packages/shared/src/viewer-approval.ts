/** Shared policy for both latestReviews status and the complete detail review history.
 * Callers supply the latest viewer review, never filter by head or state first.
 */
export function viewerApprovalForReview(input: {
  login: string;
  headSha: string;
  latest?: { state: string; commitSha: string | null };
  requests?: { complete: boolean; items: readonly { kind: string; name: string }[] };
}) {
  const { login, headSha, latest, requests } = input;
  return requests?.complete &&
    requests.items.every((item) => item.kind === "user" && !!item.name && item.name !== login) &&
    latest?.state === "APPROVED" &&
    latest.commitSha === headSha
    ? { login, commitSha: headSha }
    : null;
}
