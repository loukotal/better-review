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
    ...process.env,
    OPENAI_API_KEY: "",
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
