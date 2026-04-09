const GITHUB_ASSET_ID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

const GITHUB_ASSET_URL_PATTERN =
  /^https?:\/\/github\.com\/user-attachments\/assets\/([a-f0-9-]+)(?:[/?#].*)?$/i;

export function isGitHubAssetId(value: string): boolean {
  return GITHUB_ASSET_ID_PATTERN.test(value.trim());
}

export function extractGitHubAssetId(url: string): string | null {
  const match = url.trim().match(GITHUB_ASSET_URL_PATTERN);
  if (!match) return null;

  return isGitHubAssetId(match[1]) ? match[1] : null;
}

export function toGitHubAssetProxyPath(assetId: string): string | null {
  if (!isGitHubAssetId(assetId)) return null;
  return `/api/github-asset/${assetId}`;
}
