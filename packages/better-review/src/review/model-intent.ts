import { z } from "zod";

import type { ReviewModelIntent } from "@better-review/shared";

import { REASONING_EFFORTS, type ResolvedReviewModel } from "../model-resolution";
import { resolveSelectedModel } from "../model-selection";

export const reviewModelIntentSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  variant: z.string().nullable(),
  thinkingLevel: z.enum(REASONING_EFFORTS),
});

export function resolveReviewModelIntent(intent: ReviewModelIntent): ResolvedReviewModel {
  const selected = resolveSelectedModel(reviewModelIntentSchema.parse(intent));
  return {
    model: { provider: selected.providerId, modelId: selected.modelId },
    thinkingLevel: selected.thinkingLevel,
  };
}
