import type { ReviewSessionDiffVariant } from "@better-review/shared";

export function getVariantCommits(variant: ReviewSessionDiffVariant | null | undefined) {
  return variant?.commits ?? (variant?.commit ? [variant.commit] : []);
}
