import assert from "node:assert/strict";
import test from "node:test";

import { createModelResolution, type ModelEntry, type ReasoningEffort } from "./model-resolution";

function entry(
  providerId: string,
  thinkingLevels: ReasoningEffort[] = ["off", "low", "medium", "high"],
  modelId = "review",
): ModelEntry {
  return {
    providerId,
    modelId,
    name: modelId,
    reasoning: true,
    thinkingLevels,
    variants: [],
    releaseDate: "",
  };
}
function fixture(
  facts: {
    key?: boolean;
    oauth?: boolean;
    codex?: boolean;
    opencode?: boolean;
    openai?: boolean;
    matching?: boolean;
  } = {},
) {
  const catalog = new Map<string, ModelEntry>();
  for (const provider of ["openai", "opencode", "other", "vercel-ai-gateway", "zai"])
    catalog.set(`${provider}/review`, entry(provider));
  if (facts.matching !== false) catalog.set("openai-codex/review", entry("openai-codex", ["low"]));
  let currentThinking: ReasoningEffort | undefined;
  const credentials: string[] = [];
  const resolution = createModelResolution({
    catalog: { get: (provider, model) => catalog.get(`${provider}/${model}`) ?? null },
    credentials: {
      available: (provider) => {
        credentials.push(`available:${provider}`);
        if (provider === "openai") return !!(facts.key || facts.openai);
        return provider === "opencode" ? !!facts.opencode : !!facts.codex;
      },
    },
    currentThinking: () => currentThinking,
  });
  const selected = (provider: string) => ({
    ...catalog.get(`${provider}/review`)!,
    variant: "selected-variant",
    thinkingLevel: "high" as const,
  });
  return {
    resolution,
    catalog,
    credentials,
    selected,
    thinking: (value: ReasoningEffort | undefined) => {
      currentThinking = value;
    },
  };
}

for (const row of [
  { label: "API key", facts: { key: true }, explicit: "openai", current: "openai" },
  {
    label: "API key wins over OAuth",
    facts: { key: true, oauth: true, codex: true },
    explicit: "openai",
    current: "openai",
  },
  {
    label: "OpenAI ChatGPT OAuth wins over legacy Codex",
    facts: { openai: true, oauth: true, codex: true },
    explicit: "openai",
    current: "openai",
  },
  {
    label: "environment-only Codex never replaces OpenAI",
    facts: { codex: true },
    explicit: null,
    current: "openai",
  },
  { label: "no credentials", facts: {}, explicit: null, current: "openai" },
  {
    label: "legacy OAuth never replaces OpenAI",
    facts: { oauth: true, codex: true },
    explicit: null,
    current: "openai",
  },
  {
    label: "OpenAI stored API key or OAuth without legacy credentials",
    facts: { openai: true },
    explicit: "openai",
    current: "openai",
  },
  {
    label: "OAuth without matching model",
    facts: { oauth: true, codex: true, matching: false },
    explicit: null,
    current: "openai",
  },
  {
    label: "environment-only without matching model",
    facts: { codex: true, matching: false },
    explicit: null,
    current: "openai",
  },
]) {
  test(`OpenAI resolution policies: ${row.label}`, () => {
    const f = fixture(row.facts);
    const input = { providerId: "openai", modelId: "review", thinkingLevel: "high" as const };
    if (row.explicit) {
      const selected = f.resolution.explicit(input);
      assert.equal(selected.providerId, row.explicit);
      assert.equal(selected.thinkingLevel, row.explicit === "openai-codex" ? "low" : "high");
    } else
      assert.throws(() => f.resolution.explicit(input), {
        message:
          "Model openai/review requires OpenAI credentials. Sign in with ChatGPT via /login openai or set OPENAI_API_KEY.",
      });
    const selected = f.selected("openai");
    assert.deepEqual(f.resolution.current(selected), {
      model: { provider: row.current, modelId: "review" },
      thinkingLevel: "high",
    });
    assert.equal(
      selected.providerId,
      "openai",
      "effective routing never rewrites the selected preference",
    );
    assert.equal(selected.variant, "selected-variant");
  });
}

