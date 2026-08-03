import assert from "node:assert/strict";
import { test } from "node:test";

import { parseReviewTokens } from "./parseReviewTokens";

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
