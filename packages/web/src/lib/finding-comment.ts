import type { FileDiffMetadata } from "@pierre/diffs";

import { formatAnnotationForComment } from "../utils/formatAnnotationForClipboard";
import type { Annotation } from "../utils/parseReviewTokens";
import { resolveFileReference } from "./file-reference";

declare const verifiedCommentLocation: unique symbol;

/** Only validation of original finding provenance can produce a comment location. */
export interface VerifiedCommentLocation {
  readonly [verifiedCommentLocation]: true;
  readonly filePath: string;
  readonly line: number;
  readonly side: "RIGHT";
  readonly expectedHeadSha: string;
}

export interface FindingCommentRequest extends VerifiedCommentLocation {
  id: string;
  prUrl: string;
  sessionId: string;
  scope: string;
  body: string;
}

export function prepareFindingComment(
  annotation: Annotation,
  context: {
    prUrl: string;
    sessionId: string;
    scope: string;
    reviewedRef?: string | null;
    displayedHeadSha?: string | null;
    files: FileDiffMetadata[];
    commitScope?: boolean;
  },
) {
  if (context.commitScope)
    throw new Error(
      "Finding comments are unavailable in commit scope. Open the full PR and revalidate the finding against its current head before commenting.",
    );
  if (
    annotation.origin &&
    (annotation.origin.revision !== context.reviewedRef ||
      annotation.origin.sessionId !== context.sessionId)
  )
    throw new Error(
      "The finding's source provenance does not match this request. No comment was opened; revalidate the original finding first.",
    );
  if (!context.reviewedRef || !context.displayedHeadSha)
    throw new Error(
      "The finding's revision is unavailable. No comment was opened; use its filename link to inspect the reviewed source.",
    );
  if (context.reviewedRef !== context.displayedHeadSha)
    throw new Error(
      "This finding is from a historical revision. No current-line comment was opened. Use its filename link to inspect that revision and revalidate the finding first.",
    );
  const filePath = resolveFileReference(
    annotation.file,
    context.files.map((file) => file.name),
  );
  if (!filePath)
    throw new Error(
      "The finding's file path is ambiguous or unsafe. Use a full repository-relative path; existing comment drafts were preserved.",
    );
  if (!Number.isSafeInteger(annotation.line) || annotation.line < 1)
    throw new Error(
      "The finding has no valid source line. Existing comment drafts were preserved.",
    );
  const file = context.files.find((file) => file.name === filePath);
  const inPatch = !!file?.hunks.some(
    (hunk) =>
      annotation.line >= hunk.additionStart &&
      annotation.line < hunk.additionStart + hunk.additionCount,
  );
  // The assertion is confined to the validator, after all provenance/path/line guards.
  const location = {
    filePath,
    line: annotation.line,
    side: "RIGHT",
    expectedHeadSha: context.displayedHeadSha,
  } as VerifiedCommentLocation;
  const request: FindingCommentRequest = {
    ...location,
    id: crypto.randomUUID(),
    prUrl: context.prUrl,
    sessionId: context.sessionId,
    scope: context.scope,
    filePath,
    line: annotation.line,
    side: "RIGHT",
    expectedHeadSha: context.displayedHeadSha,
    body: formatAnnotationForComment({ ...annotation, file: filePath }),
  };
  return { request, inPatch };
}

export function findingCommentKey(
  request: Pick<FindingCommentRequest, "prUrl" | "expectedHeadSha" | "filePath" | "line">,
) {
  return JSON.stringify([request.prUrl, request.expectedHeadSha, request.filePath, request.line]);
}
