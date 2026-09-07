export function reviewFreshness(reviewedHead?: string, currentHead?: string) {
  if (!reviewedHead || !currentHead) {
    return {
      className: "text-text-muted",
      title: "View completed review. Revision freshness is unknown because a head SHA is missing.",
    };
  }
  return reviewedHead === currentHead
    ? { className: "text-success", title: "View review of the current PR revision." }
    : {
        className: "text-warning",
        title: "View review of an older PR revision. Re-review to review the latest changes.",
      };
}
