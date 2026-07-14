import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeMalformedInlineCode, parseMarkdown } from "./markdown";

test("sanitizes dangerous markdown html", () => {
  const html = parseMarkdown('![x" onerror="alert(1)](https://example.com/x.png)');

  assert.match(html, /<img/);
  assert.doesNotMatch(html, /\sonerror="/);
  assert.match(html, /alt="x&quot; onerror=&quot;alert\(1\)"/);
});

test("sanitizes raw html blocks", () => {
  const html = parseMarkdown('<img src="x" onerror="alert(1)"><script>alert(1)</script>');

  assert.match(html, /&lt;img src="x" onerror="alert\(1\)"&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("rewrites GitHub asset links through the local proxy", () => {
  const assetId = "12345678-1234-1234-1234-123456789abc";
  const html = parseMarkdown(
    `![attachment](https://github.com/user-attachments/assets/${assetId})`,
  );

  assert.match(html, new RegExp(`/api/github-asset/${assetId}`));
});

test("normalizes multiline inline code wrappers", () => {
  const markdown = ".\n\n`\nen-CA.json\n`\n\n.\n\n`\nfr-CA.json\n`";

  assert.equal(normalizeMalformedInlineCode(markdown), ".\n\n`en-CA.json`\n\n.\n\n`fr-CA.json`");
});

test("does not link issue references inside HTML entities", () => {
  const html = parseMarkdown("why isn't this linked? #39", {
    owner: "better-review",
    repo: "better-review",
  });

  assert.match(html, /why isn&#39;t this linked\?/);
  assert.doesNotMatch(html, /&<a[^>]+>#39<\/a>;/);
  assert.match(html, /href="https:\/\/github\.com\/better-review\/better-review\/issues\/39"/);
});
