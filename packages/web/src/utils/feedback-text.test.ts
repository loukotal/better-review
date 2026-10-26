import assert from "node:assert/strict";
import test from "node:test";

import { buildFeedbackText } from "./feedback-text";
import { parseReviewTokens } from "./parseReviewTokens";

const note =
  '<<ANNOTATION file="src/a.ts" line="15-16" severity="note">>  See **[[file:src/b.ts:007]]**  <</ANNOTATION>>';
const info =
  '<<ANNOTATION file="src/a.ts" line="15" severity="info">>  See **[[file:src/b.ts:007]]**  <</ANNOTATION>>';
const fallback =
  '<<ANNOTATION file="src/fallback.ts" line="n/a" severity="warning">> Keep input <</ANNOTATION>>';
const active = new Set(["annotation-pe54lx", "annotation-22h0c0"]);
const assistant = (content: string) => ({ role: "assistant", content });

test("feedback preserves prose, original NOTE label, normalized identity and raw reference line spelling", () => {
  const content = `  Intro **[[file:src/main.ts:007]]**.\n\n<<REVIEW_ORDER>>\n\`\`\`json\n["src/b.ts", "src/a.ts"]\n\`\`\`\n<</REVIEW_ORDER>>\n\n${note}\n${info}\n\n${fallback}\n\nOutro [[file:README.md]]  `;
  assert.equal(
    buildFeedbackText([assistant(content)], active),
    "Intro src/main.ts:007.\n\n[NOTE] src/a.ts:15 - See src/b.ts:007\n[INFO] src/a.ts:15 - See src/b.ts:007\n\n[WARNING] src/fallback.ts:1 - Keep input\n\nOutro README.md",
  );
  assert.equal(
    buildFeedbackText([assistant(content)], new Set()),
    "Intro src/main.ts:007.\n\nOutro README.md",
  );
  assert.deepEqual(
    parseReviewTokens(content).annotations.map(({ id, line, severity }) => ({
      id,
      line,
      severity,
    })),
    [
      { id: "annotation-pe54lx", line: 15, severity: "info" },
      { id: "annotation-pe54lx", line: 15, severity: "info" },
      { id: "annotation-22h0c0", line: 1, severity: "warning" },
    ],
  );
});

test("feedback strips every complete order block even when rendering retains malformed payloads", () => {
  for (const payload of [
    '["a.ts"]',
    '```JSON\n["a.ts"]\n```',
    "not json",
    "```json\n[broken\n```",
    '{"file":"a.ts"}',
  ]) {
    const block = `<<REVIEW_ORDER>>${payload}<</REVIEW_ORDER>>`;
    assert.equal(buildFeedbackText([assistant(`Before ${block} after`)], active), "Before  after");
    const rendered = parseReviewTokens(block);
    if (payload.includes('["a.ts"]')) {
      assert.deepEqual(rendered.segments, [{ type: "review-order", files: ["a.ts"] }]);
    } else {
      assert.deepEqual(rendered.segments, [{ type: "text", content: block }]);
    }
  }
});

test("incomplete and unrecognized markers remain literal in feedback", () => {
  for (const content of [
    'A <<REVIEW_ORDER>>["x"] B',
    '<<ANNOTATION file="x" line="1" severity="info">>unfinished',
    '<<ANNOTATION file="x" line="1" severity="NOTE">>literal<</ANNOTATION>>',
  ])
    assert.equal(buildFeedbackText([assistant(content)], active), content);
  // The first recognized opener consumes the next closer, even across another opener.
  assert.equal(
    buildFeedbackText(
      [
        assistant(
          'Before <<ANNOTATION file="x" line="1" severity="info">>unfinished\n<<ANNOTATION file="x" line="1" severity="NOTE">>literal<</ANNOTATION>> after',
        ),
      ],
      active,
    ),
    "Before  after",
  );
});

test("feedback preserves repeated tokens, message order and exact assistant separator", () => {
  assert.equal(
    buildFeedbackText(
      [
        { role: "user", content: "Never export me" },
        assistant(` ${note}\n${note} `),
        { role: "system", content: "Never export system" },
        assistant(" \n\t "),
        assistant('<<REVIEW_ORDER>>["empty-export.ts"]<</REVIEW_ORDER>>'),
        assistant(" Last \n\n\n\n paragraph "),
      ],
      active,
    ),
    "[NOTE] src/a.ts:15 - See src/b.ts:007\n[NOTE] src/a.ts:15 - See src/b.ts:007\n\n---\n\nLast \n\n paragraph",
  );
});

test("file references lose optional bold wrappers but keep optional raw line digits", () => {
  assert.equal(
    buildFeedbackText(
      [assistant("**[[file:a:001]]** *[[file:b:02]]* [[file:c]] [[file:bad name:3]]")],
      active,
    ),
    "a:001 b:02 c [[file:bad name:3]]",
  );
});

test("removing dismissed blocks keeps surrounding prose and trims/collapses only specified whitespace", () => {
  assert.equal(
    buildFeedbackText(
      [assistant(`  Before\n\n\n${note}\n\n\n\nAfter  `), assistant(note)],
      new Set(),
    ),
    "Before\n\nAfter",
  );
  assert.equal(
    buildFeedbackText([assistant("\n\n\n"), { role: "user", content: note }], active),
    "",
  );
});
