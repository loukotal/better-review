import assert from "node:assert/strict";
import test from "node:test";

import { parsePatchFiles } from "@pierre/diffs";

import {
  analyzeReadingDiff,
  abridgeReadingDiff,
  applyReadingDiffPlan,
  numberedDiff,
  readingDiffCacheKey,
  renderReadingDiffReportMarkdown,
  type ReadingDiffReport,
  type ReadingDiffPlan,
} from "./reading-diff";

const report: ReadingDiffReport = {
  overview: "The run path prepares, audits, records, and returns a value.",
  flows: [
    {
      title: "Run input",
      confidence: "high",
      steps: [
        {
          kind: "entry",
          label: "run(input)",
          evidence: { file: "src/example.ts", line: 3 },
          confidence: "high",
          inferred: false,
        },
        {
          kind: "side_effect",
          label: "audit and record",
          confidence: "high",
          inferred: false,
        },
      ],
    },
  ],
  blastRadius: [
    {
      area: "run callers",
      impact: "They receive the prepared value after audit and record side effects.",
      risk: "medium",
      evidence: [{ file: "src/example.ts", line: 3 }],
    },
  ],
  reviewFocus: [
    {
      severity: "high",
      title: "Side-effect ordering",
      rationale: "Audit and record must complete before returning.",
      evidence: [{ file: "src/example.ts", line: 6 }],
    },
  ],
  unknowns: ["Whether audit or record can fail."],
};

const fixture = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,4 +1,7 @@",
  '-import { oldHelper } from "./old";',
  '+import { newHelper } from "./new";',
  " export function run(input: string) {",
  "-  return oldHelper(input);",
  "+  const prepared = newHelper(input);",
  "+  audit(prepared);",
  "+  record(prepared);",
  "+  return prepared;",
  " }",
  "",
].join("\n");

function lineNumber(diff: string, line: string): number {
  const index = diff.split("\n").indexOf(line);
  assert.notEqual(index, -1, `fixture line not found: ${line}`);
  return index + 1;
}

test("applyReadingDiffPlan removes imports and folds source-derived repetition", () => {
  const foldStart = lineNumber(fixture, "+  audit(prepared);");
  const result = applyReadingDiffPlan(fixture, {
    remove: [],
    fold: [{ startLine: foldStart, endLine: foldStart + 1 }],
    summary: "Uses the new helper and records the prepared value.",
    report,
  });

  assert.doesNotMatch(result, /oldHelper.*old/);
  assert.doesNotMatch(result, /newHelper.*new/);
  assert.match(result, /\+  const prepared = newHelper\(input\);/);
  assert.match(result, /\+  \.\.\./);
  assert.match(result, /\+  return prepared;/);
  assert.equal(parsePatchFiles(result).flatMap((patch) => patch.files).length, 1);
});

test("applyReadingDiffPlan refuses edits to diff metadata", () => {
  assert.throws(
    () =>
      applyReadingDiffPlan(fixture, {
        remove: [{ startLine: 1, endLine: 1 }],
        fold: [],
        summary: "Invalid plan.",
        report,
      }),
    /includes diff metadata/,
  );
});

test("applyReadingDiffPlan preserves metadata when a removal crosses hunk boundaries", () => {
  const diff = [
    "diff --git a/src/example.ts b/src/example.ts",
    "index 1111111..2222222 100644",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1,2 +1,2 @@",
    "-const first = oldValue;",
    "+const first = newValue;",
    " export const anchor = first;",
    "@@ -10,2 +10,2 @@",
    "-const second = oldValue;",
    "+const second = newValue;",
    " export const other = second;",
    "",
  ].join("\n");
  const firstChangedLine = lineNumber(diff, "-const first = oldValue;");
  const lastChangedLine = lineNumber(diff, "+const second = newValue;");

  const result = applyReadingDiffPlan(diff, {
    remove: [{ startLine: firstChangedLine, endLine: lastChangedLine }],
    fold: [],
    summary: "Removes repetitive changes across both hunks.",
    report,
  });

  assert.match(result, /^@@ -1,2 \+1,2 @@$/m);
  assert.match(result, /^@@ -10,2 \+10,2 @@$/m);
  assert.doesNotMatch(result, /oldValue|newValue/);
  assert.equal(parsePatchFiles(result).flatMap((patch) => patch.files).length, 1);
});

