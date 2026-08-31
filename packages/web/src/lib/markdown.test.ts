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

test("adds restrained semantic highlighting to text call stacks", () => {
  const html = parseMarkdown(`\`\`\`text
Admin UI: Copy to clipboard
  -> admin.onBehalfReporting.getTsv({ reportId })
    -> onBehalfReportingTsvService.generate()
      -> list run records
\`\`\``);

  assert.match(html, /<pre class="markdown-flow">/);
  assert.match(html, /class="markdown-flow-arrow">-&gt;<\/span>/);
  assert.match(html, /class="markdown-flow-call">admin\.onBehalfReporting\.getTsv<\/span>/);
  assert.match(html, /class="markdown-flow-call">onBehalfReportingTsvService\.generate<\/span>/);
});

test("leaves ordinary text code blocks unaccented", () => {
  const html = parseMarkdown("```text\nfirst line\nsecond line\n```");

  assert.doesNotMatch(html, /markdown-flow/);
  assert.match(html, /<pre><code class="markdown-code-block language-text">/);
});

test("highlights added lines in plain-text tree diagrams", () => {
  const html = parseMarkdown(`\`\`\`text
db/
 └── pms.users_residency.sql
+    # expose deposit configuration
\`\`\``);

  assert.match(html, /markdown-flow-add/);
  assert.match(html, /\+    # expose deposit configuration/);
});

test("highlights inline code beginning with an added-line marker", () => {
  const html = parseMarkdown("`+    # expose deposit configuration`");

  assert.match(html, /<code class="markdown-inline-add">/);
});

test("highlights added lines in diff tree code blocks", () => {
  const html = parseMarkdown(`\`\`\`diff
 functions/src/
 ├── one-time-payments/
+│   # persist propertyUnitId
\`\`\``);

  assert.match(html, /<pre class="markdown-diff-tree">/);
  assert.match(html, /<span class="markdown-flow-line markdown-flow-add">/);
});

test("renders mermaid code blocks as themed SVG diagrams", () => {
  const html = parseMarkdown("```mermaid\ngraph LR\n  A[Plan] --> B[Review]\n```");

  assert.match(html, /<figure class="mermaid-diagram">/);
  assert.match(html, /<svg[^>]+/);
  assert.match(html, /var\(--color-accent-bright\)/);
  assert.doesNotMatch(html, /language-mermaid/);
});

test("falls back to escaped code for unsupported mermaid", () => {
  const html = parseMarkdown("```mermaid\nthis is not a diagram\n```");

  assert.match(html, /<pre><code class="markdown-code-block language-mermaid">/);
  assert.match(html, /this is not a diagram/);
});
