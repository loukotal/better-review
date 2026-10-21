import type { ReviewModelIntent } from "@better-review/shared";

import { trpc } from "./trpc";

export const MODEL_STORAGE_KEY = "better-review:selected-model";
const efforts = ["off", "minimal", "low", "medium", "high", "xhigh"];
export interface ModelEntry {
  providerId: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: ReviewModelIntent["thinkingLevel"][];
  variants: string[];
  releaseDate: string;
}
export interface SelectedModel extends ModelEntry, ReviewModelIntent {}

function loadSavedModel(): ReviewModelIntent | null {
  const stored = localStorage.getItem(MODEL_STORAGE_KEY);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    if (typeof parsed?.providerId !== "string" || typeof parsed?.modelId !== "string")
      throw new Error("Invalid selection");
    return {
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      variant: typeof parsed.variant === "string" ? parsed.variant : null,
      thinkingLevel: efforts.includes(parsed.thinkingLevel) ? parsed.thinkingLevel : "medium",
    };
  } catch (cause) {
    throw new Error("Saved browser model is invalid. Choose a review model.", { cause });
  }
}

/** Backend persistence is authoritative. Cache failure must never invalidate its acknowledgment. */
export function cacheReviewModel(model: ReviewModelIntent) {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(modelIntent(model)));
  } catch {
    // Private browsing/quota failures do not change the model saved by the server.
  }
}

export function modelIntent(model: ReviewModelIntent): ReviewModelIntent {
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    variant: model.variant,
    thinkingLevel: model.thinkingLevel,
  };
}

/** Shared by chat settings and list launch: await migration before any prompt can be admitted. */
export async function resolveReviewModelSelection(): Promise<SelectedModel> {
  const data = await trpc.models.current.query();
  const saved = data.selectionSource === "default" ? loadSavedModel() : null;
  if (saved) {
    const { model } = await trpc.models.restoreCurrent.mutate(saved);
    cacheReviewModel(model);
    return model;
  }
  if (data.selectionSource === "saved") cacheReviewModel(data);
  return data;
}