test("applyReadingDiffPlan splits folds at markers and hunk boundaries", () => {
  const diff = [
    "diff --git a/src/example.ts b/src/example.ts",
    "index 1111111..2222222 100644",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1,1 +1,3 @@",
    "+const first = value;",
    "+const second = value;",
    " export const anchor = value;",
    "@@ -10,1 +12,3 @@",
    "+const third = value;",
    "+const fourth = value;",
    " export const other = value;",
    "",
  ].join("\n");

  const result = applyReadingDiffPlan(diff, {
    remove: [],
    fold: [
      {
        startLine: lineNumber(diff, "+const first = value;"),
        endLine: lineNumber(diff, "+const fourth = value;"),
      },
    ],
    summary: "Folds repetitive additions across both hunks.",
    report,
  });

  assert.match(result, /^@@ -1,1 \+1,3 @@$/m);
  assert.match(result, /^@@ -10,1 \+12,3 @@$/m);
  assert.equal(result.match(/^\+\.\.\.$/gm)?.length, 2);
  assert.doesNotMatch(result, /const (?:first|second|third|fourth)/);
  assert.equal(parsePatchFiles(result).flatMap((patch) => patch.files).length, 1);
});

test("applyReadingDiffPlan keeps a fixed placeholder when a hunk is fully removed", () => {
  const firstSourceLine = lineNumber(fixture, '-import { oldHelper } from "./old";');
  const lastSourceLine = lineNumber(fixture, " }");
  const result = applyReadingDiffPlan(fixture, {
    remove: [{ startLine: firstSourceLine, endLine: lastSourceLine }],
    fold: [],
    summary: "Only mechanical changes remain.",
    report,
  });

  assert.match(result, /^[-+ ]\.\.\.$/m);
  assert.equal(parsePatchFiles(result).flatMap((patch) => patch.files).length, 1);
});

test("abridgeReadingDiff applies an injected plan and reports compression", async () => {
  const auditLine = lineNumber(fixture, "+  audit(prepared);");
  const plan: ReadingDiffPlan = {
    remove: [{ startLine: auditLine, endLine: auditLine }],
    fold: [],
    summary: "Uses a new helper before returning the prepared value.",
    report,
  };
  let received = "";

  const result = await abridgeReadingDiff(fixture, async (numbered) => {
    received = numbered;
    return plan;
  });

  assert.match(received, new RegExp(`^${auditLine}\\|\\+  audit`, "m"));
  assert.equal(result.summary, plan.summary);
  assert.deepEqual(result.report, report);
  assert.match(result.reportMarkdown, /## Program design/);
  assert.ok(result.stats.originalChangedLines > result.stats.readingChangedLines);
  assert.ok(result.stats.compressionPercent > 0);
});

test("analyzeReadingDiff preserves the original diff while returning intelligence", async () => {
  const result = await analyzeReadingDiff(fixture, async () => ({
    remove: [{ startLine: 6, endLine: 6 }],
    fold: [{ startLine: 9, endLine: 10 }],
    summary: "The run path changes.",
    report,
  }));

  assert.equal(result.smartDiff, fixture);
  assert.equal(result.stats.readingChangedLines, result.stats.originalChangedLines);
  assert.equal(result.stats.compressionPercent, 0);
  assert.equal(result.report, report);
});

test("renderReadingDiffReportMarkdown emits stable report sections and evidence", () => {
  const markdown = renderReadingDiffReportMarkdown(report);
  assert.match(markdown, /^## Overview/m);
  assert.match(markdown, /^## Program design/m);
  assert.match(markdown, /^## Blast radius/m);
  assert.match(markdown, /^## Review focus/m);
  assert.match(markdown, /^## Unknowns/m);
  assert.match(markdown, /`src\/example\.ts:3`/);
});

test("readingDiffCacheKey includes the diff and selected model identity", () => {
  const base = readingDiffCacheKey(fixture, "openai/gpt-5.5");
  assert.equal(base, readingDiffCacheKey(fixture, "openai/gpt-5.5"));
  assert.notEqual(base, readingDiffCacheKey(`${fixture}\n`, "openai/gpt-5.5"));
  assert.notEqual(base, readingDiffCacheKey(fixture, "anthropic/claude-sonnet-4-6"));
});

test("numberedDiff uses immutable one-based physical line coordinates", () => {
  assert.equal(numberedDiff("first\nsecond"), "1|first\n2|second");
});
