import assert from "node:assert/strict";
import { test } from "node:test";

import { searchModels, setSelectedModel } from "./model-selection";

test("includes GPT-5.6 models in catalog searches", () => {
  const { models } = searchModels("gpt-5.6");

  assert.ok(
    models.some((model) => model.providerId === "openai-codex" && model.modelId === "gpt-5.6-sol"),
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
