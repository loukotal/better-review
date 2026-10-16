import assert from "node:assert/strict";
import test from "node:test";

import { parseChatFileReference } from "./chat-file-reference";
import { resolveFileReference } from "./file-reference";

const files = ["src/user-rent.ts", "src/index.ts", "tests/index.ts", "README.md"];
test("chat markdown/code references preserve path and first source line for colon and GitHub fragments", () => {
  for (const source of [
    "src/user-rent.ts:457",
    "src/user-rent.ts#L457-L459",
    "src/user-rent.ts:457–459",
  ])
    assert.deepEqual(parseChatFileReference(source, files), {
      file: "src/user-rent.ts",
      line: 457,
    });
  assert.deepEqual(parseChatFileReference("user-rent.ts:161", files, true), {
    file: "user-rent.ts",
    line: 161,
  });
  assert.equal(parseChatFileReference("user.id", files, true), null);
  assert.deepEqual(parseChatFileReference("user-rent-config.ts", [], true), {
    file: "user-rent-config.ts",
  });
  assert.equal(parseChatFileReference("https://example.com/src/a.ts", files), null);
  assert.equal(parseChatFileReference("mailto:person.ts", files), null);
  assert.equal(parseChatFileReference("javascript:evil.ts", files), null);
});
test("ambiguous basenames remain actionable but never resolve silently to a guessed file", () => {
  const target = parseChatFileReference("index.ts:10", files, true)!;
  assert.equal(target.file, "index.ts");
  assert.equal(resolveFileReference(target.file, files), null);
  assert.equal(
    resolveFileReference(parseChatFileReference("../bad.ts:10", files)!.file, files),
    null,
  );
});
