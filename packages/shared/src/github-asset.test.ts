import { expect, test } from "bun:test";

import { extractGitHubAssetId, isGitHubAssetId, toGitHubAssetProxyPath } from "./github-asset";

test("accepts valid GitHub asset ids", () => {
  const assetId = "12345678-1234-1234-1234-123456789abc";

  expect(isGitHubAssetId(assetId)).toBe(true);
  expect(toGitHubAssetProxyPath(assetId)).toBe(`/api/github-asset/${assetId}`);
});

test("rejects traversal and malformed GitHub asset ids", () => {
  expect(isGitHubAssetId("../../../notifications")).toBe(false);
  expect(isGitHubAssetId("not-an-asset")).toBe(false);
  expect(toGitHubAssetProxyPath("../../../notifications")).toBeNull();
});

test("extracts asset ids only from supported GitHub asset urls", () => {
  const assetId = "12345678-1234-1234-1234-123456789abc";

  expect(extractGitHubAssetId(`https://github.com/user-attachments/assets/${assetId}`)).toBe(
    assetId,
  );
  expect(extractGitHubAssetId(`https://github.com/user-attachments/assets/${assetId}?raw=1`)).toBe(
    assetId,
  );
  expect(
    extractGitHubAssetId("https://github.com/user-attachments/assets/../../../notifications"),
  ).toBeNull();
});