for (const row of [
  { label: "own credentials", facts: { opencode: true }, expected: "opencode" },
  {
    label: "own credentials win",
    facts: { opencode: true, oauth: true, codex: true },
    expected: "opencode",
  },
  { label: "OAuth Codex", facts: { oauth: true, codex: true }, expected: "openai-codex" },
  { label: "environment-only Codex", facts: { codex: true }, expected: "openai-codex" },
  { label: "no credentials", facts: {}, expected: null },
  { label: "missing fallback model", facts: { codex: true, matching: false }, expected: null },
]) {
  test(`OpenCode resolution policies: ${row.label}`, () => {
    const f = fixture(row.facts);
    if (row.expected)
      assert.equal(
        f.resolution.explicit({ providerId: "opencode", modelId: "review" }).providerId,
        row.expected,
      );
    else
      assert.throws(() => f.resolution.explicit({ providerId: "opencode", modelId: "review" }), {
        message:
          "Model opencode/review requires OPENCODE_API_KEY. Select an authenticated provider or set OPENCODE_API_KEY.",
      });
    assert.deepEqual(f.resolution.current(f.selected("opencode")), {
      model: { provider: row.expected ?? "opencode", modelId: "review" },
      thinkingLevel: "high",
    });
  });
}

test("explicit aliases, missing-model wording, and variants retain compatibility without credential checks for unrelated providers", () => {
  const f = fixture();
  for (const [alias, provider] of [
    ["vercel", "vercel-ai-gateway"],
    ["zai-coding-plan", "zai"],
  ]) {
    assert.equal(
      f.resolution.explicit({ providerId: alias, modelId: "review" }).providerId,
      provider,
    );
    assert.throws(() => f.resolution.explicit({ providerId: alias, modelId: "removed" }), {
      message: `Model not found: ${alias}/removed`,
    });
  }
  for (const variant of [undefined, null, "", "named", " "]) {
    assert.equal(
      f.resolution.explicit({ providerId: "other", modelId: "review", variant }).variant,
      variant === "named" || variant === " " ? variant : null,
    );
  }
  assert.deepEqual(f.credentials, [], "unrelated providers get no new authentication validation");
});

for (const row of [
  { levels: ["off", "medium", "high"], requested: "medium", expected: "medium" },
  { levels: ["low", "high"], requested: "medium", expected: "high" },
  { levels: ["medium", "high"], requested: "minimal", expected: "medium" },
  { levels: ["low"], requested: "xhigh", expected: "low" },
  { levels: ["off"], requested: "medium", expected: "off" },
  { levels: [], requested: "medium", expected: "off" },
  { levels: ["medium"], requested: "off", expected: "medium" },
] satisfies {
  levels: ReasoningEffort[];
  requested: ReasoningEffort;
  expected: ReasoningEffort;
}[]) {
  test(`explicit thinking ${row.requested} with [${row.levels}] resolves to ${row.expected}`, () => {
    const f = fixture();
    f.catalog.set("other/review", entry("other", row.levels));
    assert.equal(
      f.resolution.explicit({
        providerId: "other",
        modelId: "review",
        thinkingLevel: row.requested,
      }).thinkingLevel,
      row.expected,
    );
  });
}

test("omitted explicit thinking inherits only current in-memory intent, then medium", () => {
  const f = fixture();
  assert.equal(
    f.resolution.explicit({ providerId: "other", modelId: "review" }).thinkingLevel,
    "medium",
  );
  f.thinking("high");
  assert.equal(
    f.resolution.explicit({ providerId: "other", modelId: "review", thinkingLevel: null })
      .thinkingLevel,
    "high",
  );
  assert.equal(
    f.resolution.explicit({ providerId: "other", modelId: "review", thinkingLevel: "low" })
      .thinkingLevel,
    "low",
  );
  f.thinking(undefined);
  assert.equal(
    f.resolution.explicit({ providerId: "other", modelId: "review" }).thinkingLevel,
    "medium",
  );
});
