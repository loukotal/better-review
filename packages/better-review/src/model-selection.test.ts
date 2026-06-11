import assert from "node:assert/strict";
import { test } from "node:test";

import { setSelectedModel } from "./model-selection";

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
