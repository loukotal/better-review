import assert from "node:assert/strict";
import { test } from "node:test";

import { searchModels, setSelectedModel } from "./model-selection";

test("includes current Codex models in catalog searches", () => {
  const gpt56Models = searchModels("gpt-5.6").models;
  const gpt6Models = searchModels("gpt-6").models;

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
});

test("rejects OpenAI models that cannot be routed without an OpenAI API key", () => {
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    assert.throws(
      () => setSelectedModel({ providerId: "openai", modelId: "gpt-5.5-pro" }),
      /requires OPENAI_API_KEY/,
    );
  } finally {
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
  }
});
