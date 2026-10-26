import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("explicit selection survives server restart instead of reverting to the Codex default", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-model-selection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = path.join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify({ "openai-codex": { type: "api", key: "fixture" } }));
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    BETTER_REVIEW_MODEL: "",
    BETTER_REVIEW_PI_AUTH_PATH: authPath,
    BETTER_REVIEW_OPENCODE_AUTH_PATH: path.join(directory, "missing-auth.json"),
    BETTER_REVIEW_MODEL_SELECTION_PATH: path.join(directory, "selection.json"),
  };
  function run(source: string) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { getCurrentReviewModel, getSelectedModel, getModelSelectionState, restoreSelectedModel, resolveSelectedModel, setSelectedModel } from ${JSON.stringify(new URL("./model-selection.ts", import.meta.url).href)}; ${source}`,
      ],
      { env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const selected = run(
    `console.log(JSON.stringify(setSelectedModel({providerId: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high"})))`,
  );
  assert.equal(selected.modelId, "gpt-6.1-sol");
  const restarted = run("console.log(JSON.stringify(getSelectedModel()))");
  assert.equal(restarted.modelId, selected.modelId);
  assert.equal(restarted.providerId, selected.providerId);
  assert.equal(restarted.thinkingLevel, "high");
  assert.deepEqual(
    run(
      `const captured = resolveSelectedModel({providerId: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "medium"}); console.log(JSON.stringify([captured.modelId, getSelectedModel().modelId]));`,
    ),
    ["gpt-5.5", "gpt-6.1-sol"],
    "resolving per-request intent must not mutate the persisted global selection",
  );
  assert.equal(
    run("console.log(JSON.stringify(getModelSelectionState()))").selectionSource,
    "saved",
  );
  assert.equal(
    run(
      `console.log(JSON.stringify(restoreSelectedModel({providerId: "openai-codex", modelId: "gpt-5.5"})))`,
    ).modelId,
    "gpt-6.1-sol",
    "stale browser migration never replaces saved server intent",
  );
  assert.equal(
    run("console.log(JSON.stringify(getCurrentReviewModel()))"),
    "openai-codex/gpt-6.1-sol",
  );
  const saved = await readFile(env.BETTER_REVIEW_MODEL_SELECTION_PATH, "utf8");
  assert.equal(
    saved.includes("fixture"),
    false,
    "only model intent is persisted, never credentials",
  );
  run(
    `try { setSelectedModel({providerId: "openai", modelId: "gpt-5.5-pro"}); throw new Error("accepted"); } catch (error) { if (!error.message.includes("requires OPENAI_API_KEY")) throw error; } console.log(JSON.stringify(getSelectedModel()))`,
  );
  assert.equal(
    await readFile(env.BETTER_REVIEW_MODEL_SELECTION_PATH, "utf8"),
    saved,
    "rejecting an unroutable model must not change persisted selection",
  );
  assert.equal(run("console.log(JSON.stringify(getSelectedModel()))").modelId, "gpt-6.1-sol");

  await writeFile(
    env.BETTER_REVIEW_MODEL_SELECTION_PATH,
    JSON.stringify({ ...selected, modelId: "removed-model" }),
  );
  const unavailable = run(
    `try { getSelectedModel(); throw new Error("silently fell back"); } catch (error) { console.log(JSON.stringify(error.message)); }`,
  );
  assert.match(unavailable, /removed-model.*unavailable.*Select a model/);
  assert.equal(
    JSON.parse(await readFile(env.BETTER_REVIEW_MODEL_SELECTION_PATH, "utf8")).modelId,
    "removed-model",
  );
  run(
    `console.log(JSON.stringify(setSelectedModel({providerId: "openai-codex", modelId: "gpt-6.1-sol"})))`,
  );
  assert.equal(run("console.log(JSON.stringify(getSelectedModel()))").modelId, "gpt-6.1-sol");
  await writeFile(env.BETTER_REVIEW_MODEL_SELECTION_PATH, "{broken");
  assert.match(
    run(
      `try { getSelectedModel(); } catch (error) { console.log(JSON.stringify(error.message)); }`,
    ),
    /invalid.*Select a model/,
  );
  await rm(env.BETTER_REVIEW_MODEL_SELECTION_PATH);
  assert.equal(
    run("console.log(JSON.stringify(getModelSelectionState()))").selectionSource,
    "default",
  );
  assert.equal(
    run("console.log(JSON.stringify(getSelectedModel()))").modelId,
    "gpt-5.5",
    "genuine no-selection defaults remain unchanged",
  );
  env.BETTER_REVIEW_MODEL = "openai-codex/no-longer-in-catalog";
  assert.match(
    run(
      `try { getSelectedModel(); } catch (error) { console.log(JSON.stringify(error.message)); }`,
    ),
    /BETTER_REVIEW_MODEL/,
  );
  env.BETTER_REVIEW_MODEL = "";
  assert.equal(
    run(
      `console.log(JSON.stringify(restoreSelectedModel({providerId: "openai-codex", modelId: "gpt-6.1-sol"})))`,
    ).modelId,
    "gpt-6.1-sol",
  );
  assert.equal(
    run("console.log(JSON.stringify(getModelSelectionState()))").selectionSource,
    "saved",
  );
});

test("selection policy preserves current preference, catalog ordering, wire format and in-memory state on failed atomic rename", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-model-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = path.join(directory, "auth.json");
  const selectionPath = path.join(directory, "selection.json");
  await writeFile(authPath, JSON.stringify({ "openai-codex": { type: "api", key: "fixture" } }));
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    BETTER_REVIEW_MODEL: "",
    BETTER_REVIEW_PI_AUTH_PATH: authPath,
    BETTER_REVIEW_OPENCODE_AUTH_PATH: path.join(directory, "missing-auth.json"),
    BETTER_REVIEW_MODEL_SELECTION_PATH: selectionPath,
  };
  function run(source: string, overrides: Record<string, string> = {}) {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
      import { getSelectedModel, getModelSelectionState, resolveCurrentReviewModel, resolveSelectedModel, setSelectedModel, searchModels } from ${JSON.stringify(new URL("./model-selection.ts", import.meta.url).href)};
      ${source}
    `,
      ],
      { env: { ...env, ...overrides }, encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  }
  const result = run(`
    const preference = getSelectedModel();
    const effective = resolveCurrentReviewModel();
    const search = searchModels('');
    const selected = setSelectedModel({ providerId: 'openai-codex', modelId: 'gpt-6.1-sol', variant: 'named', thinkingLevel: 'high' });
    const wire = JSON.parse(readFileSync(process.env.BETTER_REVIEW_MODEL_SELECTION_PATH, 'utf8'));
    rmSync(process.env.BETTER_REVIEW_MODEL_SELECTION_PATH);
    mkdirSync(process.env.BETTER_REVIEW_MODEL_SELECTION_PATH);
    let failed = false;
    try { setSelectedModel({ providerId: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'low' }); } catch { failed = true; }
    const after = getSelectedModel();
    const inherited = resolveSelectedModel({ providerId: 'openai-codex', modelId: 'gpt-5.5' });
    console.log(JSON.stringify({ preference, effective, connected: search.connectedProvidersCount, firstProvider: search.models[0].providerId, count: search.models.length, wire, failed, after, inherited, source: getModelSelectionState().selectionSource, temporary: readdirSync(${JSON.stringify(directory)}).filter(name => name.endsWith('.tmp')) }));
  `);
  assert.equal(
    result.preference.providerId,
    "openai",
    "the default remains the UI-visible preference",
  );
  assert.equal(
    result.effective.model.provider,
    "openai-codex",
    "execution routes without rewriting preference",
  );
  assert.equal(result.effective.thinkingLevel, result.preference.thinkingLevel);
  assert.equal(result.connected, 1);
  assert.equal(result.firstProvider, "openai-codex");
  assert.equal(result.count, 50);
  assert.deepEqual(result.wire, {
    providerId: "openai-codex",
    modelId: "gpt-6.1-sol",
    variant: "named",
    thinkingLevel: "high",
  });
  assert.equal(result.failed, true);
  assert.equal(result.after.modelId, "gpt-6.1-sol");
  assert.equal(result.after.thinkingLevel, "high");
  assert.equal(
    result.inherited.thinkingLevel,
    "high",
    "failed persistence cannot leak its new thinking into memory",
  );
  assert.equal(result.source, "saved");
  assert.deepEqual(result.temporary, []);
  const noAuth = {
    BETTER_REVIEW_PI_AUTH_PATH: path.join(directory, "missing.json"),
    BETTER_REVIEW_MODEL_SELECTION_PATH: path.join(directory, "fresh-selection.json"),
  };
  assert.equal(
    run("console.log(JSON.stringify(getSelectedModel()))", noAuth).providerId,
    "anthropic",
  );
  const configured = run("console.log(JSON.stringify(getModelSelectionState()))", {
    ...noAuth,
    BETTER_REVIEW_MODEL: "openai-codex/gpt-5.5",
  });
  assert.equal(configured.providerId, "openai-codex");
  assert.equal(configured.modelId, "gpt-5.5");
  assert.equal(configured.selectionSource, "default");
});
