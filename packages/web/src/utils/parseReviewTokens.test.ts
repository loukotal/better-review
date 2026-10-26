import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractAnnotations,
  extractReviewOrder,
  hasReviewTokens,
  parseReviewTokens,
} from "./parseReviewTokens";

test("parses error severity annotations", () => {
  const parsed = parseReviewTokens(
    '<<ANNOTATION file="migrations/sqls/example.sql" line="1" severity="error">>Seed missing template rows<</ANNOTATION>>',
  );

  assert.equal(parsed.annotations.length, 1);
  assert.equal(parsed.annotations[0].severity, "error");
  assert.equal(parsed.annotations[0].file, "migrations/sqls/example.sql");
  assert.equal(parsed.annotations[0].line, 1);
  assert.equal(parsed.segments[0].type, "annotation");
});

test("renders note annotations as informational annotations", () => {
  const parsed = parseReviewTokens(
    '<<ANNOTATION file="src/example.ts" line="12" severity="note">>Useful context<</ANNOTATION>>',
  );

  assert.equal(parsed.annotations.length, 1);
  assert.equal(parsed.annotations[0].severity, "info");
  assert.equal(parsed.segments[0].type, "annotation");
});

test("multiple tokens retain their own values under fixed clocks and randomness without consuming literal markers", (t) => {
  t.mock.method(Date, "now", () => 123);
  t.mock.method(Math, "random", () => 0.25);
  const content =
    '__ANNOTATION_literal__ __REVIEW_TOKEN_0__ <<REVIEW_ORDER>>["first.ts"]<</REVIEW_ORDER>><<REVIEW_ORDER>>["second.ts"]<</REVIEW_ORDER>> [[file:first.ts:007]] [[file:second.ts:8]]';
  const parsed = parseReviewTokens(content);
  assert.deepEqual(parsed.segments, [
    { type: "text", content: "__ANNOTATION_literal__ __REVIEW_TOKEN_0__ " },
    { type: "review-order", files: ["first.ts"] },
    { type: "review-order", files: ["second.ts"] },
    { type: "text", content: " " },
    { type: "file-ref", file: "first.ts", line: 7 },
    { type: "text", content: " " },
    { type: "file-ref", file: "second.ts", line: 8 },
  ]);
  assert.deepEqual(parsed.reviewOrder, ["second.ts"]);
  assert.deepEqual(extractReviewOrder(content), ["first.ts"]);
  assert.deepEqual(parseReviewTokens(content), parsed);
});

test("annotation identity uses trimmed raw body, normalized severity and leading line only", (t) => {
  t.mock.method(Date, "now", () => 123);
  t.mock.method(Math, "random", () => 0.25);
  const note =
    '<<ANNOTATION file="src/a.ts" line="15-16" severity="note">>  See **[[file:src/b.ts:007]]**  <</ANNOTATION>>';
  const info = note.replace("15-16", "15").replace('severity="note"', 'severity="info"');
  const expected = {
    id: "annotation-pe54lx",
    file: "src/a.ts",
    line: 15,
    severity: "info",
    message: "See **[[file:src/b.ts:007]]**",
  };
  assert.deepEqual(parseReviewTokens(note + info + note).annotations, [
    expected,
    expected,
    expected,
  ]);
  assert.deepEqual(parseReviewTokens(note + info + note).segments, [
    { type: "annotation", annotation: expected },
    { type: "annotation", annotation: expected },
    { type: "annotation", annotation: expected },
  ]);
  assert.deepEqual(parseReviewTokens(note.replace("15-16", "015-16")).annotations, [expected]);
  const malformed =
    '<<ANNOTATION file="src/fallback.ts" line="oops15" severity="warning">> Keep input <</ANNOTATION>>';
  assert.equal(parseReviewTokens(malformed).annotations[0].line, 1);
  assert.equal(parseReviewTokens(malformed).annotations[0].id, "annotation-22h0c0");
  assert.deepEqual(extractAnnotations(note + info), [expected, expected]);
});

test("token detection does not alternate after repeated calls", () => {
  for (const content of [
    "<<REVIEW_ORDER>>[]<</REVIEW_ORDER>>",
    '<<ANNOTATION file="x" line="1" severity="info">>x<</ANNOTATION>>',
    "[[file:x]]",
  ]) {
    assert.equal(hasReviewTokens(content), true);
    assert.equal(hasReviewTokens(content), true);
  }
  assert.equal(hasReviewTokens("plain text"), false);
});

test("an order inside an annotation cannot leak a placeholder or contribute a token index to identity", () => {
  const content =
    '<<ANNOTATION file="a.ts" line="1" severity="info">>Before <<REVIEW_ORDER>>["a.ts"]<</REVIEW_ORDER>> after<</ANNOTATION>>';
  const expected = [
    {
      id: "annotation-jf1ik1",
      file: "a.ts",
      line: 1,
      severity: "info",
      message: 'Before <<REVIEW_ORDER>>["a.ts"]<</REVIEW_ORDER>> after',
    },
  ];
  assert.deepEqual(parseReviewTokens(content).annotations, expected);
  assert.deepEqual(
    parseReviewTokens('<<REVIEW_ORDER>>["prior.ts"]<</REVIEW_ORDER>>' + content).annotations,
    expected,
  );
  assert.deepEqual(extractAnnotations(content), expected);
});
