import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildReviewPrompt,
  STE100_REVIEW_INSTRUCTION,
  STRUCTURED_REVIEW_PROMPT,
} from "./review-prompts";

test("buildReviewPrompt leaves the review prompt unchanged when STE100 is off", () => {
  assert.equal(buildReviewPrompt(STRUCTURED_REVIEW_PROMPT, false), STRUCTURED_REVIEW_PROMPT);
});

test("buildReviewPrompt appends the STE100 instruction when STE100 is on", () => {
  assert.equal(
    buildReviewPrompt(STRUCTURED_REVIEW_PROMPT, true),
    `${STRUCTURED_REVIEW_PROMPT}\n\n${STE100_REVIEW_INSTRUCTION}`,
  );
});
