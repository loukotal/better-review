import { expect, test } from "bun:test";

import { parseMarkdown } from "./markdown";

test("sanitizes dangerous markdown html", () => {
  const html = parseMarkdown('![x" onerror="alert(1)](https://example.com/x.png)');

  expect(html).toContain("<img");
  expect(html).not.toMatch(/\sonerror="/);
  expect(html).toContain('alt="x&quot; onerror=&quot;alert(1)"');
});

test("sanitizes raw html blocks", () => {
  const html = parseMarkdown('<img src="x" onerror="alert(1)"><script>alert(1)</script>');

  expect(html).toContain('&lt;img src="x" onerror="alert(1)"&gt;');
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>");
});

test("rewrites GitHub asset links through the local proxy", () => {
  const assetId = "12345678-1234-1234-1234-123456789abc";
  const html = parseMarkdown(
    `![attachment](https://github.com/user-attachments/assets/${assetId})`,
  );

  expect(html).toContain(`/api/github-asset/${assetId}`);
});
