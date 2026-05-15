import assert from "node:assert/strict";
import { test } from "node:test";

import { extractGitHubAssetId, isGitHubAssetId, toGitHubAssetProxyPath } from "./github-asset";

test("accepts valid GitHub asset ids", () => {
  const assetId = "12345678-1234-1234-1234-123456789abc";

  assert.equal(isGitHubAssetId(assetId), true);
  assert.equal(toGitHubAssetProxyPath(assetId), `/api/github-asset/${assetId}`);
});

test("rejects traversal and malformed GitHub asset ids", () => {
  assert.equal(isGitHubAssetId("../../../notifications"), false);
  assert.equal(isGitHubAssetId("not-an-asset"), false);
  assert.equal(toGitHubAssetProxyPath("../../../notifications"), null);
});

test("extracts asset ids only from supported GitHub asset urls", () => {
  const assetId = "12345678-1234-1234-1234-123456789abc";

  assert.equal(
    extractGitHubAssetId(`https://github.com/user-attachments/assets/${assetId}`),
    assetId,
  );
  assert.equal(
    extractGitHubAssetId(`https://github.com/user-attachments/assets/${assetId}?raw=1`),
    assetId,
  );
  assert.equal(
    extractGitHubAssetId("https://github.com/user-attachments/assets/../../../notifications"),
    null,
  );
});
