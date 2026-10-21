import { createHash } from "node:crypto";

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { defineDocFamily, type ModelRef } from "@earendil-works/pi-durable";

import type { PrReviewSession } from "../pr-review-sessions";

/** Latest-only, so compaction/reset cannot erase a request's immutable admission claim. */
export const AdmissionIntentDoc = defineDocFamily<{ fingerprint: string }, null>({
  kind: "review.admission-intent",
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ fingerprint: "" }),
});

export class ReviewAdmissionConflict extends Error {
  readonly code = "REVIEW_REQUEST_CONFLICT";
  constructor(readonly reason: "intent_changed" | "legacy_unverifiable") {
    super(
      reason === "legacy_unverifiable"
        ? "This legacy request has no verifiable admission intent. Inspect the existing review before creating a new request."
        : "This request ID is already bound to a different review intent. Inspect the existing review before creating a new request.",
    );
    this.name = "ReviewAdmissionConflict";
  }
}

/** Excludes receipts, timestamps, and access-check bookkeeping, which do not alter review input. */
export function admissionFingerprint(
  body: string,
  model: ModelRef,
  thinkingLevel: ModelThinkingLevel,
  session: PrReviewSession,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        body,
        model: { provider: model.provider, modelId: model.modelId },
        thinkingLevel,
        context: {
          id: session.id,
          prUrl: session.prUrl,
          owner: session.owner,
          repo: session.repo,
          number: session.number,
          headSha: session.headSha,
          baseSha: session.baseSha,
          reviewMode: session.reviewMode,
          commitSha: session.commitSha ?? null,
          worktreePath: session.worktreePath,
          baseRef: session.baseRef ?? null,
          headRef: session.headRef ?? null,
          files: session.files,
          revisionHistory: (session.revisionHistory ?? []).map(
            ({ headSha, baseSha, commitSha }) => ({
              headSha,
              baseSha,
              commitSha: commitSha ?? null,
            }),
          ),
        },
      }),
    )
    .digest("hex");
}
