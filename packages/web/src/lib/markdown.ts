import { marked } from "marked";

// Configure marked defaults
marked.setOptions({
  gfm: true,
  breaks: true,
});

// GitHub reference patterns
const GITHUB_USER_MENTION = /@([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)/g;
const GITHUB_ISSUE_REF = /#(\d+)/g;
const GITHUB_CROSS_REPO_REF = /([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)#(\d+)/g;
const GITHUB_COMMIT_SHA = /\b([a-f0-9]{7,40})\b/g;

interface GitHubContext {
  owner: string;
  repo: string;
}

// Process GitHub-specific references in text
function processGitHubRefs(html: string, ctx: GitHubContext | null): string {
  const baseUrl = "https://github.com";

  // Process cross-repo references first (before simple #123 refs)
  html = html.replace(GITHUB_CROSS_REPO_REF, (match, repo, number) => {
    return `<a href="${baseUrl}/${repo}/issues/${number}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">${match}</a>`;
  });

  // Process @mentions
  html = html.replace(GITHUB_USER_MENTION, (_match, username) => {
    // Don't process if already inside a link
    return `<a href="${baseUrl}/${username}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">@${username}</a>`;
  });

  // Process #123 issue refs (only with context)
  if (ctx) {
    html = html.replace(GITHUB_ISSUE_REF, (_match, number) => {
      return `<a href="${baseUrl}/${ctx.owner}/${ctx.repo}/issues/${number}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">#${number}</a>`;
    });

    // Process commit SHAs (only with context)
    html = html.replace(GITHUB_COMMIT_SHA, (match, sha) => {
      // Only process if it looks like a commit SHA (hex chars only, reasonable length)
      if (sha.length >= 7 && sha.length <= 40) {
        const shortSha = sha.slice(0, 7);
        return `<a href="${baseUrl}/${ctx.owner}/${ctx.repo}/commit/${sha}" target="_blank" rel="noopener noreferrer" class="font-mono text-accent hover:underline">${shortSha}</a>`;
      }
      return match;
    });
  }

  return html;
}

// Parse markdown with GitHub extensions
export function parseMarkdown(text: string, context?: GitHubContext | null): string {
  // First parse with marked
  let html = marked.parse(text, { async: false }) as string;

  // Then process GitHub-specific references
  html = processGitHubRefs(html, context ?? null);

  return html;
}

// Re-export marked for cases where we don't need GitHub extensions
export { marked };
