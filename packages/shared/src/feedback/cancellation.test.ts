import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReviewSessionResult } from "../types/session";
import { exportReviewFeedback, formatReviewFeedbackForAgent } from "./index";

test("cancelled reviews return no-verdict feedback for every review mode", () => {
  for (const mode of ["plan", "message", "diff"] as const) {
    const result: ReviewSessionResult = {
      sessionId: "closed",
      mode,
      approved: false,
      cancelled: true,
      feedback: "Review tab closed.",
      annotations: [],
      submittedAt: 1000,
    };
    assert.equal(exportReviewFeedback(result), "Review tab closed.");
    const message = formatReviewFeedbackForAgent({ mode, title: "Review" }, result);
    assert.match(message, /NO VERDICT/);
    assert.match(message, /Ask the user/);
    assert.doesNotMatch(message, /MUST revise|Please address/);
  }
});
