import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("registers the PR reviewer on the Flue HTTP transport", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "better-review-flue-runtime-test-"));
  const betaDatabasePath = path.join(directory, "flue.sqlite");
  const v2DatabasePath = path.join(directory, "flue-v2.sqlite");
  await writeFile(betaDatabasePath, "retained beta database");
  process.env.BETTER_REVIEW_FLUE_V2_DB_PATH = v2DatabasePath;
  const { createFlueReviewApp, startFlueReviewRuntime, stopFlueReviewRuntime } =
    await import("./runtime");

  await startFlueReviewRuntime();
  const response = await createFlueReviewApp().request(
    "http://localhost/agents/pr-reviewer/missing-session",
  );
  await stopFlueReviewRuntime();

  assert.equal(response.status, 404);
  assert.equal(await readFile(betaDatabasePath, "utf8"), "retained beta database");
  assert.notEqual((await readFile(v2DatabasePath)).byteLength, 0);
});
