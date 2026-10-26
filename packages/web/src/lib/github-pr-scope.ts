import { isGithubPrScope, type GithubPrScope } from "@better-review/shared";

export function githubPrScope(url: string): GithubPrScope {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || !match)
    throw new Error("Invalid GitHub PR URL");
  const owner = match[1]!.toLowerCase(),
    repo = match[2]!.toLowerCase(),
    number = Number(match[3]);
  const scope: GithubPrScope = {
    host: "github.com",
    owner,
    repo,
    number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
  if (!isGithubPrScope(scope)) throw new Error("Invalid GitHub PR scope");
  return scope;
}
