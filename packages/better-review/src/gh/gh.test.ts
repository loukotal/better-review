import assert from "node:assert/strict";
import { test } from "node:test";

import { isDiffCommentTargetInPatch, parseFullDiff } from "../diff";
import { buildUnifiedDiffFromPullFiles, isPullRequestDiffTooLarge } from "./gh";

test("builds a unified diff from pull request file API patches", () => {
  const diff = buildUnifiedDiffFromPullFiles([
    {
      filename: "src/example.ts",
      status: "modified",
      patch: "@@ -1 +1,2 @@\n-const before = true;\n+const before = true;\n+const after = true;",
    },
    {
      filename: "src/new-file.ts",
      status: "added",
      patch: "@@ -0,0 +1 @@\n+export const value = 1;",
    },
    {
      filename: "src/new-name.ts",
      previous_filename: "src/old-name.ts",
      status: "renamed",
      patch: "@@ -1 +1 @@\n-export const oldName = true;\n+export const newName = true;",
    },
  ]);

  assert.equal(
    diff,
    `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1,2 @@
-const before = true;
+const before = true;
+const after = true;
diff --git a/src/new-file.ts b/src/new-file.ts
--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1 @@
+export const value = 1;
diff --git a/src/old-name.ts b/src/new-name.ts
rename from src/old-name.ts
rename to src/new-name.ts
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1 +1 @@
-export const oldName = true;
+export const newName = true;`,
  );

  const fileDiffs = parseFullDiff(diff);
  assert.equal(fileDiffs.size, 3);
  assert.equal(fileDiffs.get("src/example.ts")?.totalAdded, 2);
  assert.equal(fileDiffs.get("src/example.ts")?.totalRemoved, 1);
  assert.equal(fileDiffs.get("src/new-file.ts")?.totalAdded, 1);
  assert.ok(fileDiffs.get("src/new-name.ts"));
});

test("builds headers for pull request files without patch text", () => {
  const diff = buildUnifiedDiffFromPullFiles([
    {
      filename: "assets/logo.png",
      status: "modified",
      patch: null,
    },
    {
      filename: "src/deleted.ts",
      status: "removed",
    },
  ]);

  assert.equal(
    diff,
    `diff --git a/assets/logo.png b/assets/logo.png
--- a/assets/logo.png
+++ b/assets/logo.png
diff --git a/src/deleted.ts b/src/deleted.ts
--- a/src/deleted.ts
+++ /dev/null`,
  );

  const fileDiffs = parseFullDiff(diff);
  assert.equal(fileDiffs.size, 2);
  assert.equal(fileDiffs.get("assets/logo.png")?.hunks.length, 0);
  assert.equal(fileDiffs.get("src/deleted.ts")?.hunks.length, 0);
});

test("detects review comment targets outside the parsed patch hunks", () => {
  const fileDiffs = parseFullDiff(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,3 +10,4 @@
 const before = true;
-const oldValue = 1;
+const newValue = 1;
+const after = true;
 const done = true;`);
  const fileDiff = fileDiffs.get("src/example.ts");

  assert.ok(fileDiff);
  assert.equal(
    isDiffCommentTargetInPatch(fileDiff, { line: 13, side: "RIGHT", startLine: 10 }),
    true,
  );
  assert.equal(isDiffCommentTargetInPatch(fileDiff, { line: 50, side: "RIGHT" }), false);
  assert.equal(isDiffCommentTargetInPatch(fileDiff, { line: 13, side: "LEFT" }), false);
});

test("detects too-large PR diff errors through nested causes", () => {
  const nested = new Error("An unknown error occurred in Effect.tryPromise", {
    cause: new Error(
      "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300).\nPullRequest.diff too_large",
    ),
  });

  assert.equal(isPullRequestDiffTooLarge(nested), true);
  assert.equal(isPullRequestDiffTooLarge(new Error("HTTP 500")), false);
});
