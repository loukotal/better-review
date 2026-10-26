import assert from "node:assert/strict";
import { test } from "node:test";

import { searchModels } from "./model-selection";

test("includes current Codex models in catalog searches", () => {
  const gpt56Models = searchModels("gpt-5.6").models;
  const gpt6Models = searchModels("gpt-6").models;
  const gpt61Models = searchModels("gpt-6.1-sol").models;

  assert.ok(
    gpt56Models.some(
      (model) => model.providerId === "openai-codex" && model.modelId === "gpt-5.6-sol",
    ),
  );
  assert.ok(
    gpt6Models.some(
      (model) => model.providerId === "openai-codex" && model.modelId === "gpt-6-astra",
    ),
  );
  assert.ok(
    gpt61Models.some(
      (model) => model.providerId === "openai-codex" && model.modelId === "gpt-6.1-sol",
    ),
  );
});
